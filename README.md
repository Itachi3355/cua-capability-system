# Computer-Use Capability System

An LLM discovers how to complete a task in a real UI. The successful run is
recorded as a typed, parameterized **capability artifact**. The artifact then
replays **deterministically** — no model in the loop — with explicit handling
for runtime errors, business outcomes, and human escalation.

See [REPORT.md](REPORT.md) for design and trade-offs.

## Stack

TypeScript / Node 20+, Playwright (Chromium), Anthropic API (discovery only),
Zod (schemas). Single process, no services, no build step (`tsx`).

The target application is a local mock of a legacy credit-union back-office
console (`target-app/`): server-rendered, nested-table layout, no test IDs, no
semantic classes — plus endpoints that inject runtime failures (session
expiry, slowness) to exercise the replay engine.

## Setup

```bash
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=sk-ant-...   # needed for discovery only; replay never calls a model
```

## Demo path

**1. Start the target app** (keep it running in its own terminal):

```bash
npm run target-app
```

**2. Discovery — the LLM works out the flow** (opens a headful browser you can watch):

```bash
npm run discover -- --goal "Look up the member by their member number and report their current savings account balance" --url http://localhost:4173 --app "Meridian CU Teller Console" --param member_id=12345 --desc "member_id=The member number to look up"
```

This produces `artifacts/<name>.v1.json` (approval: draft) and a full evidence
trail under `evidence/discovery-*/` (JSONL log of every observation, model
decision, and action, plus screenshots).

**3. Replay — deterministic, no LLM, new inputs:**

```bash
npm run replay -- --artifact artifacts/lookup_member_savings_balance.v1.json --param member_id=23456
```

**4. Replay hitting a business outcome** (unknown member — a legitimate answer, not a crash):

```bash
npm run replay -- --artifact artifacts/lookup_member_savings_balance.v1.json --param member_id=99999
```

**5. Replay through an injected runtime failure** (session-expiry interstitial appears mid-flow; a recovery rule dismisses it):

```bash
curl -X POST http://localhost:4173/admin/inject/session-timeout
npm run replay -- --artifact artifacts/lookup_member_savings_balance.v1.json --param member_id=12345
```

**6. Escalation / human takeover:** replay an artifact against a state it
cannot handle (e.g. edit a step's target name to something that doesn't exist,
or discover a flow with a risky `Confirm` step). The run pauses, prints an
intervention request, and the live headful browser window becomes yours;
perform the step manually and press ENTER in the terminal to hand control
back. Your actions are captured in the run log.

A risky-step flow to try end to end:

```bash
npm run discover -- --goal "Open a new Money Market sub-account nicknamed 'Vacation Fund' for the member and reach the confirmation screen" --url http://localhost:4173 --app "Meridian CU Teller Console" --param member_id=12345 --desc "member_id=The member number"
# The 'Confirm and Open Account' click is risky: discovery asks the live operator y/N.
# Replays of a risky artifact are blocked until it is reviewed and approved:
npm run replay -- --artifact artifacts/<name>.v1.json --param member_id=23456           # -> preflight failure (draft)
npx tsx src/cli.ts approve --artifact artifacts/<name>.v1.json
npm run replay -- --artifact artifacts/<name>.v1.json --param member_id=23456 --allow-risky
```

## Running without live services

No API key is needed for anything except discovery. The replay engine, locator
strategy, outcome detection, and recovery handling are covered by a no-LLM
test suite that replays a hand-written artifact against the mock app:

```bash
npm test
```

## Other commands

```bash
npm run list                          # catalog of saved capabilities (name, params, outputs, approval)
npx tsx src/cli.ts approve --artifact artifacts/x.json
# flags: --headless (both), --no-escalate / --allow-risky / --slow [ms] (replay), --max-steps / --model (discovery)
```

## Layout

```
target-app/       the mock legacy banking app (stand-in target)
src/types.ts      artifact schema + result contract (Zod) — start here
src/surface.ts    Surface seam (perceive/act) + Playwright impl + locator resolution
src/agent.ts      LLM discovery loop + recorder
src/replay.ts     deterministic replay engine (no LLM imports)
src/policy.ts     allowlist, risky-action classification, redaction
src/escalate.ts   human intervention: pause, cede live session, capture, resume
src/cli.ts        discover | replay | approve | list
artifacts/        saved capabilities
evidence/         per-run logs + screenshots (discovery and replay)
tests/            locator unit tests + no-LLM replay smoke test
policy.json       guardrail configuration
```
