import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import readline from "node:readline";
import type { Artifact, ElementDescriptor, ObservedElement, Snapshot, Step } from "./types.js";
import { Artifact as ArtifactSchema } from "./types.js";
import { PlaywrightSurface, cleanStructuralPaths, needsStructuralFallback } from "./surface.js";
import { actionAllowed, isRiskyName, originAllowed, redact, redactSnapshot, type Policy } from "./policy.js";
import { RunLogger } from "./logger.js";
import { substitute as substituteText, templatize as templatizeText, type ParamValues } from "./templating.js";
import { replayArtifact } from "./replay.js";
import { requestIntervention } from "./escalate.js";

// ---------------------------------------------------------------------------
// Discovery: an LLM-driven observe -> decide -> act loop against the live
// surface. Every executed action is simultaneously recorded as a replayable
// step with a semantic element descriptor. The model transcript is evidence;
// the artifact is decoupled from it.
//
// Redaction invariant: values of params marked sensitive never enter model
// context, logs, or the artifact. The model is told to type the literal
// template "{{param}}"; substitution happens in the executor.
// ---------------------------------------------------------------------------

export interface DiscoveryInput {
  goal: string;
  entryUrl: string;
  appLabel: string;
  params: { name: string; value: string; description: string; sensitive: boolean }[];
  policy: Policy;
  maxSteps: number;
  model: string;
  headful: boolean;
  // Skip the negative-path probe (see probeNegativePath).
  skipProbe?: boolean;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL (must be within the allowed origins).",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        intent: { type: "string", description: "One line: why this action serves the goal." },
      },
      required: ["url", "intent"],
    },
  },
  {
    name: "click",
    description: "Click an element by its bracketed id from the observation.",
    input_schema: {
      type: "object",
      properties: { element: { type: "string" }, intent: { type: "string" } },
      required: ["element", "intent"],
    },
  },
  {
    name: "type",
    description:
      "Clear a textbox and type text into it. For sensitive params, type the literal placeholder {{param_name}} — never the real value.",
    input_schema: {
      type: "object",
      properties: {
        element: { type: "string" },
        text: { type: "string" },
        intent: { type: "string" },
      },
      required: ["element", "text", "intent"],
    },
  },
  {
    name: "select",
    description: "Choose an option (by visible label) in a select element.",
    input_schema: {
      type: "object",
      properties: {
        element: { type: "string" },
        option: { type: "string" },
        intent: { type: "string" },
      },
      required: ["element", "option", "intent"],
    },
  },
  {
    name: "extract",
    description:
      "Extract data from the page and store it as a named output of this capability. Give a stable literal label visible on the page (e.g. 'Savings' or 'Reference number:') as the anchor; the cells following it are read. The result shows each cell with its index — call extract again with cell_index to narrow to one cell if needed.",
    input_schema: {
      type: "object",
      properties: {
        anchor: { type: "string", description: "Exact literal label text to anchor on. Must be static UI text, not data." },
        cell_index: { type: "number", description: "Optional: index of the single cell to keep." },
        output_name: { type: "string", description: "snake_case output name" },
        output_description: { type: "string" },
        intent: { type: "string" },
      },
      required: ["anchor", "output_name", "output_description", "intent"],
    },
  },
  {
    name: "finish",
    description:
      "Declare the goal complete. Provide a success condition that is verifiably true on the CURRENT page — it becomes the replay checkpoint.",
    input_schema: {
      type: "object",
      properties: {
        capability_name: { type: "string", description: "snake_case callable name" },
        capability_description: { type: "string" },
        success_text_visible: {
          type: "string",
          description: "A short text fragment visible on the final page that proves success. Must not contain run-specific values; if it must reference a param, use {{param_name}}.",
        },
        success_url_contains: { type: "string" },
      },
      required: ["capability_name", "capability_description"],
    },
  },
  {
    name: "give_up",
    description: "You are stuck and cannot safely proceed. A human operator will be asked to intervene.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

function formatSnapshot(snap: Snapshot): string {
  const lines = snap.elements.map((el) => {
    let line = `[${el.cuaId}] ${el.role} "${el.name}"`;
    if (el.nearText) line += ` (near: "${el.nearText}")`;
    if (el.value) line += ` value="${el.value}"`;
    if (el.options) line += ` options=[${el.options.join(", ")}]`;
    return line;
  });
  return [
    `URL: ${snap.url}`,
    `TITLE: ${snap.title}`,
    `PAGE TEXT (trimmed): ${snap.visibleText.slice(0, 1500)}`,
    `INTERACTIVE ELEMENTS:`,
    ...lines,
  ].join("\n");
}

export async function runDiscovery(input: DiscoveryInput): Promise<{ artifact: Artifact | null; evidenceDir: string }> {
  const log = new RunLogger("discovery");
  const anthropic = new Anthropic();
  const surface = await PlaywrightSurface.launch({ headful: input.headful });

  const sensitiveValues = input.params.filter((p) => p.sensitive).map((p) => p.value);
  const mask = input.policy.redaction.mask;

  // Templating lives in one shared module so the recorder's templatize and
  // the executor's substitute cannot drift apart (src/templating.ts).
  const paramValues: ParamValues = Object.fromEntries(input.params.map((p) => [p.name, p.value]));
  const templatize = (s: string) => templatizeText(s, paramValues);
  const substitute = (s: string) => substituteText(s, paramValues);

  const steps: Step[] = [];
  const outputs: Artifact["outputs"] = [];
  const extractedCells: string[] = [];
  let stepCounter = 0;

  const system = [
    "You are a computer-use agent operating a back-office business application on behalf of a bank teller workflow system.",
    "You will be given a goal and a live page observation. Work step by step: observe, decide, act — one tool call at a time.",
    "Rules:",
    `- Only operate within these origins: ${input.policy.allowedOrigins.join(", ")}.`,
    "- Prefer reading the page before acting. Use the smallest number of actions that achieves the goal.",
    "- When a goal mentions retrieving data, use the extract tool on the element that contains it.",
    "- Parameters are listed with your goal. When you need to enter a parameter into the UI, type its value (or its {{name}} placeholder if it is marked SENSITIVE).",
    "- If a page shows an error or unexpected state you cannot resolve, use give_up rather than guessing.",
    "- Call finish only when the goal is verifiably complete on the current page.",
  ].join("\n");

  const paramLines = input.params
    .map((p) =>
      p.sensitive
        ? `- ${p.name} (SENSITIVE — type the literal text {{${p.name}}}): ${p.description}`
        : `- ${p.name} = "${p.value}": ${p.description}`
    )
    .join("\n");

  log.event("discovery.start", {
    goal: input.goal,
    entryUrl: input.entryUrl,
    model: input.model,
    params: input.params.map((p) => ({ name: p.name, sensitive: p.sensitive })),
  });

  if (!originAllowed(input.policy, input.entryUrl)) {
    log.event("policy.blocked", { url: input.entryUrl });
    await surface.close();
    log.close();
    throw new Error(`Entry URL ${input.entryUrl} is not in the allowed origins.`);
  }

  await surface.navigate(input.entryUrl);
  steps.push({
    id: `s${stepCounter++}`,
    action: "navigate",
    url: templatize(input.entryUrl),
    intent: "Open the application entry point",
    timeoutMs: 10_000,
  });

  let snap = redactSnapshot(await surface.snapshot(), sensitiveValues, mask);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `GOAL: ${input.goal}\n\nPARAMETERS:\n${paramLines || "(none)"}\n\nCURRENT OBSERVATION:\n${formatSnapshot(snap)}`,
    },
  ];

  const elementByCuaId = () => new Map(snap.elements.map((el) => [el.cuaId, el]));

  const descriptorFor = (el: ObservedElement): ElementDescriptor => {
    // Compute nth among same role+name+nearText ties in the current snapshot.
    const ties = snap.elements.filter(
      (e) => e.role === el.role && e.name === el.name && e.nearText === el.nearText
    );
    const hadTies = ties.length > 1;
    const name = templatize(el.name);
    const nearText = el.nearText ? templatize(el.nearText) : undefined;

    const desc: ElementDescriptor = { role: el.role, name };
    if (nearText) desc.nearText = nearText;
    if (hadTies) desc.nth = ties.indexOf(el);
    // Structural path is the last-resort fallback; persist it only where the
    // perceptual identity is weak or was ambiguous at record time.
    if (needsStructuralFallback(name, nearText, hadTies)) desc.structuralPath = el.structuralPath;
    return desc;
  };

  let finishInfo: { name: string; description: string; textVisible?: string; urlContains?: string } | null = null;
  let gaveUp = false;

  for (let turn = 0; turn < input.maxSteps; turn++) {
    const response = await anthropic.messages.create({
      model: input.model,
      max_tokens: 1024,
      system,
      messages,
      tools: TOOLS,
      // One decision per turn: the loop answers exactly one tool_use, and a
      // discovery step should be observe -> act anyway.
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });

    messages.push({ role: "assistant", content: response.content });
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const thought = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (thought) log.event("model.thought", { text: redact(thought, sensitiveValues, mask) });

    if (!toolUse) {
      log.event("discovery.no_tool_call", {});
      break;
    }

    const args = toolUse.input as Record<string, string>;
    log.event("model.action", { tool: toolUse.name, args: JSON.parse(redact(JSON.stringify(args), sensitiveValues, mask)) });

    let resultText: string;
    const urlBefore = surface.url();

    try {
      if (toolUse.name === "finish") {
        // A description that promises to return data, from a run that never
        // extracted any, is a contract the capability cannot honour: the caller
        // reads "returns the reference number" and gets {}. Make the model
        // either go and extract it or stop claiming it.
        if (outputs.length === 0 && /\b(return|returns|report|reports|retrieve|provide)\b/i.test(args.capability_description ?? "")) {
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "Rejected: the description says this capability returns data, but no outputs were extracted. Either use the extract tool on the value it should return, or reword the description so it does not promise data the capability never reads." }] });
          continue;
        }

        // A success condition that embeds extracted data ("$4,821.77") would
        // only ever pass for this run's inputs — reject it.
        const dataEmbedded = extractedCells.find(
          (v) => v.length >= 4 && ((args.success_text_visible || "").includes(v) || (args.success_url_contains || "").includes(v))
        );
        if (dataEmbedded) {
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: `Rejected: the success condition contains run-specific data ("${dataEmbedded}"). Provide a condition based on stable UI text or URL structure (use {{param}} placeholders where needed).` }] });
          continue;
        }
        finishInfo = {
          name: args.capability_name,
          description: templatize(args.capability_description),
          textVisible: args.success_text_visible ? templatize(args.success_text_visible) : undefined,
          urlContains: args.success_url_contains ? templatize(args.success_url_contains) : undefined,
        };
        // Verify the claimed success condition against the live page before accepting.
        const live = await surface.snapshot();
        const textOk = !finishInfo.textVisible || live.visibleText.includes(substitute(finishInfo.textVisible));
        const urlOk = !finishInfo.urlContains || live.url.includes(substitute(finishInfo.urlContains));
        if (!textOk || !urlOk) {
          finishInfo = null;
          resultText = "Success condition NOT verifiable on the current page. Do not declare success prematurely — either continue working or provide a condition that is actually visible now.";
          messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }] });
          continue;
        }
        break;
      }

      if (toolUse.name === "give_up") {
        gaveUp = true;
        const shot = log.screenshotPath("stuck");
        await surface.screenshot(shot);
        await requestIntervention(surface, log, {
          reason: args.reason,
          goalOrCapability: input.goal,
          currentUrl: surface.url(),
          screenshot: shot,
          instructions: "Complete or unblock the current step manually, then hand control back.",
        });
        snap = redactSnapshot(await surface.snapshot(), sensitiveValues, mask);
        resultText = `A human operator intervened. Fresh observation:\n${formatSnapshot(snap)}\nContinue toward the goal, or finish if it is now complete.`;
        // gaveUp stays set: the terminal log event must record that the agent
        // declared itself stuck and a human was pulled in, even if the run
        // later ends by exhausting its step budget.
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }] });
        continue;
      }

      if (!actionAllowed(input.policy, toolUse.name)) {
        throw new Error(`Action "${toolUse.name}" is not in the policy allowlist.`);
      }

      if (toolUse.name === "extract") {
        const cellIndex = args.cell_index !== undefined ? Number(args.cell_index) : undefined;
        const { cells, value } = await surface.extractNear(args.anchor, cellIndex);
        // Model may re-extract to narrow with cell_index: replace, don't duplicate.
        const existingOut = outputs.findIndex((o) => o.name === args.output_name);
        if (existingOut >= 0) outputs.splice(existingOut, 1);
        const existingStep = steps.findIndex((s) => s.action === "extract" && s.output === args.output_name);
        if (existingStep >= 0) steps.splice(existingStep, 1);
        // Descriptions and intents are model-authored prose — templatize them
        // too so no concrete run value survives anywhere in the artifact.
        outputs.push({ name: args.output_name, type: "string", description: templatize(args.output_description) });
        extractedCells.push(...cells);
        steps.push({
          id: `s${stepCounter++}`, action: "extract", anchor: args.anchor,
          cellIndex, output: args.output_name, intent: templatize(args.intent), timeoutMs: 10_000,
        });
        log.event("extract", { output: args.output_name, anchor: args.anchor, value: redact(value, sensitiveValues, mask) });
        resultText = `Extracted "${args.output_name}" = "${redact(value, sensitiveValues, mask)}"\nCells after anchor: ${cells.map((c, ci) => `[${ci}] "${redact(c, sensitiveValues, mask)}"`).join(" ")}\nIf the output should be a single cell, call extract again with cell_index.`;
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }] });
        continue;
      }

      if (toolUse.name === "navigate") {
        const target = substitute(args.url);
        if (!originAllowed(input.policy, target)) {
          throw new Error(`Navigation blocked by policy: ${args.url} is outside the allowed origins.`);
        }
        await surface.navigate(target);
        steps.push({
          id: `s${stepCounter++}`, action: "navigate", url: templatize(target),
          intent: templatize(args.intent), timeoutMs: 10_000,
        });
      } else {
        const el = elementByCuaId().get(args.element);
        if (!el) throw new Error(`Unknown element id "${args.element}" — it may be stale; act on the latest observation.`);

        if (toolUse.name === "click") {
          const risky = isRiskyName(input.policy, el.name);
          if (risky) {
            const ok = await confirmRisky(el.name, log);
            if (!ok) throw new Error(`Operator declined the risky action "${el.name}". Choose a different path or give_up.`);
          }
          await surface.click(el.cuaId);
          steps.push({
            id: `s${stepCounter++}`, action: "click", target: descriptorFor(el),
            intent: templatize(args.intent), risky, timeoutMs: 10_000,
          });
        } else if (toolUse.name === "type") {
          const text = substitute(args.text);
          await surface.type(el.cuaId, text);
          const sensitive = input.params.some((p) => p.sensitive && args.text.includes(`{{${p.name}}}`));
          steps.push({
            id: `s${stepCounter++}`, action: "type", target: descriptorFor(el),
            value: templatize(args.text), sensitive, intent: templatize(args.intent), timeoutMs: 10_000,
          });
        } else if (toolUse.name === "select") {
          await surface.select(el.cuaId, args.option);
          steps.push({
            id: `s${stepCounter++}`, action: "select", target: descriptorFor(el),
            value: args.option, intent: templatize(args.intent), timeoutMs: 10_000,
          });
        }
      }

      // Re-observe; attach a URL postcondition to the step if navigation resulted.
      snap = redactSnapshot(await surface.snapshot(), sensitiveValues, mask);
      const urlAfter = surface.url();
      if (urlAfter !== urlBefore && steps.length > 0) {
        const u = new URL(urlAfter);
        steps[steps.length - 1].expect = { urlContains: templatize(u.pathname + u.search) };
      }
      resultText = `OK. New observation:\n${formatSnapshot(snap)}`;
    } catch (err) {
      resultText = `ACTION FAILED: ${(err as Error).message}`;
      log.event("action.error", { error: resultText });
      snap = redactSnapshot(await surface.snapshot(), sensitiveValues, mask);
      resultText += `\nCurrent observation:\n${formatSnapshot(snap)}`;
    }

    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }] });
  }

  const finalShot = log.screenshotPath("final");
  await surface.screenshot(finalShot);

  if (!finishInfo) {
    log.event("discovery.failed", {
      reason: gaveUp ? "gave_up (human intervened, run did not finish)" : "max_steps_or_no_finish",
    });
    await surface.close();
    log.close();
    return { artifact: null, evidenceDir: log.dir };
  }

  // One post-run enrichment call: propose reviewable outcome detectors and
  // recovery rules from what was observed. These land in the artifact where a
  // human reviewer approves/edits them — they are config, not runtime model calls.
  const enrichment = await proposeOutcomesAndRecoveries(anthropic, input.model, messages, log);

  // Validate the proposals against the one page we know is a success (see
  // filterEnrichment).
  const successText = (await surface.snapshot()).visibleText;
  const { outcomes, recoveries, rejected } = filterEnrichment(
    enrichment.outcomes,
    enrichment.recoveries,
    successText,
    substitute
  );
  for (const rej of rejected) log.event("enrichment.rejected", rej);

  // Model-proposed recovery targets never carry structural paths, and the
  // record-time policy already filtered step targets; this pass is the
  // belt-and-braces guarantee that the persisted artifact holds no
  // unnecessary DOM fingerprints.
  const artifact: Artifact = cleanStructuralPaths(ArtifactSchema.parse({
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name: finishInfo.name,
    description: finishInfo.description,
    version: 1,
    createdAt: new Date().toISOString(),
    approval: "draft",
    app: { label: input.appLabel, baseUrl: new URL(input.entryUrl).origin },
    params: input.params.map((p) => ({
      name: p.name, type: "string", description: p.description, required: true, sensitive: p.sensitive,
    })),
    outputs,
    steps,
    outcomes,
    recoveries,
    success: { textVisible: finishInfo.textVisible, urlContains: finishInfo.urlContains },
    provenance: { discoveryRunId: log.runId, model: input.model, goal: input.goal },
  }));

  // A value typed or selected during discovery that is not a parameter will be
  // typed identically on every future invocation. That is often intentional (a
  // product type, a fixed reason code) and sometimes a silent contract bug: the
  // capability's description promises a value the caller cannot actually supply.
  // The recorder cannot tell which, so it surfaces them for the reviewer.
  const literals = artifact.steps
    .filter((st): st is Extract<Step, { action: "type" | "select" }> =>
      (st.action === "type" || st.action === "select") && !/\{\{[^}]+\}\}/.test(st.value))
    .map((st) => ({ stepId: st.id, action: st.action, value: st.value }));
  if (literals.length > 0) {
    log.event("recorder.fixed_values", {
      note: "these values are baked into the capability; re-record with them as parameters if they should vary",
      values: literals,
    });
    console.log("\n  Fixed (non-parameterized) values recorded:");
    for (const l of literals) console.log(`    ${l.stepId} ${l.action} "${l.value}"`);
    console.log("  If any of those should vary per invocation, re-record it as --param.\n");
  }

  log.event("discovery.success", { artifactId: artifact.id, name: artifact.name, steps: steps.length });
  await surface.close();

  // Probe the negative path: the most important detector on a lookup flow is
  // "the thing you asked for does not exist", and the model can only guess at
  // that screen's wording because the happy-path run never saw it. Replay the
  // recorded flow deterministically with a sentinel input, read the text off
  // the page it actually lands on, and record the detector as observed.
  if (!input.skipProbe) {
    await probeNegativePath(artifact, successText, input, anthropic, log);
  }

  log.writeFile("artifact.json", JSON.stringify(artifact, null, 2));
  log.close();
  return { artifact, evidenceDir: log.dir };
}

