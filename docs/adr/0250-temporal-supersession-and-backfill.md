# Temporal Supersession and Bi-Temporal Bounds Backfill

Status: accepted

## Context
Facts carry structured attributes whose values change over time (a city, a
status). When a new authoritative value arrives, older conflicting facts must
be retired, but the ordering anchor and the trigger paths are subtle:
dedup short-circuits skip the post-write supersession block entirely,
source-dated imports carry their own valid_at, an old shared copy's persisted
`created` predates the incoming event, and an end-only bound marks history
rather than a new authoritative state. Separately, a corrected bi-temporal
bound must reach every copy that was written before the bound was known —
including promotion copies in other namespaces — without ever letting a
non-durable candidate expire an active fact.

## Decision
Rules:

- Temporal supersession retires an older active fact with the same entity +
  attribute key whose value conflicts with the incoming fact's structured
  attributes.
- Order supersession by the INCOMING event's time (source valid_at for
  source-dated replay/import, else wall-clock), never by the matching old
  fact's persisted `created`; pass the caller timestamp so an old shared copy
  cannot make the new memory appear older than the existing one.
- Supersession must run on EVERY path that confirms a duplicate or writes a
  promoted copy: the hash-dedup short-circuit (scan the shared namespace and
  apply the same logic post-write would), the shared namespace after the
  promoted write lands, and the chunked write path. An extracted end-only
  bound (validFrom absent) is historical and never supersedes a later active
  fact.
- When a duplicate short-circuits a write, backfill bi-temporal bounds onto
  the surviving copy AND every promotion target (shared/profile), best-effort
  and fail-open, backfill-only — never writing a new promoted copy. Backfill
  only when an end bound or an EXTRACTED start bound exists (an "assumed"
  validFrom is just the ingestion anchor); gate on importance and other
  durability gates so a candidate that would never persist does not expire
  an active fact.
- The just-written copy is the supersession target; backfill bounds only
  onto a same-connector fact.

