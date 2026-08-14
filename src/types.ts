import { z } from "zod";

// ---------------------------------------------------------------------------
// Element descriptors — how a recorded step identifies its target control.
//
// We deliberately do NOT record raw CSS selectors as the primary locator.
// Legacy surfaces have no stable ids/classes, but what a human perceives is
// stable: a control's role, its accessible name, and the text near it.
// The descriptor captures that perceptual identity; a structural path is
// kept only as a last-resort fallback.
// ---------------------------------------------------------------------------
export const ElementDescriptor = z.object({
  role: z.enum(["link", "button", "textbox", "select", "checkbox", "radio", "other"]),
  // Accessible-name approximation: visible text / value / aria-label / placeholder
  name: z.string(),
  // Nearest preceding label-ish text (table cell, label element) — disambiguator
  nearText: z.string().optional(),
  // 0-based index among elements that tie on the above (rare; tables of identical links)
  nth: z.number().int().nonnegative().optional(),
  // Structural fallback (tag chain w/ indices). Least trusted; used only if
  // semantic matching fails, and its use is reported in the step result.
  structuralPath: z.string().optional(),
});
export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
const StepBase = {
  id: z.string(),
  // Human-readable intent, written at record time. Reviewers read this.
  intent: z.string(),
  // Postcondition asserted after the action (checkpoint-per-step).
  expect: z
    .object({
      urlContains: z.string().optional(),
      textVisible: z.string().optional(),
      targetVisible: ElementDescriptor.optional(),
    })
    .optional(),
  timeoutMs: z.number().int().positive().default(10_000),
};

export const Step = z.discriminatedUnion("action", [
  z.object({ ...StepBase, action: z.literal("navigate"), url: z.string() }),
  z.object({
    ...StepBase,
    action: z.literal("click"),
    target: ElementDescriptor,
    // Risky steps (mutations, confirmations) are policy-gated on replay.
    risky: z.boolean().default(false),
  }),
  z.object({
    ...StepBase,
    action: z.literal("type"),
    target: ElementDescriptor,
    // Value template: literal text or "{{param_name}}"
    value: z.string(),
    sensitive: z.boolean().default(false),
  }),
  z.object({
    ...StepBase,
    action: z.literal("select"),
    target: ElementDescriptor,
    value: z.string(),
  }),
  z.object({
    ...StepBase,
    action: z.literal("extract"),
    // Extraction targets are usually plain text (table cells), not controls.
    // We anchor on a stable literal label ("Savings", "Reference number:")
    // and read the sibling cells that follow it — the way a human reads a row.
    anchor: z.string(),
    cellIndex: z.number().int().nonnegative().optional(), // which sibling cell; omit = all joined
    output: z.string(), // name of the declared output this fills
  }),
]);
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Known business outcomes & recovery rules
//
// "No such member" is an answer, not a crash. Detectors let replay classify
// runtime screens. They are part of the artifact so they are human-reviewable
// and editable — the recorder seeds them from what discovery observed, and a
// reviewer can extend them.
// ---------------------------------------------------------------------------
export const OutcomeDetector = z.object({
  code: z.string(), // e.g. "member_not_found"
  description: z.string(),
  when: z.object({
    textVisible: z.string().optional(),
    urlContains: z.string().optional(),
  }),
});
export type OutcomeDetector = z.infer<typeof OutcomeDetector>;

export const RecoveryRule = z.object({
  id: z.string(),
  description: z.string(), // e.g. "Dismiss session-expiry interstitial"
  when: z.object({ textVisible: z.string() }),
  // Bounded, deterministic recovery: click one control, then retry the step.
  do: z.object({ click: ElementDescriptor }),
  maxAttempts: z.number().int().positive().default(1),
});
export type RecoveryRule = z.infer<typeof RecoveryRule>;

// ---------------------------------------------------------------------------
// The capability artifact — the contract an AI agent invokes.
// ---------------------------------------------------------------------------
export const ParamSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  required: z.boolean().default(true),
  // Sensitive params are never persisted in logs/artifacts beyond the template.
  sensitive: z.boolean().default(false),
});

export const OutputSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
});

export const Artifact = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string(), // machine-callable name, e.g. "lookup_member_savings_balance"
  description: z.string(), // what the capability does, for humans and calling agents
  version: z.number().int().positive(),
  createdAt: z.string(),
  // Approval gate: replays of artifacts with risky steps require "approved".
  approval: z.enum(["draft", "approved"]).default("draft"),
  app: z.object({
    label: z.string(),
    baseUrl: z.string(),
  }),
  params: z.array(ParamSpec),
  outputs: z.array(OutputSpec),
  steps: z.array(Step),
  outcomes: z.array(OutcomeDetector),
  recoveries: z.array(RecoveryRule),
  // Final success condition, verified after the last step.
  success: z.object({
    urlContains: z.string().optional(),
    textVisible: z.string().optional(),
  }),
  provenance: z.object({
    discoveryRunId: z.string(),
    model: z.string(),
    goal: z.string(),
  }),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------------------------------------------------------------------------
// Replay result contract — what the calling agent gets back.
// status taxonomy:
//   success           — checkpointed flow completed; outputs populated
//   business_outcome  — a known, legitimate non-success result (e.g. not found)
//   escalated         — human was brought in; includes what they did + final state
//   failure           — hard failure with debuggable detail
// ---------------------------------------------------------------------------
export const ReplayResult = z.object({
  runId: z.string(),
  artifact: z.object({ id: z.string(), name: z.string(), version: z.number() }),
  status: z.enum(["success", "business_outcome", "escalated", "failure"]),
  outputs: z.record(z.string()).default({}),
  outcomeCode: z.string().optional(), // set when status === "business_outcome"
  error: z
    .object({
      stepId: z.string(),
      expected: z.string(),
      observed: z.string(),
      screenshot: z.string().optional(),
    })
    .optional(),
  escalation: z
    .object({
      reason: z.string(),
      humanActions: z.array(z.string()),
      resumedAtStep: z.string().optional(),
    })
    .optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  evidenceDir: z.string(),
});
export type ReplayResult = z.infer<typeof ReplayResult>;

// Observation element as enumerated from the live page.
export interface ObservedElement {
  cuaId: string; // ephemeral handle stamped on the DOM for this snapshot
  role: ElementDescriptor["role"];
  name: string;
  nearText: string;
  structuralPath: string;
  value?: string;
  options?: string[]; // for selects
}

export interface Snapshot {
  url: string;
  title: string;
  visibleText: string; // trimmed, for outcome detection + model context
  elements: ObservedElement[];
}