async function confirmRisky(name: string, log: RunLogger): Promise<boolean> {
  log.event("risky.confirmation_requested", { control: name });
  console.log(`\n  RISKY ACTION: the agent wants to click "${name}".`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question("  Allow? [y/N] ", resolve));
  rl.close();
  const ok = answer.trim().toLowerCase() === "y";
  log.event("risky.confirmation_result", { control: name, approved: ok });
  return ok;
}

async function proposeOutcomesAndRecoveries(
  anthropic: Anthropic,
  model: string,
  transcript: Anthropic.MessageParam[],
  log: RunLogger
): Promise<{ outcomes: Artifact["outcomes"]; recoveries: Artifact["recoveries"] }> {
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1500,
      system:
        "You just completed a UI automation run (transcript follows). Propose (a) known business outcomes a deterministic replay of this flow might encounter (error banners, not-found messages, validation errors — things a caller should receive as legitimate results, not crashes), and (b) recovery rules for known interstitials (e.g. session-expiry pages) where clicking one control resumes the flow. Base detectors on text patterns this application plausibly shows; keep them short and literal. Respond ONLY with JSON: {\"outcomes\": [{\"code\", \"description\", \"when\": {\"textVisible\"}}], \"recoveries\": [{\"id\", \"description\", \"when\": {\"textVisible\"}, \"do\": {\"click\": {\"role\", \"name\"}}, \"maxAttempts\": 1}]}",
      messages: [
        {
          role: "user",
          // Flattened transcript: slicing raw messages can orphan
          // tool_result blocks from their tool_use and 400 the API.
          content:
            "Transcript summary:\n" +
            transcript
              .map((m) => {
                const parts = Array.isArray(m.content)
                  ? m.content.map((b: any) =>
                      b.type === "text" ? b.text
                      : b.type === "tool_use" ? `TOOL ${b.name} ${JSON.stringify(b.input)}`
                      : b.type === "tool_result" ? `RESULT ${typeof b.content === "string" ? b.content : ""}`
                      : ""
                    ).join("\n")
                  : String(m.content);
                return `${m.role.toUpperCase()}: ${parts}`;
              })
              .join("\n---\n")
              .slice(-12_000) +
            "\n\nNow output the JSON described in the system prompt.",
        },
      ],
    });
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "{}";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    log.event("enrichment.proposed", json);
    // Outcome codes are part of the caller-facing contract, so they are
    // normalized here rather than left in whatever case the model returned —
    // otherwise MEMBER_NOT_FOUND and member_not_found coexist as two detectors
    // for one condition.
    const snake = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return {
      outcomes: (json.outcomes ?? []).slice(0, 8).map((o: any) => ({ ...o, code: snake(o.code) })),
      recoveries: (json.recoveries ?? []).slice(0, 4).map((r: any) => ({
        maxAttempts: 1,
        ...r,
        id: snake(r.id),
        do: { click: { structuralPath: undefined, nearText: undefined, nth: undefined, ...r.do.click } },
      })),
    };
  } catch (err) {
    log.event("enrichment.skipped", { error: (err as Error).message });
    return { outcomes: [], recoveries: [] };
  }
}