## Consequences
Supersession on the dedup short-circuit adds a namespace scan to every
duplicate hit. Fail-open backfill means a transient read failure can leave a
stale bound until the next re-extraction. Promotion-target backfill must not
gate on current confidence or promotion settings, because an existing copy
may come from an earlier extraction with different settings — but it still
respects shared-write authorization.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:605` — "Round N+15 (A): the just-written copy is the supersession target only"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:450` — "// #1671 — backfill bi-temporal bounds the existing promoted copy"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:451` — "// lacks (re-extraction with a now-resolved invalidAt). Best-effort,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:452` — "// fail-open; the helper gates on invalidAt to avoid I/O when no"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:453` — "// end bound is present."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:460` — "// #1707 thread 2 — carry the corrected start bound."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:678` — "// #1671 — backfill bi-temporal bounds onto the existing shared copy"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:679` — "// before the supersession short-circuit. Covers all return paths below"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:680` — "// (supersession-hit, catch-skip, and the no-supersession short-circuit)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:681` — "// in one shot. Best-effort / fail-open; the helper gates on invalidAt."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:682` — "// Connector gate: skip backfill when no same-connector active fact"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:683` — "// exists so a different connector's copy is not mutated."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:700` — "// Uj6H fix: shared-namespace temporal supersession must also run when"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:701` — "// the hash-dedup short-circuit fires. Without this, an existing shared"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:702` — "// fact whose structuredAttributes are stale (or an older conflicting"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:703` — "// shared fact that is still active) never gets retired — supersession"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:704` — "// only ran in the post-writeMemory block which is unreachable here."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:705` — "//"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:706` — "// Strategy: scan the shared namespace for the existing fact whose"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:707` — "// normalized content matches the incoming content, then run"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:708` — "// applyTemporalSupersession against it using the same logic that"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:709` — "// would have run post-writeMemory. This is a best-effort / fail-open"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:710` — "// step — if the lookup fails we skip silently (same as the normal path)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:767` — "// Finding UvU1 (PR #402 round-11): anchor supersession to the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:768` — "// incoming event's time, not the existing fact's persisted"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:769` — "// `created`. For source-dated replay/import, this is the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:770` — "// source valid_at; otherwise it is the current wall-clock. The"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:771` — "// matching fact may be an old shared copy whose `created`"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:772` — "// predates the incoming promotion event — using it as"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:773` — "// `createdAt` would make the new memory appear older than the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:774` — "// existing one, preventing supersession from firing."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:775` — "// PR #402 round-12 (Finding Uyui): the matching fact is an"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:776` — "// existing OLD memory — its persisted `frontmatter.created` is"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:777` — "// stale relative to the incoming promotion event. Pass"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:778` — "// `useCallerTimestamp: true` so the function uses"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:779` — "// `createdAt` as the ordering anchor instead of the old fact's"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:780` — "// timestamp, ensuring supersession fires correctly even when"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:781` — "// the matching fact predates conflicting candidates."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:894` — "// #1645: if the shared namespace's own tombstone blocked this promotion,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:895` — "// leave the row pending_review but do NOT supersede active shared memories."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:896` — "// PR #402 Finding 3 fix: run temporal supersession against the shared"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:897` — "// namespace after the promoted write lands so stale shared-namespace"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:898` — "// copies of the same entity attribute are retired. Without this,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:899` — "// source-namespace supersession leaves the shared copy active and"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:900` — "// shared recall continues returning the stale state. Reuses the same"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:901` — "// applyTemporalSupersession helper — no logic duplication."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:964` — "// #1707 thread 1 — backfill temporal bounds onto promotion copies when the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:965` — "// SOURCE-namespace dedup short-circuit fires. That branch patches the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:966` — "// source copy then `continue`s before the promotion dedup paths run, so"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:967` — "// promoted shared/profile copies written before the source fact carried"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:968` — "// resolved bounds stay stale (cross-namespace recall surfaces an expired"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:969` — "// fact). This mirrors the promotion-target resolution used by the two"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:970` — "// promote closures above and calls the same fail-open helper against each"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:971` — "// target storage. Backfill-only: never writes a new promoted copy."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:987` — "// Mirror the helper's I/O gate: only resolve promotion targets when"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:988` — "// there is an end bound OR an EXTRACTED start bound. An \"assumed\""
- `packages/remnic-core/src/orchestration/extraction-persist.ts:989` — "// validFrom is just the ingestion anchor (no recall effect), so"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:990` — "// skipping it avoids resolving target storages on every bi-temporal"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:991` — "// duplicate (review cursor PRRT_OvHk)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:996` — "// Build the same dedupContent the promotion functions hash on so the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:997` — "// content-hash lookup in the helper matches what was stored."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1003` — "// #2014 round 3: promoted copies were written from SALVAGE envelopes,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1004` — "// so hash on the same surviving fields those writes persisted — a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1005` — "// raw-attrs hash silently misses after salvage drops/dedupes keys."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1006` — "// Fail open to raw fields when the probe rejects."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1026` — "// Profile targets. NOTE: we do NOT gate on profileAutoPromotionAllows —"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1027` — "// a promoted profile copy may exist from an EARLIER extraction with"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1028` — "// higher confidence or older auto-promote settings, so the current"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1029` — "// duplicate's confidence must not skip backfilling an already-existing"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1030` — "// promoted copy (review codex PRRT_Ov7LKF). The helper no-ops when no"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1031` — "// matching copy is found, so resolving all configured auto-promote"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1032` — "// targets is safe."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1065` — "// Shared target. A shared copy may exist from an earlier extraction"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1066` — "// regardless of the current confidence, so do not gate on"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1067` — "// shouldPromoteToShared (review codex PRRT_Ov7LKF) — BUT still respect"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1068` — "// shared-write AUTHORIZATION: a scoped profile that does not authorize"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1069` — "// serverShared writes must not have its shared namespace backfilled"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1070` — "// (review codex PRRT_Ov7dHR). profileAllowsSharedWrites is true for the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1071` — "// legacy no-scope case and encodes the readable/writable/authorized"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1072` — "// checks under a scope profile."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1669` — "// Importance is scored before the dedup short-circuit so #1671 backfill"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1670` — "// can gate on it (cursor PRRT_OvKnS): a low-value duplicate that the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1671` — "// importance write-gate (#372) or the judge pre-filter would drop must"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1672` — "// not expire an active fact."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1718` — "// #1671/#1707 — backfill bi-temporal bounds onto the surviving copy"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1719` — "// when a duplicate short-circuits: persist-time hit OR raced duplicate"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1720` — "// suppressed in the window (codex P2, PRRT_kwDORJXyws6zxlor). Facts"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1721` — "// only (#1707 t3); a corrected start bound counts (t2). Skipped when a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1722` — "// downstream gate would reject the candidate — a non-durable candidate"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1723` — "// must not expire an active fact (faithfulness, requireSpans, judge,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1724` — "// #372 importance)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1740` — "// Importance gate (cursor PRRT_OvKnS): below-threshold duplicates"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1741` — "// would never persist (#372) and carry no judge verdict (the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1742` — "// pre-filter skips them), so they must not expire an active fact."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1756` — "// #1707 thread 2 — carry the corrected start bound too."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1764` — "// #1707 thread 1 — a short-circuited source branch never reaches the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1765` — "// promotion dedup paths, so promoted shared/profile copies written"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1766` — "// before the source fact carried resolved bounds stay stale and"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1767` — "// cross-namespace recall surfaces an expired fact. Backfill the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1768` — "// promotion targets too (fail-open, backfill-only — never writes a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1769` — "// new promoted copy)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2208` — "// Codex P2: backfill bounds onto the winning copy first."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2347` — "// PR #402 Thread 1 fix: run source-namespace temporal supersession for // chunked writes, matching the non-chunked pat…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2348` — "// chunked writes, matching the non-chunked path. Without this the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2349` — "// source namespace retains stale facts that should have been superseded."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2356` — "// non-chunked path."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2364` — "// #1578 r3: an extracted end-only bound (validFrom absent) is // historical, not a new authoritative state — never let…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2365` — "// historical, not a new authoritative state — never let it"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2366` — "// supersede a later active fact (codex P1 on :15534)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2632` — "// Codex P2: backfill bounds onto the window's winning copy first."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2686` — "// Temporal supersession (issue #375): when the new fact has structured // attributes, retire any older fact with the s…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2687` — "// attributes, retire any older fact with the same entity + attribute"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2688` — "// key that has a conflicting value. Faithfulness gate (#1576, cursor"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2689` — "// High): skip for a pending_review fact — an unfaithful extraction in"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2690` — "// the review queue must NOT retire older active memories."
