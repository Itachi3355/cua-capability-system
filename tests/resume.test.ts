import assert from "node:assert";
import { coerceOutput, resumeTarget } from "../src/replay.js";
import type { Step } from "../src/types.js";

// Minimal step builders. `expect` presence is what matters to resumeTarget.
const click = (id: string, checkpoint?: string): Step =>
  ({ id, action: "click", intent: id, timeoutMs: 1000, risky: false,
     target: { role: "button", name: id },
     ...(checkpoint ? { expect: { urlContains: checkpoint } } : {}) }) as Step;
const type_ = (id: string): Step =>
  ({ id, action: "type", intent: id, timeoutMs: 1000, sensitive: false, value: "x",
     target: { role: "textbox", name: id } }) as Step;
const extract = (id: string, output: string): Step =>
  ({ id, action: "extract", intent: id, timeoutMs: 1000, anchor: "A", output }) as Step;

// `satisfied` stands in for evaluating a checkpoint against the live page:
// the named steps are the ones whose checkpoint currently holds.
const holds = (...ids: string[]) => (s: Step) => ids.includes(s.id);

// 1. human completes the current (checkpointed) step -> resume at the next one
{
  const steps = [click("s0", "/a"), click("s1", "/b"), click("s2", "/c")];
  assert.strictEqual(resumeTarget(steps, 1, holds("s1")), 1);
}

// 2. human changes state but satisfies nothing -> re-attempt the stuck step
{
  const steps = [click("s0", "/a"), click("s1", "/b"), click("s2", "/c")];
  assert.strictEqual(resumeTarget(steps, 1, holds()), -1);
}

// 3. stuck step has no checkpoint and the human did nothing -> re-attempt,
//    never assume done (the silent-skip bug)
{
  const steps = [click("s0", "/a"), type_("s1"), click("s2", "/c")];
  assert.strictEqual(resumeTarget(steps, 1, holds()), -1);
}

// 4. human completes several future steps -> fast-forward to the furthest
{
  const steps = [click("s0", "/a"), click("s1", "/b"), click("s2", "/c"), click("s3", "/d")];
  assert.strictEqual(resumeTarget(steps, 1, holds("s2", "s3")), 3);
}

// 5. human reaches the final state -> resume after the last step
{
  const steps = [click("s0", "/a"), click("s1", "/b"), click("s2", "/c")];
  assert.strictEqual(resumeTarget(steps, 0, holds("s2")), 2);
  assert.strictEqual(steps[2 + 1], undefined); // caller reports "(end)"
}

// 6. checkpoint AFTER an extract: never fast-forward past the extract, or the
//    declared output would be missing from the result
{
  const steps = [click("s0", "/a"), click("s1", "/b"), extract("s2", "bal"), click("s3", "/d")];
  // stuck step itself unsatisfied -> no fast-forward at all
  assert.strictEqual(resumeTarget(steps, 1, holds("s3")), -1);
  // stuck step satisfied -> stop just before the extract so it still runs
  assert.strictEqual(resumeTarget(steps, 1, holds("s1", "s3")), 1);
}

// 7. extract AFTER the resume checkpoint is untouched by the clamp
{
  const steps = [click("s0", "/a"), click("s1", "/b"), click("s2", "/c"), extract("s3", "bal")];
  assert.strictEqual(resumeTarget(steps, 1, holds("s2")), 2);
}

// 8. multiple extracts between -> clamp to the first one
{
  const steps = [
    click("s0", "/a"), click("s1", "/b"),
    extract("s2", "one"), extract("s3", "two"), click("s4", "/e"),
  ];
  assert.strictEqual(resumeTarget(steps, 1, holds("s1", "s4")), 1);
  assert.strictEqual(resumeTarget(steps, 1, holds("s4")), -1);
}

// 9. a checkpointless step is never selected as a resume target
{
  const steps = [click("s0", "/a"), click("s1", "/b"), type_("s2")];
  assert.strictEqual(resumeTarget(steps, 1, holds("s2")), -1);
}

// --- declared output types are enforced ---
assert.strictEqual(coerceOutput("$15,002.66", "string", "bal"), "$15,002.66");
assert.strictEqual(coerceOutput("$15,002.66", "number", "bal"), 15002.66);
assert.strictEqual(coerceOutput("-42", "number", "bal"), -42);
assert.throws(() => coerceOutput("N/A", "number", "bal"), /declared number/);
assert.throws(() => coerceOutput("", "number", "bal"), /declared number/);
assert.throws(() => coerceOutput("12 units", "number", "bal"), /declared number/);

console.log("resume.test.ts: all assertions passed");
