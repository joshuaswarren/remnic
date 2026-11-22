# Extraction Retry, Circuit Breaker, and the No-Drop Retention Contract

Status: accepted

## Context
A failing extraction provider must not be hammered once per observe, but
the suppression machinery must never destroy the turns it suppressed. Retry
state and the circuit breaker sit in front of every extraction call; forced
flushes and fail-closed callers bypass the gate yet still record failures;
half-open probes need ownership and deadlines; and write targeting (namespace,
principal) must follow the authenticated surface rather than session-key
conventions. Passive corrections arrive in short turns that would normally
fall below extraction thresholds.

## Decision
Rules:

- Retry/backoff state is per fingerprint (namespace, then fingerprint),
  lazily hydrated from namespace meta and persisted back on change
  (restart-safe, cross-process coherent); the in-memory mirror is bounded.
  The circuit breaker is deliberately per-process in-memory — persisted
  backoff still throttles after a restart, so a restart cannot resurrect the
  hot loop.
- The retry gate suppresses re-attempts of a recently failed fingerprint and
  short-circuits all fingerprints while the breaker is open. On suppression
  the buffer is deliberately NOT cleared — no extractable turn is dropped;
  it retries after cooldown. Forced flushes and fail-closed callers bypass
  the gate but still record failures, before any fail-closed throw.
- The breaker is ORCHESTRATOR-wide: fresh per-drain coordinators must consult
  the shared breaker. A failed auth_config trips below the consecutive-failure
  threshold; a transient probe failure in half_open re-opens the breaker.
- The half-open probe is OWNED, not timed: released by the wrapper's finally
  on every exit path, including pre-persistence exits; backoff-suppression
  exits release inside the gate so a cooldown-expired fingerprint cannot pin
  half_open. A probe that gets no answer in time counts as a provider
  failure, with the caller deadline timer still running; settlement applies
  only to a probe the run owns.