// ---------------------------------------------------------------------------
// Enrichment validation.
//
// The model proposes outcome detectors and recovery rules for screens it never
// visited — useful, but unverified guesses. Exactly one of those guesses can be
// disproved automatically: a detector whose text is visible on the successful
// end state is self-evidently wrong, because it would classify every good run
// as a business outcome (or fire a recovery on a healthy page). A real
// discovery run proposed `no_savings_account` keyed on "Accounts" — a heading
// present on every member page — which turned successful replays into
// business_outcome results. Those are dropped here; the rest stay in the draft
// for a human reviewer, which is what the draft -> approved gate is for.
// ---------------------------------------------------------------------------
export function filterEnrichment(
  outcomes: Artifact["outcomes"],
  recoveries: Artifact["recoveries"],
  successText: string,
  substitute: (s: string) => string
): { outcomes: Artifact["outcomes"]; recoveries: Artifact["recoveries"]; rejected: Record<string, string>[] } {
  const success = successText.toLowerCase();
  const rejected: Record<string, string>[] = [];
  const contradicts = (text?: string) => !!text && success.includes(substitute(text).toLowerCase());

  const keptOutcomes = outcomes.filter((o) => {
    if (!contradicts(o.when.textVisible)) return true;
    rejected.push({ kind: "outcome", code: o.code, reason: "detector text is visible on the success page" });
    return false;
  });
  const keptRecoveries = recoveries.filter((r) => {
    if (!contradicts(r.when.textVisible)) return true;
    rejected.push({ kind: "recovery", id: r.id, reason: "trigger text is visible on the success page" });
    return false;
  });
  return { outcomes: keptOutcomes, recoveries: keptRecoveries, rejected };
}

