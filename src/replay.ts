import type { Artifact, ReplayResult, Snapshot, Step } from "./types.js";
import { ReplayResult as ReplayResultSchema } from "./types.js";
import { PlaywrightSurface, resolveDescriptor, type Resolution } from "./surface.js";
import { actionAllowed, originAllowed, redact, type Policy } from "./policy.js";
import { RunLogger } from "./logger.js";
import { requestIntervention } from "./escalate.js";

// ---------------------------------------------------------------------------
// Deterministic replay — the production execution path. No LLM anywhere in
// this file. Given an artifact + params, execute the recorded steps with:
//
//   - semantic locator resolution (surface.resolveDescriptor), structural
//     fallback flagged when used
//   - a checkpoint after every step that declared one, polled with timeout
//   - a three-way error taxonomy evaluated at every stuck point:
//       1. known business outcome  -> terminal, returned to caller as a result
//       2. recovery rule matches   -> bounded deterministic recovery, retry step
//       3. neither                 -> hard failure (or human escalation if a
//                                     live operator is attached)
// ---------------------------------------------------------------------------

export interface ReplayOptions {
  params: Record<string, string>;
  policy: Policy;
  headful: boolean;
  allowRisky: boolean;
  // With a live operator attached (headful), unrecoverable states escalate to
  // a human instead of failing outright.
  escalate: boolean;
  evidenceBase?: string;
}

const POLL_MS = 250;

