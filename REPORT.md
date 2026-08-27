# Design Report

## 1. Architecture

Single Node/TypeScript process, four load-bearing modules around one seam:

```
goal ──> agent.ts (LLM loop + recorder) ──> artifact.json ──> replay.ts (no LLM)
              │                                                    │
              └────────────── surface.ts (Surface seam) ───────────┘
                                       │
                              Playwright / Chromium
                          (policy.ts + escalate.ts cut across both paths)
```

- **`Surface`** is the only thing that touches a UI. Both discovery and replay
  see the same contract: *enumerate controls as role/name/nearby-text
  descriptors; act on a control by handle*. This is the seam that keeps every
  other module surface-agnostic (see §4).
- **Discovery** runs an observe → decide → act tool-use loop (Anthropic API).
  Every executed action is simultaneously recorded as a replayable step. The
  artifact is built from *what was done to the UI*, not from the model
  transcript — the transcript is evidence, the artifact is the product.
- **Replay** imports no LLM code at all (enforced by module boundary: `replay.ts`
  has no model dependency). Given artifact + params it executes steps,
  verifies checkpoints, and classifies anything unexpected (§3).
- **Policy and escalation** are shared: the same allowlist gate runs before
  every action in both paths, and both paths can hand the live session to a
  human.

Key trade-offs: one process and JSON-on-disk storage instead of services and a
DB (nothing in the problem needs concurrent writers yet — the artifact store
is a directory that could become a table without touching the schema). CLI
instead of an API server (the invocation contract is the artifact schema, not
the transport). Chromium via Playwright as the concrete surface because it
gives both a DOM to enumerate *and* a real window a human can take over.

I deliberately did **not** use Playwright's selector engine as the locator
model — recording `page.click("td > a")`-style selectors would have tied
artifacts to a DOM-shaped world and to Playwright itself. Locators are
semantic descriptors resolved by our own scoring (§3), and Playwright is just
the actuator, which is what keeps the desktop story credible (§4).

## 2. Artifact schema

`src/types.ts` is the focal file. Shape, and why:

- **Contract first**: `name`, `description`, typed `params` (with `sensitive`
  flags) and typed `outputs`. A calling agent — or a human reviewer — can read
  what the capability does, what it needs, and what it returns without reading
  the steps. This is what makes it a *capability* rather than a macro.
- **Steps** are a small discriminated union (`navigate | click | type | select |
  extract`), each carrying a human-readable `intent` (written at record time —
  this is what makes review meaningful), an optional per-step `expect`
  checkpoint, and a timeout. Values are templates (`{{member_id}}`), never the
  concrete values from the discovery run — the recorder templatizes parameter
  values back out of URLs, inputs, and expectations, so one run yields a
  parameterized capability, not a replay of one member's data.
- **Element targets** are perceptual descriptors — `role` + accessible-name
  approximation + nearby label text + tie-breaking `nth` — with a structural
  path kept only as a flagged last resort. Reasoning: in legacy apps the
  markup is hostile but what an *operator perceives* is stable; that is also
  exactly the representation an accessibility-tree or OCR surface can produce.
- **`outcomes` and `recoveries` live in the artifact**, not in code. "No such
  member" detection and "dismiss the session-expiry interstitial" are
  app-specific knowledge; putting them in the reviewable artifact means a
  human can audit and extend them, and replay stays generic. Discovery seeds
  them with one post-run model call (config generated once and reviewed — not
  a model in the replay loop).
- **`approval: draft | approved`** gates unattended/risky replay; `version`,
  `schemaVersion`, and `provenance` (which run, which model, which goal) make
  artifacts diffable and auditable.
- The **result contract** (`ReplayResult`) is part of the schema file on
  purpose: `success | business_outcome | escalated | failure`, with outputs,
  outcome code, or step-level error detail (expected vs observed vs
  screenshot). The caller's world is four statuses, each actionable.

