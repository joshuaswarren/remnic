# Contradiction resolutions record catalog touches only after durable commit, gate verbs per review-item kind, and treat unresolved judges as needs-user

Status: accepted

## Context
Contradiction review stores candidate pairs and executes user-chosen resolution verbs (keep-a/keep-b/merge for contradiction pairs; keep/supersede/archive for preference drift). A merge superseding both sources is a durable mutation of the pair's possibly-dynamic namespace storage that bypasses the normal extraction write path — if the catalog touch fired before the resolution committed (or on a rolled-back merge), a dynamic namespace's only durable mutation would stay invisible to QMD maintenance / `writtenSince`, or worse, the catalog would record writes that never survived.

## Decision
- The catalog write touch (`onMergedMemoryWritten`) fires ONLY after the resolution durably commits past the rollback point (rule #25: never record a touch for a fully rolled-back write). It is armed for EVERY successful merge — reusing an existing merged id still supersedes both sources and must refresh `lastWriteAt` — and for supersede-only keep-a/keep-b resolutions. The touch is best-effort: a throwing callback never derails a successful resolution.
- Verb validity is gated per review-item kind at the only place both kinds are known (after record load): a preference-drift item never accepts keep-a/keep-b/merge (the second id is witness evidence, not a competing claim); a contradiction pair never accepts keep/supersede/archive.
- Every preference-drift verb is terminal: once answered, the item leaves the unresolved queue and is never re-proposed by later scans. A refused resolution that changed no memories is NOT terminal — it stays actionable.
- Merged content is LLM-produced and written sealed-envelope in salvage mode. If merged content matches a tombstone (pending_review), do NOT supersede both sources to a non-active replacement — clean up the pending merge and abort the pair.
- The scan driver resolves namespace-scoped storage via the factory (never a pre-built default-namespace lookup), uses deterministic pair IDs for direct cooldown lookups, sets `lastReviewedAt` for non-actionable verdicts so cooldown prevents re-judging, guards divide-by-zero cooldowns, judges only active memories from an explicit status set, sorts pair sides for order-independent content hashing, and treats ALL-unresolved judge outcomes as `needs-user`. Unknown judge errors default conservatively rather than auto-resolving.

## Consequences
Post-commit-only touches mean a crashed resolution may leave a namespace temporarily unrecorded until the next successful pass — acceptable, since recording phantom touches is worse. Cross-kind verbs fail explicitly rather than guessing an action. Cooldown behavior makes judge flakiness non-repeating.

## Merged themes
Small adjacent themes are merged here as nearest neighbours: `converge-*` (peer timeouts scaled for boot-scale corpora, config-over-env precedence, parse-time schedule invariants) and `convergence-refresh-forced-search` (a forced search so a min-interval skip cannot masquerade as proof of indexing) share the "conservative defaults for convergence surfaces" rationale; `shared-namespace-resolver`, `legacy-shaped-test-double`, and `resolution-delegates-supersede` are part of the same resolution machinery.

## Origin comments
- `packages/remnic-core/src/contradiction/contradiction-judge.ts:1` — "/** * Contradiction Judge — LLM-as-judge for semantic contradiction detection (issue #520). * * Pairs semantically-simil"
- `packages/remnic-core/src/contradiction/contradiction-judge.ts:101` — "// Sort each side pair to be order-independent (matching pairKey behavior)"
- `packages/remnic-core/src/contradiction/contradiction-judge.ts:218` — "// All unresolved → needs-user (rule 48)"
- `packages/remnic-core/src/contradiction/contradiction-review.ts:1` — "/** * Contradiction Review Queue — storage for detected contradiction pairs (issue #520). * * Stores candidate pairs as "
- `packages/remnic-core/src/contradiction/contradiction-review.ts:20` — "/** * Resolution verbs. The first five are contradiction-pair verbs; the last * three resolve a `kind: "preference-drift"
- `packages/remnic-core/src/contradiction/contradiction-review.ts:126` — "// Every preference-drift verb is terminal: the user has answered the "is"
- `packages/remnic-core/src/contradiction/contradiction-review.ts:127` — "// this preference still true?" question, so the item must leave the"
- `packages/remnic-core/src/contradiction/contradiction-review.ts:128` — "// unresolved queue and never be re-proposed by a later scan (issue #2371)."
- `packages/remnic-core/src/contradiction/contradiction-review.ts:581` — "// rule 27: guard against 0"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:1` — "/** * Contradiction Scan — pair generator + scan driver (issue #520). * * Nightly cron that pairs semantically-similar a"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:119` — "// Prefer the factory (which uses the scan's own storage for correct namespace scoping)"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:120` — "// over a pre-built lookup (which may use default-namespace storage)."
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:133` — "// 2. Prepare exact existing-pair lookup for cooldown checking."
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:134` — "// Pair IDs are deterministic, so lookup the candidate's file directly instead"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:135` — "// of paging through the review queue and risking a bounded-list miss."
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:160` — "// 4. Build judge inputs. Candidate generation already preserves strategy"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:161` — "// priority and caps work at maxPairsPerRun."
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:171` — "// 6. Send to judge (per-scan cache avoids module-level singleton leak)"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:186` — "// Set lastReviewedAt for non-actionable verdicts so cooldown prevents re-judging"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:383` — "/** * Resolve the namespace-scoped storage a scan must read and write through. * * Exported and narrowed to the fields i"
- `packages/remnic-core/src/contradiction/contradiction-scan.ts:466` — "// Only active memories (rule 53: explicit ACTIVE_STATUSES set)"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:122` — "// Production mapper keeps this legacy-shaped double faithful (§21)."
- `packages/remnic-core/src/contradiction/contradiction.test.ts:1957` — "// The merge catalog touch (onMergedMemoryWritten) must fire ONLY after the"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:1958` — "// resolution durably commits past the rollback point. If resolvePair fails and"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:1959` — "// the merge rolls back, NO catalog write may be recorded for a write that did"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:1960` — "// not survive."
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2027` — "// NH3X3: supersede-only resolutions (keep-a / keep-b) also mutate the namespace,"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2028` — "// so they must record a catalog touch — post-commit, never on rollback."
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2841` — "// ── issue #1499 sweep: a contradiction merge that CREATES a new merged memory"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2842` — "// writes durable data to the pair's (possibly dynamic) namespace storage,"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2843` — "// bypassing the extraction write path. executeResolution must invoke"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2844` — "// onMergedMemoryWritten(namespace, storageDir) so the caller records the catalog"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2845` — "// write — otherwise a dynamic namespace whose only durable mutation is a merge"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2846` — "// stays invisible to QMD maintenance / writtenSince."
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2881` — "// Reusing an EXISTING merged memory id still supersedes BOTH sources — a durable"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2882` — "// namespace mutation — so the catalog touch MUST fire so `lastWriteAt` refreshes"
- `packages/remnic-core/src/contradiction/contradiction.test.ts:2883` — "// (NH3X3). It fires exactly once, post-commit."
- `packages/remnic-core/src/contradiction/resolution.ts:1` — "/** * Resolution Verbs — executes user-chosen resolution actions on contradiction pairs (issue #520). * * All resolution"
- `packages/remnic-core/src/contradiction/resolution.ts:59` — "/** * Every verb the `review_resolve` surface accepts, across both review-item * kinds (issue #2371). This is a *surface"
- `packages/remnic-core/src/contradiction/resolution.ts:110` — "// Verb validity is per review-item kind (issue #2371). A preference-drift"
- `packages/remnic-core/src/contradiction/resolution.ts:111` — "// item never accepts keep-a/keep-b/merge (there is no "B" to keep — the"
- `packages/remnic-core/src/contradiction/resolution.ts:112` — "// second id is witness evidence, not a competing claim), and a contradiction"
- `packages/remnic-core/src/contradiction/resolution.ts:113` — "// pair never accepts keep/supersede/archive. Rejecting the cross-kind verb"
- `packages/remnic-core/src/contradiction/resolution.ts:114` — "// here, after the record is loaded, is the only place both kinds are known."
- `packages/remnic-core/src/contradiction/resolution.ts:139` — "// Only record the terminal resolution when memories actually changed;"
- `packages/remnic-core/src/contradiction/resolution.ts:140` — "// a refused resolution must stay actionable in the queue."
- `packages/remnic-core/src/contradiction/resolution.ts:151` — "// Deferred catalog-write touch for any resolution that leaves durable namespace"
- `packages/remnic-core/src/contradiction/resolution.ts:152` — "// memory mutations (issue #1499 sweep, NH1dX / NH3X3). Rule #25: never record a"
- `packages/remnic-core/src/contradiction/resolution.ts:153` — "// catalog touch for a write that is fully rolled back. Successful mutating"
- `packages/remnic-core/src/contradiction/resolution.ts:154` — "// resolutions invoke it after `resolvePair` persists. Failed paths invoke it"
- `packages/remnic-core/src/contradiction/resolution.ts:155` — "// only when rollback inspection shows the namespace still differs from the"
- `packages/remnic-core/src/contradiction/resolution.ts:156` — "// pre-mutation snapshot."
- `packages/remnic-core/src/contradiction/resolution.ts:158` — "// Returns the deferred touch fn for a mutating verb (or null when the caller"
- `packages/remnic-core/src/contradiction/resolution.ts:159` — "// wired no catalog hook), so each branch assigns `recordCatalogWriteTouch`"
- `packages/remnic-core/src/contradiction/resolution.ts:160` — "// directly in the function body — keeping TS control-flow narrowing intact at"
- `packages/remnic-core/src/contradiction/resolution.ts:161` — "// the post-commit invocation below."
- `packages/remnic-core/src/contradiction/resolution.ts:210` — "// keep-a superseded idB in this namespace — record a catalog touch once"
- `packages/remnic-core/src/contradiction/resolution.ts:211` — "// the resolution durably commits (NH3X3)."
- `packages/remnic-core/src/contradiction/resolution.ts:244` — "// keep-b superseded idA in this namespace — record a catalog touch once"
- `packages/remnic-core/src/contradiction/resolution.ts:320` — "// Catalog write touch (issue #1499 sweep): the merge supersedes BOTH sources"
- `packages/remnic-core/src/contradiction/resolution.ts:321` — "// (and, when created, writes a fresh merged memory) in the pair's (possibly"
- `packages/remnic-core/src/contradiction/resolution.ts:322` — "// dynamic) namespace storage — but the resolution is not durable yet"
- `packages/remnic-core/src/contradiction/resolution.ts:323` — "// (resolvePair persists below, and a failure rolls the merge back). Defer"
- `packages/remnic-core/src/contradiction/resolution.ts:324` — "// the touch so it fires ONLY after the resolution commits past the rollback"
- `packages/remnic-core/src/contradiction/resolution.ts:325` — "// point (NH1dX, rule #25). Arm it for EVERY successful merge — even reusing"
- `packages/remnic-core/src/contradiction/resolution.ts:326` — "// an existing merged-id still supersedes both sources, a namespace mutation"
- `packages/remnic-core/src/contradiction/resolution.ts:327` — "// that must refresh `lastWriteAt` (NH3X3). Otherwise a dynamic namespace"
- `packages/remnic-core/src/contradiction/resolution.ts:328` — "// whose only durable mutation is a contradiction merge stays invisible to"
- `packages/remnic-core/src/contradiction/resolution.ts:329` — "// QMD maintenance / `writtenSince`. Best-effort on the caller side."
- `packages/remnic-core/src/contradiction/resolution.ts:370` — "// The resolution durably committed (memory mutated AND the resolution"
- `packages/remnic-core/src/contradiction/resolution.ts:371` — "// persisted past the rollback point). Only now is it safe to record the"
- `packages/remnic-core/src/contradiction/resolution.ts:372` — "// catalog write for the namespace mutation (NH1dX / NH3X3, rule #25)."
- `packages/remnic-core/src/contradiction/resolution.ts:373` — "// Best-effort: the caller's callback swallows errors; guard here so a"
- `packages/remnic-core/src/contradiction/resolution.ts:374` — "// throwing callback never derails a successful resolution."
- `packages/remnic-core/src/contradiction/resolution.ts:438` — "// Sealed-envelope write (issue #1989 PR4): merged content is"
- `packages/remnic-core/src/contradiction/resolution.ts:439` — "// LLM-produced — salvage; drops are warn-logged."
- `packages/remnic-core/src/contradiction/resolution.ts:460` — "// #1645: merged content matched a tombstone (pending_review). Don't"
- `packages/remnic-core/src/contradiction/resolution.ts:461` — "// supersede both sources to a non-active replacement — that retires"
- `packages/remnic-core/src/contradiction/resolution.ts:462` — "// the only active copies. Clean up the pending merge and abort the pair."
- `packages/remnic-core/src/converge-config.ts:16` — "/** Default per-request peer HTTP timeout. Boot-scale corpora (100k+ files in one * namespace) can take well over 30s to"
- `packages/remnic-core/src/converge-config.ts:19` — "/** Ceiling for the configured timeout — a peer that has not answered in an hour * is unreachable, not slow. */"
- `packages/remnic-core/src/converge-config.ts:34` — "/** Env override, evaluated lazily so tests control time. Junk is rejected. */"
- `packages/remnic-core/src/converge-config.ts:52` — "/** * Config values win over env. An omitted knob stays omitted here so the * caller can still fall through to the built"
- `packages/remnic-core/src/converge-config.ts:124` — "// Reject an inverted schedule at parse time. Omitted knobs stay omitted"
- `packages/remnic-core/src/converge-config.ts:125` — "// and are filled from defaults only when the acquire runs."
- `packages/remnic-core/src/convergence-refresh.ts:18` — "// Forced so a min-interval skip cannot masquerade as proof that the"
- `packages/remnic-core/src/convergence-refresh.ts:19` — "// converged writes are indexed; a real failure still fails the refresh."
