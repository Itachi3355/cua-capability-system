import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";
import readline from "node:readline";
import type { Artifact, ElementDescriptor, ObservedElement, Snapshot, Step } from "./types.js";
import { Artifact as ArtifactSchema } from "./types.js";
import { PlaywrightSurface } from "./surface.js";
import { actionAllowed, isRiskyName, originAllowed, redact, redactSnapshot, type Policy } from "./policy.js";
import { RunLogger } from "./logger.js";
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
  const paramByValue = new Map(input.params.filter((p) => !p.sensitive).map((p) => [p.value, p.name]));

  // Template every param value back out of recorded strings so the artifact
  // is parameterized, not a macro of one concrete run.
  const templatize = (s: string) => {
    let out = s;
    for (const p of input.params) out = out.split(p.value).join(`{{${p.name}}}`);
    return out;
  };
  const substitute = (s: string) => {
    let out = s;
    for (const p of input.params) out = out.split(`{{${p.name}}}`).join(p.value);
    return out;
  };

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
    const desc: ElementDescriptor = {
      role: el.role,
      name: templatize(el.name),
      structuralPath: el.structuralPath,
    };
    if (el.nearText) desc.nearText = templatize(el.nearText);
    if (ties.length > 1) desc.nth = ties.indexOf(el);
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
          description: args.capability_description,
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
        gaveUp = false; // human unblocked us; artifact stays draft either way
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
        outputs.push({ name: args.output_name, type: "string", description: args.output_description });
        extractedCells.push(...cells);
        steps.push({
          id: `s${stepCounter++}`, action: "extract", anchor: args.anchor,
          cellIndex, output: args.output_name, intent: args.intent, timeoutMs: 10_000,
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
          intent: args.intent, timeoutMs: 10_000,
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
            intent: args.intent, risky, timeoutMs: 10_000,
          });
        } else if (toolUse.name === "type") {
          const text = substitute(args.text);
          await surface.type(el.cuaId, text);
          const sensitive = input.params.some((p) => p.sensitive && args.text.includes(`{{${p.name}}}`));
          steps.push({
            id: `s${stepCounter++}`, action: "type", target: descriptorFor(el),
            value: templatize(args.text), sensitive, intent: args.intent, timeoutMs: 10_000,
          });
        } else if (toolUse.name === "select") {
          await surface.select(el.cuaId, args.option);
          steps.push({
            id: `s${stepCounter++}`, action: "select", target: descriptorFor(el),
            value: args.option, intent: args.intent, timeoutMs: 10_000,
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
    log.event("discovery.failed", { reason: gaveUp ? "gave_up" : "max_steps_or_no_finish" });
    await surface.close();
    log.close();
    return { artifact: null, evidenceDir: log.dir };
  }

  // One post-run enrichment call: propose reviewable outcome detectors and
  // recovery rules from what was observed. These land in the artifact where a
  // human reviewer approves/edits them — they are config, not runtime model calls.
  const enrichment = await proposeOutcomesAndRecoveries(anthropic, input.model, messages, log);

  const artifact: Artifact = ArtifactSchema.parse({
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
    outcomes: enrichment.outcomes,
    recoveries: enrichment.recoveries,
    success: { textVisible: finishInfo.textVisible, urlContains: finishInfo.urlContains },
    provenance: { discoveryRunId: log.runId, model: input.model, goal: input.goal },
  });

  log.event("discovery.success", { artifactId: artifact.id, name: artifact.name, steps: steps.length });
  log.writeFile("artifact.json", JSON.stringify(artifact, null, 2));
  await surface.close();
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
    return {
      outcomes: (json.outcomes ?? []).slice(0, 8),
      recoveries: (json.recoveries ?? []).slice(0, 4).map((r: any) => ({
        maxAttempts: 1,
        ...r,
        do: { click: { structuralPath: undefined, nearText: undefined, nth: undefined, ...r.do.click } },
      })),
    };
  } catch (err) {
    log.event("enrichment.skipped", { error: (err as Error).message });
    return { outcomes: [], recoveries: [] };
  }
}
