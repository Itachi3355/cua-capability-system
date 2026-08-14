import fs from "node:fs";
import { z } from "zod";
import type { Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Policy — the guardrail configuration. Enforced identically in discovery and
// replay: every navigation and every action passes through checkPolicy before
// it touches the surface.
// ---------------------------------------------------------------------------
const PolicyFile = z.object({
  // Origins the automation may operate on. Navigation or actions anywhere
  // else are blocked outright.
  allowedOrigins: z.array(z.string()),
  // Action types the automation may perform at all.
  allowedActions: z.array(z.enum(["navigate", "click", "type", "select", "extract"])),
  // Control-name patterns that mark a click as risky/irreversible.
  // Risky clicks: discovery -> requires live operator confirmation;
  // replay -> requires artifact.approval === "approved" AND --allow-risky.
  riskyNamePatterns: z.array(z.string()),
  redaction: z.object({
    // Log placeholder for sensitive values.
    mask: z.string().default("«redacted»"),
  }),
});
export type Policy = z.infer<typeof PolicyFile>;

export function loadPolicy(path: string): Policy {
  return PolicyFile.parse(JSON.parse(fs.readFileSync(path, "utf8")));
}

export function originAllowed(policy: Policy, url: string): boolean {
  try {
    const origin = new URL(url).origin;
    return policy.allowedOrigins.includes(origin);
  } catch {
    return false;
  }
}

export function actionAllowed(policy: Policy, action: string): boolean {
  return (policy.allowedActions as string[]).includes(action);
}

export function isRiskyName(policy: Policy, name: string): boolean {
  const n = name.toLowerCase();
  return policy.riskyNamePatterns.some((p) => n.includes(p.toLowerCase()));
}

// Replace occurrences of sensitive values in any string destined for
// logs/artifacts/model context. Values are matched literally.
export function redact(text: string, sensitiveValues: string[], mask: string): string {
  let out = text;
  for (const v of sensitiveValues) {
    if (v && v.length >= 3) out = out.split(v).join(mask);
  }
  return out;
}

export function redactSnapshot(snap: Snapshot, sensitiveValues: string[], mask: string): Snapshot {
  const r = (s: string) => redact(s, sensitiveValues, mask);
  return {
    ...snap,
    visibleText: r(snap.visibleText),
    elements: snap.elements.map((el) => ({
      ...el,
      name: r(el.name),
      nearText: r(el.nearText),
      value: el.value !== undefined ? r(el.value) : undefined,
    })),
  };
}