// ---------------------------------------------------------------------------
// Negative-path probe.
//
// A lookup capability's most valuable detector is "no such record", and it is
// exactly the one the model cannot verify: the successful run never visits
// that screen, so any wording it proposes is a guess. A guess that misses does
// real damage — the not-found page becomes a hard failure instead of the
// business outcome the caller needs.
//
// So the recorder goes and looks. It replays the recorded flow deterministically
// with a sentinel value, reads the page the flow actually lands on, and derives
// the detector from text that is present there and absent from the success page.
// The fragment is evidence, never a guess; only the naming is left to the model,
// with a deterministic fallback.
//
// Skipped when the flow has no parameters to vary, or contains a risky step —
// probing must never drive a mutation.
// ---------------------------------------------------------------------------

// A value shaped like the recorded one but improbable enough not to exist.
export function sentinelFor(recorded: string): string {
  if (/^\d+$/.test(recorded)) return "9".repeat(Math.max(recorded.length + 3, 8));
  return "zzz-no-such-value-zzz";
}

// Text present on the probe page but not on the success page, earliest first —
// the distinctive part of the failure screen.
export function distinctiveFragment(
  probeText: string,
  successText: string,
  sentinels: string[] = []
): string | undefined {
  const success = successText.toLowerCase();
  // The sentinel is our own invention. A fragment containing it would be a
  // detector that can never match a real caller's input.
  const carriesSentinel = (t: string) => sentinels.some((v) => v && t.includes(v));
  const chunks = probeText
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length >= 8 && c.length <= 120);
  for (const chunk of chunks) {
    if (success.includes(chunk.toLowerCase()) || carriesSentinel(chunk)) continue;
    // Trim to the first sentence-ish span so the detector stays a short literal.
    const fragment = chunk.slice(0, 80).trim();
    if (fragment.length >= 8 && !success.includes(fragment.toLowerCase()) && !carriesSentinel(fragment)) return fragment;
  }
  return undefined;
}