- Retention follows the actual extraction failure, not retry bookkeeping:
  with retry disabled, failed turns are still kept (#3415); a successful
  empty result clears. Policy refusals and namespace-write revocations
  retain the window pending a later attempt — clearing would destroy content
  policy never wrote. parse_empty budget exhaustion long-parks (never marked
  processed). Extraction-LLM outages surface on /health as deduplicated
  ERROR events; a second failure inside the dedup window emits no second
  ERROR.
- All observation-side gates are fail-open (failure recording, extraction
  gates, threading); a forced flush success-heals by hydrating the mirror
  before clearing persisted meta, so stale backoff cannot survive.
- Write targeting: explicit caller override wins; otherwise an active hosted
  scope profile owns the write namespace, and the provenance principal is
  the identity the access surface authenticated — not resolvePrincipal on a
  namespace-prefixed key, which would collapse to `default` (the original
  session key still drives threading).
- Passive correction capture runs on context-only turns and below-threshold
  extractions (a short "stop using Vim" is exactly the target case), through
  the same scope-profile write plan as full extraction, after persistence,
  fail-open, and never delayed by a provider cooldown.
- A durable-output count covers every enabled output kind, so a
  reflection-only or relationship-only result still reaches persistence;
  cron job sessions skip extraction entirely.
- Mutations under the storage meta lock read freshly loaded meta so a
  concurrent extraction's updates are not reverted; retry defaults are
  shared with the bookkeeping to avoid divergence.

## Consequences
Suppressed windows grow the buffer until cooldown — sustained outages
require the breaker to actually open. Fail-open gates favor memory capture
over protection on provider-adjacent errors; only explicit fail-closed
callers (flush-plan import) treat malformed output as failure. The per-process
breaker is accepted restart amnesia, backstopped by persisted backoff.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:39` — "// same default as the retry bookkeeping"
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:278` — "// Applied under the storage's per-dir meta lock (storage.updateMeta): the"
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:279` — "// fingerprint record and the counters land on a FRESHLY loaded meta, so a"
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:280` — "// concurrent extraction's updates are not reverted by this save."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:780` — "// An auth_config failure trips the breaker below the consecutive-failure"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:781` — "// threshold. After the auth cooldown elapses (half_open), a transient probe"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:782` — "// failure must re-open the breaker — not leave it stuck half_open where it"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:783` — "// no longer suppresses anything."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:796` — "// Auth cooldown 0 → this call flips open→half_open and probes; the probe"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:797` — "// fails transiently → the breaker must re-open with the transient cooldown."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:842` — "// A forced flush bypasses the retry gate and never hydrates the in-memory"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:843` — "// mirror, so the success-heal path must still clear the persisted meta entry"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:844` — "// — otherwise a stale backoff survives a successful forced flush and keeps"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:845` — "// blocking normal extraction until the timer expires."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1309` — "// A second failing flush updates the timestamp but must NOT emit a second"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1310` — "// ERROR for the same reason inside the dedup window."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1429` — "// extractionRunCoordinatorForBuffer builds a fresh coordinator per claim"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1430` — "// drain; the ORCHESTRATOR-wide breaker must be the one they all consult."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1447` — "// A DIFFERENT isolated coordinator (a fresh claim drain) must observe the"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1448` — "// opened breaker instead of re-calling the failing provider. Distinct"
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1449` — "// fingerprint, so only the breaker can suppress this attempt."
- `packages/remnic-core/src/orchestration/extraction-run.test.ts:1683` — "// Recording the probe failure must not outlive the caller deadline."
- `packages/remnic-core/src/orchestration/extraction-run.ts:161` — "// Per-fingerprint extraction retry/backoff state (extraction hot-loop"
- `packages/remnic-core/src/orchestration/extraction-run.ts:162` — "// hardening). Outer key = namespace, inner key = fingerprint. Hydrated lazily"
- `packages/remnic-core/src/orchestration/extraction-run.ts:163` — "// from namespace-scoped meta so the hot path is a Map lookup; persisted back"
- `packages/remnic-core/src/orchestration/extraction-run.ts:164` — "// to meta on change (restart-safe, cross-process coherent via the shared"
- `packages/remnic-core/src/orchestration/extraction-run.ts:165` — "// meta.json). The breaker below is intentionally per-process in-memory"
- `packages/remnic-core/src/orchestration/extraction-run.ts:166` — "// (mirrors local-llm.cooldownUntilMs); a restart clears it but the persisted"
- `packages/remnic-core/src/orchestration/extraction-run.ts:167` — "// backoff still throttles, so a restart can't resurrect the hot loop."
- `packages/remnic-core/src/orchestration/extraction-run.ts:239` — "// Keep this cache bounded to avoid unbounded growth."
- `packages/remnic-core/src/orchestration/extraction-run.ts:278` — "/** Lazily hydrate the in-memory retry-state mirror for a namespace from meta. * One-time per namespace per coordinat…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:336` — "// Fail-open: recording failure state must never crash observe/recall."
- `packages/remnic-core/src/orchestration/extraction-run.ts:341` — "/** Failure backoff into the in-memory mirror + breaker WITHOUT touching meta — the fallback * when the locked meta w…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:356` — "// parse_empty budget exhausted → long-park (still never marked processed)."
- `packages/remnic-core/src/orchestration/extraction-run.ts:418` — "/** * Explicit namespace override for the write path (#460). When set, this * is the namespace where extraction write…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:426` — "/** * Pin the provenance principal instead of deriving it from * `resolvePrincipal(sessionKey)`. When set, this is th…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:433` — "/** * Access scope resolution may already have selected a profile while the * session context remains intentionally u…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:439` — "/** * Force the extractor call, bypassing the retry-backoff / circuit-breaker * gate (extraction hot-loop hardening).…"
- `packages/remnic-core/src/orchestration/extraction-run.ts:529` — "// Skip extraction for cron job sessions - these are system operations, not user conversations"
- `packages/remnic-core/src/orchestration/extraction-run.ts:554` — "// Context-only turns may still contain corrections (review: \"context-only"
- `packages/remnic-core/src/orchestration/extraction-run.ts:555` — "// turns skip capture\"). Scan normalizedTurns before clearing the buffer."
- `packages/remnic-core/src/orchestration/extraction-run.ts:588` — "// Passive correction capture runs even when extraction is skipped for"
- `packages/remnic-core/src/orchestration/extraction-run.ts:589` — "// being below the char/user-turn threshold (review: \"skipped extraction"
- `packages/remnic-core/src/orchestration/extraction-run.ts:590` — "// skips capture\"). A short correction like \"stop using Vim\" is under"
- `packages/remnic-core/src/orchestration/extraction-run.ts:591` — "// extractionMinChars but is exactly the high-value case this feature"
- `packages/remnic-core/src/orchestration/extraction-run.ts:592` — "// exists for. The write namespace resolves through the SAME scope-profile"
- `packages/remnic-core/src/orchestration/extraction-run.ts:593` — "// plan as the full extraction path so corrections target the active"
- `packages/remnic-core/src/orchestration/extraction-run.ts:594` — "// profile's write layer, not just resolveSelfNamespace (review:"
- `packages/remnic-core/src/orchestration/extraction-run.ts:595` — "// \"below-threshold wrong namespace\"). The ACL in passiveCorrectionService"
- `packages/remnic-core/src/orchestration/extraction-run.ts:596` — "// authorizes the actual plan/apply."
- `packages/remnic-core/src/orchestration/extraction-run.ts:637` — "// Provenance principal honours the access-surface override (#1495 thread 1,"
- `packages/remnic-core/src/orchestration/extraction-run.ts:638` — "// mirroring the recall path's `principalOverride`, issue #570 PR 4). Access"
- `packages/remnic-core/src/orchestration/extraction-run.ts:639` — "// surfaces that authenticated the caller at the transport layer pass their"
- `packages/remnic-core/src/orchestration/extraction-run.ts:640` — "// resolved principal so provenance uses the SAME identity the surface"
- `packages/remnic-core/src/orchestration/extraction-run.ts:641` — "// authorized, instead of `resolvePrincipal(sessionKey)` — which on a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:642` — "// namespace-prefixed key would collapse to `default`. The ORIGINAL,"
- `packages/remnic-core/src/orchestration/extraction-run.ts:643` — "// un-prefixed session key still drives threading."
- `packages/remnic-core/src/orchestration/extraction-run.ts:648` — "// Write path — explicit callers still win. Otherwise, an active hosted"
- `packages/remnic-core/src/orchestration/extraction-run.ts:649` — "// scope profile owns the extraction write target so hook-captured turns land"
- `packages/remnic-core/src/orchestration/extraction-run.ts:650` — "// in the same layer that profile recall searches. Without a profile, preserve"
- `packages/remnic-core/src/orchestration/extraction-run.ts:651` — "// the existing coding-agent overlay behavior (issue #569)."
- `packages/remnic-core/src/orchestration/extraction-run.ts:684` — "// Policy refusal (same family as namespace_write_revoked): the window"
- `packages/remnic-core/src/orchestration/extraction-run.ts:685` — "// stays in the buffer/claim pending a later attempt. Clearing here"
- `packages/remnic-core/src/orchestration/extraction-run.ts:686` — "// would destroy content policy never wrote — the claim drain would"
- `packages/remnic-core/src/orchestration/extraction-run.ts:687` — "// erase denied backlog and ack it as drained."
- `packages/remnic-core/src/orchestration/extraction-run.ts:792` — "// Extraction retry/backoff + circuit-breaker gate (extraction hot-loop"
- `packages/remnic-core/src/orchestration/extraction-run.ts:793` — "// hardening). Suppresses re-attempts of a recently-failed fingerprint and"
- `packages/remnic-core/src/orchestration/extraction-run.ts:794` — "// short-circuits every fingerprint while the provider breaker is open, so a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:795` — "// failing LLM endpoint is not hammered once per observe. Forced flushes and"
- `packages/remnic-core/src/orchestration/extraction-run.ts:796` — "// fail-closed callers bypass the gate (rule 18) but still record failures."
- `packages/remnic-core/src/orchestration/extraction-run.ts:797` — "// On a suppressed attempt the buffer is deliberately NOT cleared, so no"
- `packages/remnic-core/src/orchestration/extraction-run.ts:798` — "// extractable turn is dropped — it is retried after cooldown/nextEligibleAt."
- `packages/remnic-core/src/orchestration/extraction-run.ts:801` — "// Resolve the gate through the shared lifecycle capability plan (issue"
- `packages/remnic-core/src/orchestration/extraction-run.ts:802` — "// #1523) rather than reading the raw config flag at each call site."
- `packages/remnic-core/src/orchestration/extraction-run.ts:822` — "// Passive correction capture is local and must not be delayed by a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:823` — "// provider cooldown. It remains fail-open."
- `packages/remnic-core/src/orchestration/extraction-run.ts:840` — "// Backoff suppression exits inside the gate, before the wrapper"
- `packages/remnic-core/src/orchestration/extraction-run.ts:841` — "// finally: release an acquired probe here (codex follow-up) so a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:842` — "// cooldown-expired fingerprint cannot pin the breaker half_open."
- `packages/remnic-core/src/orchestration/extraction-run.ts:848` — "// Fail-open: a gate error must never block extraction."
- `packages/remnic-core/src/orchestration/extraction-run.ts:852` — "// Pass existing entity names so the LLM can reuse them instead of inventing variants."
- `packages/remnic-core/src/orchestration/extraction-run.ts:853` — "// The probe owner must release on ANY pre-persistence exit too (codex P1):"
- `packages/remnic-core/src/orchestration/extraction-run.ts:854` — "// the big try below only covers from the extract call onward."
- `packages/remnic-core/src/orchestration/extraction-run.ts:861` — "// The half-open probe is bounded: one that gets no answer in time counts as"
- `packages/remnic-core/src/orchestration/extraction-run.ts:862` — "// a provider failure (re-opens the breaker) instead of holding every other"
- `packages/remnic-core/src/orchestration/extraction-run.ts:863` — "// attempt until the provider answers or times out."
- `packages/remnic-core/src/orchestration/extraction-run.ts:873` — "// Keep the caller deadline timer running while a probe timeout is turned into a failure result."
- `packages/remnic-core/src/orchestration/extraction-run.ts:886` — "// Defensive: validate extraction result before processing. Explicit"
- `packages/remnic-core/src/orchestration/extraction-run.ts:887` — "// fail-closed callers, such as flush-plan import, must not observe"
- `packages/remnic-core/src/orchestration/extraction-run.ts:888` — "// malformed extractor output as a successful skip."
- `packages/remnic-core/src/orchestration/extraction-run.ts:894` — "// Actual extraction failure: the window is retained for a retry (same"
- `packages/remnic-core/src/orchestration/extraction-run.ts:895` — "// no-drop contract as a recorded provider failure), never destroyed."
- `packages/remnic-core/src/orchestration/extraction-run.ts:936` — "// Issue #3140: surface extraction-LLM outages on /health and as an"
- `packages/remnic-core/src/orchestration/extraction-run.ts:937` — "// ERROR-level deduplicated event instead of debug-only lines. Records on"
- `packages/remnic-core/src/orchestration/extraction-run.ts:938` — "// every completed attempt so a later success clears the failure."
- `packages/remnic-core/src/orchestration/extraction-run.ts:949` — "// Record failure into backoff/breaker state, or heal on success. Runs for"
- `packages/remnic-core/src/orchestration/extraction-run.ts:950` — "// every result path (empty and durable), before the fail-closed throw, so a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:951` — "// forced flush still records its failure (rule 18). Gated by"
- `packages/remnic-core/src/orchestration/extraction-run.ts:952` — "// extractionRetryEnabled so a disabled feature restores prior behavior."
- `packages/remnic-core/src/orchestration/extraction-run.ts:968` — "// Fail-open, but retain the turns (a cleared buffer with no retry state drops them). Only a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:969` — "// LOCK skip reaches here without the mutator having run — a later save must not double-count."
- `packages/remnic-core/src/orchestration/extraction-run.ts:976` — "// Provider responded without failure → breaker heals; clear any"
- `packages/remnic-core/src/orchestration/extraction-run.ts:977` — "// parked backoff for this fingerprint so it proceeds normally."
- `packages/remnic-core/src/orchestration/extraction-run.ts:978` — "// PRRT_kwDORJXyws6zxG6u: pass the run's probe token so the settlement"
- `packages/remnic-core/src/orchestration/extraction-run.ts:979` — "// only applies to a probe this run owns."
- `packages/remnic-core/src/orchestration/extraction-run.ts:985` — "// Hydrate the mirror from persisted meta before clearing: a forced flush"
- `packages/remnic-core/src/orchestration/extraction-run.ts:986` — "// bypassed the retry gate, and a stale persisted entry would keep blocking."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1003` — "// #3227: one count covers every enabled durable output kind, so a"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1004` — "// reflection-only or relationship-only result reaches persistence."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1034` — "// Issue #3415: retention follows the actual extraction failure, not the"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1035` — "// retry bookkeeping. With retry disabled no backoff state is recorded,"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1036` — "// but the failed turns are still kept for the next attempt — clearing"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1037` — "// them is silent loss. A successful empty result still clears below."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1059` — "// Fail-open: threading errors must not block memory persistence."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1073` — "// Pass the KNOWN base namespace (NHIdx) so the catalog write touch records the"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1074` — "// real namespace rather than a guess decoded from the storage dir."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1113` — "// Passive correction capture (issue #1581) — detect corrections expressed"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1114` — "// passively in the extracted turns and route to the Correction Contract."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1115` — "// Runs AFTER persistence + buffer clear so a capture failure never blocks"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1116` — "// the extraction return. `clearBufferAfterExtraction` gates live-session"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1117` — "// auto-apply (replay/import → queue-only)."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1129` — "// Build memory box from this extraction (v8.0 Phase 2A)"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1130` — "// Topics are derived from the current extraction's facts and entities only —"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1131` — "// not from readAllMemories() — so box topics accurately reflect the current"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1132` — "// session window and the call is free of expensive full-corpus I/O."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1148` — "// Batch-append persisted IDs so non-fact memories (entities/questions) are"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1149` — "// always attached to the thread. The helper excludes pending_review ids (#1635)."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1167` — "// The increment of nonZeroExtractionsSinceConsolidation moved into"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1168` — "// the scheduler with the rest of the cadence state (issue #1526 PR1)."
- `packages/remnic-core/src/orchestration/extraction-run.ts:1194` — "// The half-open probe is OWNED, not timed: the WRAPPER finally releases"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1195` — "// it on every exit path, including pre-persistence ones (codex P1) that"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1196` — "// never reach the inner try above."
