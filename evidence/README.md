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

## `discovery-2026-08-14T18-43-13-110Z`
LLM discovery run: goal 'open a Money Market sub-account nicknamed Vacation Fund, reach confirmation', member_id=12345. The 'Confirm and Open Account' click was classified risky by policy and required live operator approval (see risky.confirmation_requested / risky.confirmation_result in the log). Artifact recorded with the confirm step flagged `risky: true`, then human-reviewed: reference-number extract step and output added, detectors corrected/pruned.

## `replay-2026-08-14T18-44-40-087Z`
Approval-gate demonstration: replay of the risky artifact while still `draft` (even with --allow-risky) -> preflight failure with a structured error naming the gate. No browser was launched; the block happens before any UI contact.

## `replay-2026-08-14T18-45-15-028Z`
After `approve`: replay with --allow-risky for member_id=23456 -> success, reference_number=SA-70212. Risky step s9 logged as executing under the approved+allowRisky gate.

## `replay-2026-08-14T19-20-34-294Z`
Live human escalation and handoff. The artifact is a deliberately sabotaged copy (`artifacts/_escalation_demo.json`: step s3's target renamed/re-anchored so no locator strategy can resolve it). Replay stuck at s3 -> intervention raised with capability, step, reason, URL, and screenshot; controller transferred to the human on the same live browser window. The operator's actions were captured across the handoff (set search field, click Search), the step's checkpoint was then verified as satisfied, and automation resumed at s4 and completed. Final status `escalated` with humanActions, resumedAtStep, and the extracted output.

Note: earlier iterations of this demo drove three hardening changes now in the engine — navigation-proof action capture, resume-at-furthest-satisfied-checkpoint (an operator who works past the stuck step no longer causes an escalation loop), and bounded escalations per step with an operator abort channel.

## `replay-2026-08-14T19-37-00-070Z`
Bounded escalation: same sabotaged artifact, but the operator handed control back twice (ENTER) without resolving the step. After the per-step intervention cap (2), the run ended as a clean hard failure — `unresolved after 2 human interventions` — with per-intervention screenshots, instead of escalating forever.

## `replay-2026-08-27T03-44-57-890Z`
Post-cleanup determinism check: the same capability replayed for a third member (34567, `$15,002.66`) *after* the structural-path policy stripped 11 DOM fingerprints from the saved artifacts. Semantic descriptors alone resolved every control — evidence that the retained locators, not the removed structural paths, were doing the work.

## `discovery-2026-08-27T16-51-16-190Z`
Discovery with both self-correction mechanisms visible in one run, and the artifact it produced is the one committed in `artifacts/` — no hand-editing.

- `enrichment.rejected`: the model proposed an outcome detector keyed on "Accounts", a heading present on every member page. It would have classified every successful replay as a business outcome. Rejected automatically because its text appears on the observed success page.
- `probe.detector_observed`: the recorder then replayed its own flow with a sentinel member number (`99999999`), landed on the real not-found screen, and derived `member_not_found` from text observed there — replacing the model's guess ("No members found", which the app never prints). The nested `replay-*` directory is the probe run's own evidence.

Replays of that artifact: member 23456 -> success `$612.40`; member 34567 -> success `$15,002.66`; member 99999 -> `business_outcome` / `member_not_found`.

## `replay-2026-08-27T16-52-06-437Z`, `-09-219Z`, `-11-946Z`
The three verification replays of that same freshly recorded artifact, in order: member 23456 -> `success` with `savings_balance: "$612.40"`; member 99999 -> `business_outcome` with `outcomeCode: member_not_found`; member 34567 -> `success` with `savings_balance: "$15,002.66"`.

Together these are the point of the whole system: one LLM discovery run, then deterministic replays that generalize to inputs the model never saw and classify a missing record as an answer rather than a crash — with no model in the loop and no hand-editing of the artifact.
