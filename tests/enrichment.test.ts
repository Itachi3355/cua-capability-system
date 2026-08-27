import assert from "node:assert";
import { distinctiveFragment, filterEnrichment, sentinelFor } from "../src/agent.js";

// --- enrichment validation (regression from a real clean-checkout run) ---
{
  const successPage =
    "Member #: 12345 Name: Margaret Chen Accounts Type Account # Balance Savings SV-4471 $4,821.77";
  const outcomes = [
    { code: "member_not_found", description: "", when: { textVisible: "No members matched" } },
    // The detector that broke a real run: "Accounts" is a heading on every
    // member page, so this would classify every success as a business outcome.
    { code: "no_savings_account", description: "", when: { textVisible: "Accounts" } },
  ];
  const recoveries = [
    { id: "session_expired", description: "", when: { textVisible: "session has expired" },
      do: { click: { role: "link" as const, name: "Continue session" } }, maxAttempts: 1 },
    { id: "bogus", description: "", when: { textVisible: "Balance" },
      do: { click: { role: "button" as const, name: "OK" } }, maxAttempts: 1 },
  ];
  const out = filterEnrichment(outcomes as any, recoveries as any, successPage, (s) => s);
  assert.deepStrictEqual(out.outcomes.map((o) => o.code), ["member_not_found"]);
  assert.deepStrictEqual(out.recoveries.map((r) => r.id), ["session_expired"]);
  assert.strictEqual(out.rejected.length, 2);
  assert(out.rejected.every((r) => r.reason.includes("success page")));
}

// detectors are compared after parameter substitution
{
  const out = filterEnrichment(
    [{ code: "x", description: "", when: { textVisible: "member {{member_id}}" } }] as any,
    [],
    "Member 12345 detail",
    (s) => s.split("{{member_id}}").join("12345")
  );
  assert.strictEqual(out.outcomes.length, 0);
}

// --- negative-path probe helpers ---

// sentinels keep the recorded shape but are improbable enough not to exist
assert.strictEqual(sentinelFor("12345"), "99999999");
assert.strictEqual(sentinelFor("7"), "99999999");
assert.strictEqual(sentinelFor("AB-99"), "zzz-no-such-value-zzz");

{
  const success =
    "Meridian CU Home | Member Search Member #: 12345 Name: Margaret Chen Accounts Savings SV-4471 $4,821.77 For internal use only.";
  const probe =
    "Meridian CU Home | Member Search Member # or Name: 99999999 Search No members matched your search. Verify the member number and try again. For internal use only.";

  // the fragment is text the failure page has and the success page does not
  const fragment = distinctiveFragment(probe, success, ["99999999"]);
  assert(fragment, "expected a distinctive fragment");
  assert(probe.includes(fragment!));
  assert(!success.includes(fragment!));

  // and it must never carry the sentinel, or the detector could not match a
  // real caller's input
  assert(!fragment!.includes("99999999"));

  // a probe page indistinguishable from success yields nothing rather than a
  // detector that would fire on the happy path
  assert.strictEqual(distinctiveFragment(success, success, []), undefined);
}

console.log("enrichment.test.ts: all assertions passed");