## 3. Determinism & error handling

Replay is deterministic in the decision sense: same artifact + same inputs →
same action sequence, with no model choosing anything. Waiting is bounded
polling against explicit conditions, not sleeps.

**Structural paths are recorded sparingly.** A tag-chain path is a DOM
fingerprint — the least portable thing available and the first casualty of a
cosmetic template change. It is persisted only where perceptual identity is
genuinely weak: ties at record time (`nth` was needed) or a stable name under
three characters (`q`, or a name that is purely `{{param}}`). Everything with a
real label keeps role + name + nearText alone. A `clean-artifacts` CLI pass
applies the same policy to artifacts recorded earlier; it is never applied
silently on load, because the saved artifact is the contract a caller replays.
When a retained structural path *is* used, `locator.structural_fallback` still
fires as the drift tripwire.

**Locator resolution** (`resolveDescriptor`): candidates are scored — exact
accessible-name match > substantial partial match > exact nearby-text anchor
(for data-dependent names like a result row's link text, which legitimately
differs per input). A clear score winner is taken; a *tie* at the top score is
an explicit `ambiguous` error unless the recorded `nth` disambiguates — the
failure mode we refuse is silently picking among equals. The structural
path is used only when semantic matching fails, and its use is logged as a
degradation signal (that's the drift tripwire: a structural-fallback spike on
an artifact means the UI changed and the artifact needs re-recording or
review).

**Every stuck point runs the same three-way classification:**

1. **Known business outcome** — outcome detectors (from the artifact) match
   the current screen → terminal `business_outcome` with a code the caller
   can act on. "No members matched" is an answer, not a crash.
2. **Recoverable condition** — a recovery rule matches (e.g. session-expiry
   interstitial) → one bounded, deterministic action (click a named control),
   then retry the step. Transient slowness is handled below this layer by
   bounded waits and one retry.
3. **Hard failure** — neither matches → structured error: which step, what
   was expected, what was observed, screenshot; or escalation to a human if
   an operator is attached (§5).

Checkpoints exist at three levels: per-step `expect` (URL/text/element
postconditions recorded during discovery), outcome detectors evaluated during
every wait loop, and a final success condition that the discovery agent had to
prove *against the live page* before its `finish` was accepted — the model
cannot declare unverifiable success.

UI drift is secondarily handled by the same machinery: semantic-first matching
absorbs cosmetic changes (markup restructuring, styling, reordering), and the
structural-fallback log line is the early-warning signal for real drift.

## 4. Heterogeneity & multi-tenant

**Surface abstraction.** The seam is `Surface`: *perceive* (enumerate controls
as role/name/nearText descriptors + page text) and *act* (click/type/select/read
by handle). Artifacts contain only descriptors — nothing DOM-specific. A
legacy web app with framesets is the same implementation walking frames; a
desktop app is a new implementation backed by the OS accessibility tree
(UIA/AX), which naturally produces role + name + neighbor text — the exact
descriptor vocabulary — or, worst case, screenshot+OCR producing the same. The
artifact schema, replay engine, policy, and escalation don't change; that was
the point of scoring locators ourselves rather than delegating to a browser
selector engine.

**Multi-tenant reuse.** Not built; designed for: an artifact recorded on one
tenant of a vendor product is the *base*; a tenant binding is `(base artifact
id + version, overrides)`, where overrides patch exactly the fields that vary
per tenant — `app.baseUrl`, individual step descriptors (renamed/branded
controls), outcome detector strings. Because steps and descriptors are typed
data, overrides are small reviewable diffs, not re-recordings. Drift
management falls out of signals replay already emits per tenant: structural
fallback rate, recovery-rule hit rate, and failure-at-step distribution. A
tenant whose runs degrade gets flagged for re-validation of its binding;
`schemaVersion` + artifact `version` make the rollout of a re-recorded base
explicit rather than silent.

## 5. Escalation & handoff

