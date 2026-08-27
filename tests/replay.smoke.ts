// No-LLM smoke test: replays a hand-written artifact against the live mock
// app across four scenarios. Exercises cross-data locator generalization,
// business-outcome detection, and interstitial recovery.
import { spawn } from "node:child_process";
import fs from "node:fs";
import assert from "node:assert";
import { Artifact as ArtifactSchema } from "../src/types.js";
import { loadPolicy } from "../src/policy.js";
import { replayArtifact } from "../src/replay.js";

const BASE = "http://localhost:4173";

async function waitForServer(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + "/");
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("mock app did not start");
}

async function main() {
  const server = spawn(process.execPath, ["target-app/server.js"], { stdio: "ignore" });
  try {
    await waitForServer();
    const artifact = ArtifactSchema.parse(
      JSON.parse(fs.readFileSync("tests/fixtures/lookup_member_savings_balance.v1.json", "utf8"))
    );
    const policy = loadPolicy("policy.json");
    const base = { policy, headful: false, allowRisky: false, escalate: false, evidenceBase: "evidence/tmp" };

    console.log("\n-- scenario 1: happy path (recorded member) --");
    const r1 = await replayArtifact(artifact, { ...base, params: { member_id: "12345" } });
    assert.strictEqual(r1.status, "success");
    assert.strictEqual(r1.outputs.savings_balance, "$4,821.77");

    console.log("\n-- scenario 2: different member (locators must generalize) --");
    const r2 = await replayArtifact(artifact, { ...base, params: { member_id: "23456" } });
    assert.strictEqual(r2.status, "success");
    assert.strictEqual(r2.outputs.savings_balance, "$612.40");

    console.log("\n-- scenario 3: unknown member -> business outcome, not a crash --");
    const r3 = await replayArtifact(artifact, { ...base, params: { member_id: "99999" } });
    assert.strictEqual(r3.status, "business_outcome");
    assert.strictEqual(r3.outcomeCode, "member_not_found");

    console.log("\n-- scenario 4: session-expiry interstitial -> recovery rule --");
    await fetch(BASE + "/admin/inject/session-timeout", { method: "POST" });
    const r4 = await replayArtifact(artifact, { ...base, params: { member_id: "12345" } });
    assert.strictEqual(r4.status, "success");
    assert.strictEqual(r4.outputs.savings_balance, "$4,821.77");

    console.log("\n-- scenario 5: navigation outside the allowlist is refused --");
    const offOrigin = structuredClone(artifact);
    offOrigin.steps[0] = { ...offOrigin.steps[0], url: "https://example.com/members" } as typeof offOrigin.steps[0];
    const r5 = await replayArtifact(offOrigin, { ...base, params: { member_id: "12345" } });
    assert.strictEqual(r5.status, "failure");
    assert.match(r5.error!.expected, /allowed origins/);
    assert.strictEqual(r5.error!.observed, "https://example.com/members");

    console.log("\n-- scenario 6: a sensitive parameter never reaches disk --");
    const sensitive = structuredClone(artifact);
    sensitive.params[0].sensitive = true;
    const secret = "12345";
    const r6 = await replayArtifact(sensitive, { ...base, params: { member_id: secret } });
    assert.strictEqual(r6.status, "success");
    assert.strictEqual(r6.outputs.savings_balance, "$4,821.77"); // still does its job
    for (const file of ["log.jsonl", "result.json"]) {
      const written = fs.readFileSync(`${r6.evidenceDir}/${file}`, "utf8");
      assert(!written.includes(secret), `${file} leaked the sensitive parameter value`);
    }
    assert(
      fs.readFileSync(`${r6.evidenceDir}/log.jsonl`, "utf8").includes("«redacted»"),
      "expected the mask in the log"
    );

    console.log("\nreplay.smoke.ts: all scenarios passed");
  } finally {
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
