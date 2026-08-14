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
  aborted: boolean;
}

export async function requestIntervention(
  surface: PlaywrightSurface,
  log: RunLogger,
  req: InterventionRequest
): Promise<InterventionResult> {
  log.event("escalation.raised", { ...req });
  log.writeFile("intervention.json", JSON.stringify(req, null, 2));

  // Start capturing human actions on the live page.
  const actions: string[] = [];
  // Capture is navigation-proof: a page-level binding plus an init script
  // (gated by a sessionStorage flag) re-arm the listeners on every document
  // the human visits during the handoff.
  await surface.enableHumanCapture((desc) => {
    actions.push(desc);
    log.event("human.action", { desc });
  });

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
  console.log("  here to hand control back to the automation — or type 'abort'");
  console.log("  and ENTER to stop the run.");
  console.log("=".repeat(70) + "\n");

  const line = await waitForLine();
  await surface.disableHumanCapture();

  const aborted = line.trim().toLowerCase() === "abort";
  log.event("escalation.resolved", {
    controller: aborted ? "aborted" : "automation",
    humanActions: actions.length,
  });
  return { humanActions: actions, aborted };
}

function waitForLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