export async function replayArtifact(artifact: Artifact, opts: ReplayOptions): Promise<ReplayResult> {
  const log = new RunLogger("replay", opts.evidenceBase);
  const startedAt = new Date().toISOString();
  const outputs: Record<string, string> = {};
  const sensitiveValues = artifact.params.filter((p) => p.sensitive).map((p) => opts.params[p.name]).filter(Boolean);
  const mask = opts.policy.redaction.mask;
  const r = (s: string) => redact(s, sensitiveValues, mask);

  const substitute = (s: string) => {
    let out = s;
    for (const p of artifact.params) {
      const v = opts.params[p.name];
      if (v !== undefined) out = out.split(`{{${p.name}}}`).join(v);
    }
    return out;
  };

  const finish = (partial: Partial<ReplayResult> & Pick<ReplayResult, "status">): ReplayResult => {
    const result = ReplayResultSchema.parse({
      runId: log.runId,
      artifact: { id: artifact.id, name: artifact.name, version: artifact.version },
      outputs,
      startedAt,
      finishedAt: new Date().toISOString(),
      evidenceDir: log.dir,
      ...partial,
    });
    log.event("replay.result", result as unknown as Record<string, unknown>);
    log.writeFile("result.json", JSON.stringify(result, null, 2));
    log.close();
    return result;
  };

  // --- preflight validation: params + approval gate ---
  for (const p of artifact.params) {
    if (p.required && opts.params[p.name] === undefined) {
      return finish({
        status: "failure",
        error: { stepId: "preflight", expected: `param "${p.name}" supplied`, observed: "missing" },
      });
    }
  }
  const hasRisky = artifact.steps.some((s) => s.action === "click" && s.risky);
  if (hasRisky && (artifact.approval !== "approved" || !opts.allowRisky)) {
    return finish({
      status: "failure",
      error: {
        stepId: "preflight",
        expected: `artifact approval "approved" and --allow-risky for risky steps`,
        observed: `approval="${artifact.approval}", allowRisky=${opts.allowRisky}`,
      },
    });
  }

  log.event("replay.start", {
    artifact: artifact.name,
    version: artifact.version,
    params: Object.fromEntries(
      artifact.params.map((p) => [p.name, p.sensitive ? mask : opts.params[p.name]])
    ),
  });

  const surface = await PlaywrightSurface.launch({ headful: opts.headful });
  const escalations: string[] = [];
  let escalatedInfo: ReplayResult["escalation"] | undefined;

  const checkOutcome = (snap: Snapshot): string | undefined => {
    for (const o of artifact.outcomes) {
      const textOk = !o.when.textVisible || snap.visibleText.toLowerCase().includes(o.when.textVisible.toLowerCase());
      const urlOk = !o.when.urlContains || snap.url.includes(substitute(o.when.urlContains));
      if ((o.when.textVisible || o.when.urlContains) && textOk && urlOk) return o.code;
    }
    return undefined;
  };

  const tryRecover = async (snap: Snapshot, attempted: Set<string>): Promise<boolean> => {
    for (const rule of artifact.recoveries) {
      if (attempted.has(rule.id)) continue;
      if (snap.visibleText.toLowerCase().includes(rule.when.textVisible.toLowerCase())) {
        const res = resolveDescriptor(rule.do.click, snap);
        if ("error" in res) continue;
        attempted.add(rule.id);
        log.event("recovery.applied", { rule: rule.id, description: rule.description });
        await surface.click(res.element.cuaId);
        return true;
      }
    }
    return false;
  };

  const expectSatisfied = async (step: Step): Promise<{ ok: boolean; observed: string }> => {
    if (!step.expect) return { ok: true, observed: "" };
    const deadline = Date.now() + step.timeoutMs;
    let lastObserved = "";
    while (Date.now() < deadline) {
      const snap = await surface.snapshot();
      const wantUrl = step.expect.urlContains ? substitute(step.expect.urlContains) : undefined;
      const wantText = step.expect.textVisible ? substitute(step.expect.textVisible) : undefined;
      const urlOk = !wantUrl || snap.url.includes(wantUrl);
      const textOk = !wantText || snap.visibleText.includes(wantText);
      let targetOk = true;
      if (step.expect.targetVisible) {
        targetOk = !("error" in resolveDescriptor(step.expect.targetVisible, snap));
      }
      if (urlOk && textOk && targetOk) return { ok: true, observed: snap.url };
      lastObserved = `url=${snap.url}, text head="${snap.visibleText.slice(0, 120)}"`;
      // A known business outcome supersedes a failed checkpoint.
      const outcome = checkOutcome(snap);
      if (outcome) return { ok: false, observed: `business outcome detected: ${outcome}` };
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    return { ok: false, observed: lastObserved };
  };

  try {
    for (let i = 0; i < artifact.steps.length; i++) {
      const step = artifact.steps[i];
      log.event("step.start", { id: step.id, action: step.action, intent: step.intent });

      if (!actionAllowed(opts.policy, step.action)) {
        return finish({
          status: "failure",
          error: { stepId: step.id, expected: `action "${step.action}" permitted by policy`, observed: "blocked" },
        });
      }

      const attemptedRecoveries = new Set<string>();
      let attempts = 0;
      const MAX_STEP_ATTEMPTS = 3; // initial + recovery retry + one transient retry

      stepLoop: while (true) {
        attempts++;
        try {
          if (step.action === "extract") {
            const preSnap = await surface.snapshot();
            const outcome = checkOutcome(preSnap);
            if (outcome) {
              const shot = log.screenshotPath(`outcome-${outcome}`);
              await surface.screenshot(shot);
              return finish({ status: "business_outcome", outcomeCode: outcome });
            }
            const { value } = await surface.extractNear(substitute(step.anchor), step.cellIndex);
            outputs[step.output] = value;
            log.event("extract", { output: step.output, value: r(value) });
          } else if (step.action === "navigate") {
            const url = substitute(step.url);
            if (!originAllowed(opts.policy, url)) {
              return finish({
                status: "failure",
                error: { stepId: step.id, expected: "URL within allowed origins", observed: url },
              });
            }
            await surface.navigate(url);
          } else {
            // Resolve the target with a bounded wait: the control appearing
            // late is transient slowness, not failure.
            const deadline = Date.now() + step.timeoutMs;
            let resolution: Resolution | null = null;
            let lastDetail = "";
            let snap: Snapshot | null = null;
            while (Date.now() < deadline && !resolution) {
              snap = await surface.snapshot();
              // Terminal business outcome beats everything.
              const outcome = checkOutcome(snap);
              if (outcome) {
                const shot = log.screenshotPath(`outcome-${outcome}`);
                await surface.screenshot(shot);
                log.event("business_outcome", { code: outcome, stepId: step.id });
                return finish({ status: "business_outcome", outcomeCode: outcome });
              }
              const res = resolveDescriptor({ ...step.target, name: substitute(step.target.name), nearText: step.target.nearText ? substitute(step.target.nearText) : undefined }, snap);
              if ("error" in res) {
                lastDetail = `${res.error}: ${res.detail}`;
                if (await tryRecover(snap, attemptedRecoveries)) continue stepLoop;
                await new Promise((res2) => setTimeout(res2, POLL_MS));
              } else {
                resolution = res;
              }
            }
            if (!resolution) throw new StepError(`target not resolved: ${lastDetail}`);
            if (resolution.method === "structural") {
              log.event("locator.structural_fallback", { stepId: step.id, target: step.target });
            }

            if (step.action === "click") {
              if (step.risky) log.event("risky.step_executing", { stepId: step.id, gate: "approved+allowRisky" });
              await surface.click(resolution.element.cuaId);
            } else if (step.action === "type") {
              await surface.type(resolution.element.cuaId, substitute(step.value));
            } else if (step.action === "select") {
              await surface.select(resolution.element.cuaId, substitute(step.value));
            }
          }

          // Checkpoint.
          const check = await expectSatisfied(step);
          if (!check.ok) {
            if (check.observed.startsWith("business outcome detected: ")) {
              const code = check.observed.slice("business outcome detected: ".length);
              const shot = log.screenshotPath(`outcome-${code}`);
              await surface.screenshot(shot);
              return finish({ status: "business_outcome", outcomeCode: code });
            }
            const snap = await surface.snapshot();
            if (await tryRecover(snap, attemptedRecoveries)) continue stepLoop;
            throw new StepError(
              `checkpoint failed — expected ${JSON.stringify(step.expect)}, observed ${check.observed}`
            );
          }
          log.event("step.ok", { id: step.id, attempts });
          break stepLoop;
        } catch (err) {
          if (attempts < MAX_STEP_ATTEMPTS && !(err instanceof StepError)) {
            // Transient (timeout / detached node): brief backoff, retry.
            log.event("step.retry", { id: step.id, attempt: attempts, error: (err as Error).message });
            await new Promise((res) => setTimeout(res, 1000));
            continue stepLoop;
          }

          // The operator may have closed the browser window entirely — that
          // ends the session; report it cleanly instead of crashing.
          if ((err as Error).message?.includes("has been closed")) {
            return finish({
              status: "failure",
              error: {
                stepId: step.id,
                expected: "live browser session",
                observed: "browser window was closed externally — the headful window is the takeover surface and must stay open",
              },
            });
          }
          const shot = log.screenshotPath(`failure-${step.id}`);
          let shotOk = true;
          try {
            await surface.screenshot(shot);
          } catch {
            shotOk = false;
          }
          const expected =
            step.action === "navigate" ? `navigate ${step.url}`
            : step.action === "extract" ? `extract near anchor "${step.anchor}"`
            : `${step.action} on ${JSON.stringify(step.target)}`;
          const observed = r((err as Error).message);

          if (opts.escalate && opts.headful) {
            const intervention = await requestIntervention(surface, log, {
              reason: observed,
              goalOrCapability: `${artifact.name} v${artifact.version}`,
              stepId: step.id,
              currentUrl: surface.url(),
              screenshot: shotOk ? shot : "(unavailable)",
              instructions: `Automation could not complete step "${step.id}" (${step.intent}). Either perform that step manually, or fix the blocking state and leave the step to automation.`,
            });
            escalations.push(...intervention.humanActions);
            // Re-verify: if the human's manual work satisfied the step's
            // postcondition, skip it; otherwise re-attempt it once.
            const check = await expectSatisfied(step);
            escalatedInfo = {
              reason: observed,
              humanActions: intervention.humanActions.map(r),
              resumedAtStep: check.ok ? artifact.steps[i + 1]?.id ?? "(end)" : step.id,
            };
            if (check.ok) {
              log.event("escalation.step_satisfied_by_human", { stepId: step.id });
              break stepLoop;
            }
            attempts = 0;
            attemptedRecoveries.clear();
            continue stepLoop;
          }

          return finish({
            status: "failure",
            error: { stepId: step.id, expected, observed, screenshot: shotOk ? shot : undefined },
          });
        }
      }
    }

    // Final success condition.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const snap = await surface.snapshot();
      const wantText = artifact.success.textVisible ? substitute(artifact.success.textVisible) : undefined;
      const wantUrl = artifact.success.urlContains ? substitute(artifact.success.urlContains) : undefined;
      const ok = (!wantText || snap.visibleText.includes(wantText)) && (!wantUrl || snap.url.includes(wantUrl));
      if (ok) {
        const shot = log.screenshotPath("success");
        await surface.screenshot(shot);
        return finish(
          escalatedInfo
            ? { status: "escalated", escalation: escalatedInfo }
            : { status: "success" }
        );
      }
      const outcome = checkOutcome(snap);
      if (outcome) return finish({ status: "business_outcome", outcomeCode: outcome });
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
    const shot = log.screenshotPath("final-check-failed");
    await surface.screenshot(shot);
    const snap = await surface.snapshot();
    return finish({
      status: "failure",
      error: {
        stepId: "final-check",
        expected: JSON.stringify(artifact.success),
        observed: r(`url=${snap.url}, text head="${snap.visibleText.slice(0, 150)}"`),
        screenshot: shot,
      },
    });
  } finally {
    await surface.close();
  }
}

class StepError extends Error {}
