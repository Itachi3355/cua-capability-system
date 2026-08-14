# Evidence Index

Artifact under test: `../artifacts/lookup_member_savings_balance.v1.json` (recorded by the discovery run below, then human-reviewed: outcome-detector text corrected to the app's actual copy, recovery rule corrected to the real interstitial control — the draft-review workflow described in REPORT.md §2).

## `discovery-2026-08-14T18-29-13-018Z`
LLM discovery run (claude-sonnet-5, headless): goal 'look up member savings balance', member_id=12345. Includes full JSONL transcript of observations/decisions/actions, screenshots, and the recorded artifact. Note the rejected first finish call (success condition embedded run data) and the model narrowing extraction with cell_index.

## `replay-2026-08-14T18-30-04-449Z`
Deterministic replay, member_id=23456 (different member than recorded) -> success, savings_balance=$612.40. Demonstrates locator generalization across data (result-row link matched by nearText anchor, not recorded name).

## `replay-2026-08-14T18-30-09-413Z`
Deterministic replay, member_id=99999 (unknown member) -> status=business_outcome, outcomeCode=member_not_found. A legitimate business answer, not a failure.

## `replay-2026-08-14T18-33-58-801Z`
Deterministic replay, member_id=12345 with an injected session-expiry interstitial mid-flow -> recovery rule 'session_expired' dismissed it, run completed with status=success.
