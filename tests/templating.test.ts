import assert from "node:assert";
import { substitute, templatize } from "../src/templating.js";

const P = { member_id: "12" };

// --- boundary semantics: a short value must template only whole tokens ---
const cases: [string, string][] = [
  ["12", "{{member_id}}"],                       // whole string
  ["(12)", "({{member_id}})"],                   // parenthesised
  ["12,", "{{member_id}},"],                     // trailing comma
  ["12.", "{{member_id}}."],                     // trailing period
  ['"12"', '"{{member_id}}"'],                   // quoted
  ["member=12", "member={{member_id}}"],         // query value
  ["12-foo", "{{member_id}}-foo"],               // hyphen is a boundary
  ["foo-12", "foo-{{member_id}}"],
  ["/members/12/edit", "/members/{{member_id}}/edit"],
  ["abc12", "abc12"],                            // embedded — must NOT template
  ["12abc", "12abc"],
  ["120", "120"],                                // the Branch 120 case
  ["Branch 120", "Branch 120"],
  ["x12x", "x12x"],
  ["12 12", "{{member_id}} {{member_id}}"],      // every standalone occurrence
];
for (const [input, expected] of cases) {
  assert.strictEqual(templatize(input, P), expected, `templatize(${JSON.stringify(input)})`);
}

// round trip restores the original for the recorded value
for (const [input] of cases) {
  assert.strictEqual(substitute(templatize(input, P), P), input, `round trip ${JSON.stringify(input)}`);
}

// a longer value parameterizes the artifact for a different caller value
assert.strictEqual(
  substitute(templatize("/members/12345?tab=1", { member_id: "12345" }), { member_id: "23456" }),
  "/members/23456?tab=1"
);

// empty values are skipped rather than matching everywhere
assert.strictEqual(templatize("anything", { nothing: "" }), "anything");

// substitution leaves unknown placeholders untouched (visible, not silently blanked)
assert.strictEqual(substitute("/x/{{other}}", P), "/x/{{other}}");

console.log("templating.test.ts: all assertions passed");