async function probeNegativePath(
  artifact: Artifact,
  successText: string,
  input: DiscoveryInput,
  anthropic: Anthropic,
  log: RunLogger
): Promise<void> {
  if (artifact.params.length === 0) return log.event("probe.skipped", { reason: "no parameters to vary" });
  if (artifact.steps.some((s) => s.action === "click" && s.risky)) {
    return log.event("probe.skipped", { reason: "flow contains a risky step; probing must not drive a mutation" });
  }

  const sentinels = Object.fromEntries(
    artifact.params.map((p) => [p.name, sentinelFor(input.params.find((ip) => ip.name === p.name)?.value ?? "")])
  );
  log.event("probe.start", { sentinels });

  const result = await replayArtifact(artifact, {
    params: sentinels,
    policy: input.policy,
    headful: false,
    allowRisky: false,
    escalate: false,
    evidenceBase: log.dir,
  });

  if (result.status === "business_outcome") {
    // A proposed detector already covers this screen; promote it to observed.
    const hit = artifact.outcomes.find((o) => o.code === result.outcomeCode);
    if (hit) hit.source = "observed";
    return log.event("probe.confirmed", { outcome: result.outcomeCode, evidenceDir: result.evidenceDir });
  }
  if (result.status !== "failure" || !result.error) {
    return log.event("probe.inconclusive", { status: result.status, evidenceDir: result.evidenceDir });
  }

  const pageMatch = /page: "([\s\S]*)"$/.exec(result.error.observed);
  const probeText = pageMatch?.[1];
  if (!probeText) return log.event("probe.inconclusive", { reason: "no page text captured", stepId: result.error.stepId });

  const fragment = distinctiveFragment(probeText, successText, Object.values(sentinels));
  if (!fragment) return log.event("probe.inconclusive", { reason: "probe page is not distinguishable from the success page" });

  const named = await nameOutcome(anthropic, input.model, fragment, probeText, log);
  const existing = artifact.outcomes.findIndex((o) => o.code === named.code);
  const detector = {
    code: named.code,
    description: named.description,
    source: "observed" as const,
    when: { textVisible: fragment },
  };
  if (existing >= 0) artifact.outcomes[existing] = detector;
  else artifact.outcomes.unshift(detector);

  log.event("probe.detector_observed", {
    code: detector.code,
    textVisible: fragment,
    replacedProposed: existing >= 0,
    stepId: result.error.stepId,
    evidenceDir: result.evidenceDir,
  });
}

// The fragment is fixed by observation; the model only names it.
async function nameOutcome(
  anthropic: Anthropic,
  model: string,
  fragment: string,
  probeText: string,
  log: RunLogger
): Promise<{ code: string; description: string }> {
  const fallback = {
    code: fragment.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").split("_").slice(0, 4).join("_"),
    description: `Observed when the flow was probed with a value that does not exist: "${fragment}"`,
  };
  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: 300,
      system:
        'A UI flow was replayed with an input that does not exist. Name the resulting business outcome for a calling agent. Respond ONLY with JSON: {"code": "snake_case_outcome_code", "description": "one sentence"}. Prefer conventional codes such as member_not_found, record_not_found, or no_results.',
      messages: [{ role: "user", content: `Page text:\n${probeText.slice(0, 1200)}\n\nDistinctive fragment: ${fragment}` }],
    });
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    if (typeof parsed.code === "string" && /^[a-z0-9_]+$/.test(parsed.code)) {
      return { code: parsed.code, description: String(parsed.description ?? fallback.description) };
    }
  } catch (err) {
    log.event("probe.naming_failed", { error: (err as Error).message });
  }
  return fallback;
}
