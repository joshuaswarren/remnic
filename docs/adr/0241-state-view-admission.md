# State-view recall surfaces superseded records only as complete, namespace-qualified evidence packets judged against the original prompt

Status: accepted

## Context
Memory stores supersede facts over time. A plain recall shows only the winning row, so an agent can answer from a stale fact without knowing it changed; conversely, showing superseded rows alone hides what replaced them. Namespace fanout can surface the same id under several namespaces, cron policies normalize the retrieval query away from what the user actually asked, and audit anomaly counts must not miscount cross-namespace leakage.

Scope note: This file merges the state-view theme with the recall-audit-anomaly namespace-sentinel theme and adjacent admission rules: all are rules about which memories may enter (or be reported about) a recall result.

## Decision
When change intent is detected, a recall composes state-view packets: a superseded record never appears without its successor — predecessor/successor pairs reconcile to a fixpoint, and rows whose successor is not in the pool are dropped BEFORE the user cap/MMR runs. Identity is namespace-qualified (`namespace\0id`): the same id under a different namespace is not a predecessor, and a successor's `supersedes` back-pointer anchors its predecessor; precedence is explicit chains, then back-pointers. Change intent is classified from the ORIGINAL prompt, never the cron-normalized retrievalQuery, and the effective per-request flag (per-call stateView OR config) is computed once at recall entry and threaded to the final annotation. Under a historical asOf pin the pool is never widened and pair/packet caps do not apply: the pipeline's isValidAsOf gate already decided validity, and the asOf boundary is the fact's validity flip (invalidAt), not the supersededAt write time. Phrase matching for change intent is token-bounded ("when Didi" must not fire "when did"; "confused to" must not fire "used to"), and bare before/after carry intent only when pointing at a specific event through a determiner. Final output budgeting keeps packets atomic: a predecessor/successor chain admitted together is ONE evidence packet; blank-key rows stay distinct singletons. Anomaly counting treats unprefixed candidate ids (older filename-sourced entries) under a reserved sentinel namespace so they still contribute when a trail is all-unprefixed, flags a mixed prefixed/unprefixed result list as suspicious (possible cross-tenant leak), preserves original indices when filtering to the active window, and floors fractional thresholds to prevent a flood-on-anything trigger. Map keys: no namespace → bare path (backward-compatible); namespaced → composite key so the same relative path across namespaces stays distinct. Event-order dedup keys on turn id only, keeping distinct turns with identical cue-appended bodies.

## Consequences
State-view recalls cost more rows than winner-only recall and require namespace-qualified bookkeeping everywhere; treating ids as globally unique would silently merge tenants. Anomaly reports over older filename-sourced trails depend on the sentinel namespace.

