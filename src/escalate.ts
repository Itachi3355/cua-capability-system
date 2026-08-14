import readline from "node:readline";
import type { PlaywrightSurface } from "./surface.js";
import type { RunLogger } from "./logger.js";

// ---------------------------------------------------------------------------
// Human-in-the-loop handoff.
//
// Control model: a run is always in exactly one control state —
//   controller: "automation" | "human"
// Escalation transitions automation -> human on the SAME live Playwright
// session (runs are headful, so the browser window on the operator's desktop
// IS the takeover surface — no second session, no state cloning). While the
// human is in control, automation performs no actions; injected DOM listeners
// record what the human does (clicks, field edits — values of password fields
// are never captured). The operator signals completion in the terminal, and
// control transitions back to automation, which re-verifies state before
// resuming.
//
// The "operator console" is deliberately minimal (terminal prompt + the live
// browser window). The seam — pause, cede, capture, resume-with-verification —
// is the real mechanism; a production operator UI would sit on the far side
// of requestIntervention() without changing anything else.
// ---------------------------------------------------------------------------

export interface InterventionRequest {
  reason: string;
  goalOrCapability: string;
  stepId?: string;
  currentUrl: string;
  screenshot: string;
  instructions: string;
}

export interface InterventionResult {
  humanActions: string[];
}

let activeSink: { actions: string[]; log: RunLogger } | null = null;

export async function requestIntervention(
  surface: PlaywrightSurface,
  log: RunLogger,
  req: InterventionRequest
): Promise<InterventionResult> {
  log.event("escalation.raised", { ...req });
  log.writeFile("intervention.json", JSON.stringify(req, null, 2));

  // Start capturing human actions on the live page.
  const actions: string[] = [];
  activeSink = { actions, log };
  try {
    // The exposed function survives for the life of the page; route through a
    // module-level sink so repeat escalations on one session keep working.
    await surface.page.exposeFunction("__cuaHumanAction", (desc: string) => {
      if (activeSink) {
        activeSink.actions.push(desc);
        activeSink.log.event("human.action", { desc });
      }
    });
  } catch {
    // already registered from a previous escalation on this session
  }
  // String-form evaluate: bundlers inject helpers (__name) into function-form
  // callbacks that don't exist in the page context.
  await surface.page.evaluate(`(() => {
    const describe = (el) => {
      const tag = el.tagName.toLowerCase();
      const label = (el.getAttribute("aria-label") || el.value || el.textContent || el.name || "")
        .replace(/\\s+/g, " ").trim().slice(0, 60);
      return tag + (el.type ? "[" + el.type + "]" : "") + ' "' + label + '"';
    };
    document.addEventListener("click", (e) => {
      if (e.target) window.__cuaHumanAction("click " + describe(e.target));
    }, true);
    document.addEventListener("change", (e) => {
      const t = e.target;
      if (!t) return;
      const value = t.type === "password" ? "«hidden»" : t.value;
      window.__cuaHumanAction("set " + describe(t) + ' = "' + value + '"');
    }, true);
  })()`);

  console.log("\n" + "=".repeat(70));
  console.log("  HUMAN INTERVENTION REQUIRED  (controller: human)");
  console.log("=".repeat(70));
  console.log(`  Capability : ${req.goalOrCapability}`);
  if (req.stepId) console.log(`  Stuck at   : step ${req.stepId}`);
  console.log(`  Reason     : ${req.reason}`);
  console.log(`  URL        : ${req.currentUrl}`);
  console.log(`  Screenshot : ${req.screenshot}`);
  console.log(`  ${req.instructions}`);
  console.log("  The live browser window is now yours. When done, press ENTER");
  console.log("  here to hand control back to the automation.");
  console.log("=".repeat(70) + "\n");

  await waitForEnter();
  activeSink = null;

  log.event("escalation.resolved", { controller: "automation", humanActions: actions.length });
  return { humanActions: actions };
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}