**Detecting stuck** is the residual of §3: the discovery agent calls
`give_up`, or a replay step exhausts outcome/recovery/retry classification.
Risky steps are a third trigger (§6).

**Control-transfer model**: a run has exactly one controller, `automation |
human`. On escalation the system raises an intervention request carrying the
capability/goal, the stuck step, why it stopped, the current URL, and a
screenshot (also persisted as `intervention.json`); automation stops acting;
the *same live session* — runs are headful, so the browser window on the
operator's desk is the takeover surface, no second session and no state
cloning — belongs to the human. Injected DOM listeners record what the human
does (clicks, field changes; password field values are never captured). The
operator signals completion in the terminal; control returns to automation,
which **re-verifies rather than resumes blindly**: if the stuck step's
postcondition now holds, the human completed it — skip ahead; otherwise
re-attempt it with fresh classification. In discovery, the model receives a
fresh observation after the handoff and continues.

The operator console is deliberately a terminal prompt plus the live browser
window — mocked thin, as the brief allows. What is production-real and
transport-independent: the control state machine, the intervention payload,
action capture, and verify-and-resume, all behind `requestIntervention()`
(which already accepts a programmatic resume/abort signal alongside the TTY).
What is *not* free: remote takeover of a headless session is a genuinely
different transport (CDP screencast / VNC-style co-browsing) that would need
building behind that same seam — the seam localizes the work, it doesn't
eliminate it.

## 6. Safety

- **Allowlist** (`policy.json`): permitted origins and permitted action types,
  enforced at the single choke point both paths share — every navigation and
  every action, discovery and replay alike. The model never gets a chance to
  act outside it; a blocked action returns to the loop as an error.
- **Risky actions** are classified by control-name patterns (confirm, delete,
  transfer, open account…). Discovery: a live operator must approve each risky
  click (y/N). Replay: risky artifacts refuse to run at all — preflight, before
  the browser opens — unless the artifact has been human-`approved` *and* the
  caller passes `--allow-risky`. Two independent, deliberate acts.
- **Redaction**: parameters marked sensitive never enter the model's context
  (the model types a `{{placeholder}}`; substitution happens in the executor),
  never appear in logs or artifacts (masked at every write), and password
  field values are excluded from human-action capture.
- **Limits, honestly**: name-pattern risk classification misses risky controls
  with bland labels — real deployment needs per-app risk annotations in the
  artifact (reviewable, like outcomes). Screenshots are not redacted, so
  evidence for flows over regulated data needs masked capture or encrypted
  storage. The allowlist is origin-granular, not route-granular. Literal-match
  redaction skips values under 3 characters and would need format-aware
  matching (account-number patterns, etc.) for production. Anchor-based
  extraction handles labeled same-row layouts; cross-row and deeply nested
  label/value arrangements need a richer region model. All of these are
  config- or module-shaped extensions, not redesigns.

## 7. Cuts

Cut deliberately, with the seam noted:

- **Operator console UI** — terminal + live browser instead; seam is
  `requestIntervention()` (§5).
- **Desktop/legacy-frameset surface** — one Playwright `Surface`; seam and
  extension story in §4.
- **Multi-tenant overrides** — designed (§4), not implemented; the schema
  fields it needs (versioning, typed descriptors) already exist.
- **Artifact storage** — files, not a DB; the store's interface is "read/write
  artifact JSON by name+version".
- **Structured output types** — outputs are strings; a `format`/parse field
  per output (currency, date) is the obvious next step.
- **Screenshot redaction** — see §6 limits.

Next, in order: (1) confidence & approval workflow — track per-artifact replay
stability (structural-fallback rate, retries, failures) and gate promotion
draft → approved on evidence, not just review; (2) assisted fallback — on a
failed step, a single policy-checked LLM call proposing one re-anchored
locator, recorded as evidence and requiring review, never silent; (3) route-
granular allowlists and per-step risk annotations.