## Origin comments
(59 records)
- `packages/remnic-core/src/recall-audit-anomaly.ts:143` — "// Guard against fractional inputs (e.g. 0.5) that floor to 0 and"
- `packages/remnic-core/src/recall-audit-anomaly.ts:144` — "// turn every detector into a flood-on-anything trigger."
- `packages/remnic-core/src/recall-audit-anomaly.ts:181` — "// Filter to the active window, preserving original indices so flags"
- `packages/remnic-core/src/recall-audit-anomaly.ts:182` — "// can reference the caller's entries array directly."
- `packages/remnic-core/src/recall-audit-anomaly.ts:223` — "// Candidate IDs that begin with `<namespace>/` disclose the namespace"
- `packages/remnic-core/src/recall-audit-anomaly.ts:224` — "// directly. IDs without a slash prefix (e.g. bare filenames) do not"
- `packages/remnic-core/src/recall-audit-anomaly.ts:225` — "// disclose a namespace, but a recall whose result list mixes"
- `packages/remnic-core/src/recall-audit-anomaly.ts:226` — "// prefixed AND unprefixed IDs is itself suspicious — it suggests"
- `packages/remnic-core/src/recall-audit-anomaly.ts:227` — "// the backend leaked memories from both the caller's own namespace"
- `packages/remnic-core/src/recall-audit-anomaly.ts:228` — "// and named tenants. We track unprefixed IDs under a reserved"
- `packages/remnic-core/src/recall-audit-anomaly.ts:229` — "// sentinel namespace so they still contribute to the count when a"
- `packages/remnic-core/src/recall-audit-anomaly.ts:230` — "// trail is all-unprefixed (common for older audit entries sourced"
- `packages/remnic-core/src/recall-audit-anomaly.ts:231` — "// from filenames)."
- `packages/remnic-core/src/recall-memory-map.ts:4` — "// No namespace -> bare path (backward-compatible with path-keyed lookups)."
- `packages/remnic-core/src/recall-memory-map.ts:5` — "// Namespaced -> composite so the same relative path across namespaces stays distinct."
- `packages/remnic-core/src/recall-pipeline-stages.test.ts:234` — "// Event-order's rankAndSelectEventOrderItems deduplicates by turn id only and"
- `packages/remnic-core/src/recall-pipeline-stages.test.ts:235` — "// keeps distinct turns even when two turns share the same cue-appended body."
- `packages/remnic-core/src/recall-pipeline-stages.test.ts:236` — "// The spine must express that as a declared config field so PR 6's migration"
- `packages/remnic-core/src/recall-pipeline-stages.test.ts:237` — "// does not silently drop valid turns (cursor bugbot a4299851)."
- `packages/remnic-core/src/recall-state-view-admission.ts:1` — "Recall-internal state-view admission (issue #1952)... so recall-internal.ts stays under its ratchet ceiling"
- `packages/remnic-core/src/recall-state-view-admission.ts:15` — "#2893: query MUST be the ORIGINAL prompt, not the cron-normalized retrievalQuery"
- `packages/remnic-core/src/recall-state-view-admission.ts:34` — "Superseded-status filtering delegates to shouldFilterSupersededFromRecall so recent-scan and QMD filter share semantics"
- `packages/remnic-core/src/recall-state-view-anchors.ts:2` — "State-view anchor admission (#2859)... Identities are namespace\0id"
- `packages/remnic-core/src/recall-state-view-anchors.ts:21` — "#2859 — pair reconciliation and packet-counting caps apply only WITHOUT a historical pin"
- `packages/remnic-core/src/recall-state-view-anchors.ts:124` — "Recent-scan admission for the fallback path... PR #713 as_of authoritative historical gate"
- `packages/remnic-core/src/recall-state-view-asof.test.ts:1` — "issue #1952 historical-pinned state views... inject seam must not discard predecessor"
- `packages/remnic-core/src/recall-state-view-budget.test.ts:1` — "issue #2928. Final output budgeting must keep state-view packets atomic"
- `packages/remnic-core/src/recall-state-view-call.test.ts:1` — "issue #1952 per-call wiring... stateView boolean carries through the FINAL annotation"
- `packages/remnic-core/src/recall-state-view-cron-intent.test.ts:1` — "issue #2893. Cron recall policy normalizes the retrieval query"
- `packages/remnic-core/src/recall-state-view-packet.ts:1` — "Groups labeled state-view entries into per-head evidence packets so superseded records stay visible"
- `packages/remnic-core/src/recall-state-view-widen.test.ts:100` — "The threaded flag means change intent was already classified on the ORIGINAL prompt at recall entry"
- `packages/remnic-core/src/recall-state-view-widen.ts:23` — "#1952 — per-request effective flag (per-call stateView OR config...), computed once at recall entry and threaded"
- `packages/remnic-core/src/recall-state-view-widen.ts:31` — "#1952 — historical recall pin (epoch ms). When set, the pool is never widened"
- `packages/remnic-core/src/recall-state-view-widen.ts:47` — "#2893 — a threaded stateViewActive was gated on change intent classified from the ORIGINAL prompt"
- `packages/remnic-core/src/recall-state-view-widen.ts:55` — "#2859: matches are namespace-qualified, and a successor's supersedes back-pointer anchors its predecessor"
- `packages/remnic-core/src/recall-state-view-zero-diff.test.ts:149` — "Review round 2: ...live route is applyRecallStateViews -> formatQmdResultEntries"
- `packages/remnic-core/src/recall-state-view.test.ts:361` — "ns-a has the superseded predecessor; ns-b has an UNRELATED row that reuses the successor id"
- `packages/remnic-core/src/recall-state-view.ts:52` — "Phrase matches are token-bounded: "when Didi" must not fire the "when did" phrase"
- `packages/remnic-core/src/recall-state-view.ts:53` — "and "confused to" must not fire "used to"."
- `packages/remnic-core/src/recall-state-view.ts:56` — "Bare before/after are ordinary sequencing... carry change intent only when they point at a specific event"
- `packages/remnic-core/src/recall-state-view.ts:57` — "after install..."
- `packages/remnic-core/src/recall-state-view.ts:58` — "specific event through a determiner"
- `packages/remnic-core/src/recall-state-view.ts:59` — "cutover"
- `packages/remnic-core/src/recall-state-view.ts:86` — "#2859 — namespace-qualified chain identity. Namespace fanout can surface the same id"
- `packages/remnic-core/src/recall-state-view.ts:107` — "predecessorKey → successorKey, namespace-qualified. Precedence: explicit chains, then supersedes back-pointers"
- `packages/remnic-core/src/recall-state-view.ts:182` — "#1952 asOf mode... boundary is the fact's validity flip — invalidAt — not the supersededAt write time"
- `packages/remnic-core/src/recall-state-view.ts:211` — "#2893 — changeIntent:true marks intent as already classified from the ORIGINAL prompt"
- `packages/remnic-core/src/recall-state-view.ts:215` — "#1952 asOf mode: under a historical pin the pipeline's isValidAsOf gate already decided validity"
- `packages/remnic-core/src/recall-state-view.ts:242` — "#1952 contract: superseded never appears without its successor... reconcile to a fixpoint"
- `packages/remnic-core/src/recall-state-view.ts:270` — "#2859 — drop superseded rows whose successor is not in the pool BEFORE the user cap/MMR runs"
- `packages/remnic-core/src/recall-state-view.ts:298` — "#2928 — per-row packet root keys for the final output budget"
- `packages/remnic-core/src/recall-state-view.ts:330` — "ponytail: blank-key rows must stay distinct singletons; index-keyed."
- `packages/remnic-core/src/recall-state-view.ts:346` — "#2859 — packet-counting cap. A predecessor/successor chain admitted together is ONE complete evidence packet"
- `packages/remnic-core/src/recall-why-service.ts:87` — "// Namespaces on but no identity supplied: refuse rather than diagnose"
- `packages/remnic-core/src/recall-why-service.ts:88` — "// against the global namespace (least-privileged default)."
- `packages/remnic-core/src/recall-why-service.ts:177` — "// A namespace whose storage cannot be read contributes no candidates;"
- `packages/remnic-core/src/recall-why-service.ts:178` — "// the diagnosis still reports on the ones that could be read."
- `packages/remnic-core/src/recall-why.test.ts:223` — "// Same fixture, namespaces off: the namespace gate must not fire, so the"
- `packages/remnic-core/src/recall-why.test.ts:224` — "// memory falls through to the stale-index verdict instead."
