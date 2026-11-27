# Dedup Hash Discipline and Match Scoping

Status: accepted

## Context
Content-hash dedup suppresses writes, so both sides of the comparison must
describe the same bytes, and a wrong match permanently hides a fact. The
stored hash index records a canonicalized body, while candidate content
arrives with citations, attribute suffixes, procedure titles, and salvage
clamping applied at different times. Match scope matters as much as the hash:
identical text from a different connector is not a duplicate, identical text
under a different entity corrupts supersededBy links if used, and a
high-similarity hit in another namespace would cause cross-namespace write
suppression. Concurrent writers also race through the short
recheck-then-write window.

## Decision
Rules for content-hash dedup matching:

- The dedup key is computed with exactly the canonicalization the write path
  applies: strip any pre-existing citation, sanitize, normalize attribute
  pairs, and hash the enriched body writeMemory stores. For procedures, key
  on the full serialized body (title + steps); strip the stored
  `[Attributes: ...]` suffix before comparing.
- Match only within scope: same connector (different connectors with the
  same content are NOT duplicates), same normalized entityRef (hash equality
  across entities is a collision, never an anchor), and the resolved target
  namespace's embedding index for semantic dedup.
- The dedup window serializes the recheck-then-write window per storage dir
  and holds one corpus confirm plus one memory write — never a scan-length
  lock. A lookup returns the MISS together with the authority behind it
  atomically, so a stale MISS is never paired with authority from another
  moment.
- The authoritative rebuild unions the HOT and COLD tiers: a cold-only active
  copy still confirms the duplicate.
- Register content in the hash index only for persisted, active writes. Never
  register a hash for a skipped, pending_review, or tombstone-blocked fact;
  a lingering hash with no backing record permanently suppresses
  exact-copy writes.
- The post-write race recheck mirrors the persist-time suppression gates, and
  committed writes are finalized before a fail-closed window throw
  propagates.

## Consequences
Any new write path must reuse the same canonicalization helpers or dedup
silently misses, leaving stale facts active. Scoped matching costs extra
lookups (connector, entity, namespace) on every candidate. The window is
deliberately narrow: contention throws fail-closed instead of queuing.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:169` — "Snapshot once — Map iterators are single-pass."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:429` — "// Connector-aware dedup (QOjlD): verify a same-connector"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:430` — "// active fact exists before skipping the promotion write."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:431` — "// Different connectors with same content should NOT be deduped."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:465` — "// #2014 round 3: the envelope's SURVIVING entityRef — the raw"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:466` — "// option can differ (untrimmed/dropped) from what sealed"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:467` — "// writes persisted, mistargeting the backfill row."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:614` — "// Dedup gate: strip any pre-existing citation, sanitize, and build"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:615` — "// the attribute-enriched body with normalizeAttributePairs — the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:616` — "// same canonicalization writeMemory applies — so the hash lookup"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:617` — "// uses the exact body writeMemory stores (#369/#401, #402 round-6)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:652` — "// Connector identity gate: backfill bounds only onto a same-connector fact (no cross-patch)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:695` — "// #2014 round 3: envelope-surviving entityRef (see profile-target)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:725` — "// Fix #2 (P2 PRRT_kwDORJXyws56VHZf): dedupContent is now built"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:726` — "// from sanitizedBase.text (see fix #4 above), so normalizedIncoming"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:727` — "// uses the same sanitized+normalized content that writeMemory hashes"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:728` — "// and that hasFactContentHash just matched. Previously this used the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:729` — "// raw options.content, which diverged from the stored hash when"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:730` — "// sanitization redacted the content, causing the candidate lookup to"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:731` — "// return undefined and leaving stale facts active."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:734` — "// PR #402 round-12 (Finding Uybg): restrict hash-dedup matching to"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:735` — "// the SAME entity. Content-hash equality alone can collide across"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:736` — "// entities when two entities share identical fact text. Using an"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:737` — "// unrelated entity's existing fact as `newMemoryId` would anchor"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:738` — "// supersession to that entity's record and corrupt its"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:739` — "// `supersededBy` links. Only consider facts whose normalized"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:740` — "// `entityRef` matches the incoming entity."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:753` — "// PR #402 round-7 (Fix #2): compare stored fact's full body"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:754` — "// (including any appended \"[Attributes: ...]\" suffix) against the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:755` — "// enriched normalizedIncoming so the candidate selected is the one"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:756` — "// whose hash actually matched in hasFactContentHash."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:758` — "// Connector-aware dedup: same content from different connectors"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:759` — "// is NOT a duplicate (review thread QOjlD)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:843` — "// Connector-aware dedup (QPAn-): when temporal supersession is off"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:844` — "// or the fact has no entity/structuredAttributes, the original"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:845` — "// short-circuit would drop a different-connector fact. Verify a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:846` — "// same-connector active fact exists before skipping the shared"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:847` — "// promotion write; otherwise fall through so the new connector's"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:848` — "// fact gets its own promoted copy."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1536` — "// Canonicalize pre-tagged facts before hashing (Codex P2 — issue #369)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1537` — "// When a fact already carries an inline citation (e.g. relayed or"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1538` — "// reprocessed), hashing `fact.content` as-is would produce a different"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1539` — "// hash than the one stored from the original write (which used the raw,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1540` — "// un-cited body as contentHashSource). Strip any citation first so the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1541` — "// dedup key matches what the hash index recorded."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1543` — "// stripCitationForTemplate handles both the default and custom template"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1544` — "// formats. For all-placeholder templates it cannot detect citations and"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1545` — "// returns the text unchanged — dedup may miss in that edge case, which"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1546` — "// is acceptable (no false-positive suppression)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1658` — "// Procedures: fingerprint the full serialized body (title + steps), not"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1659` — "// the title alone, so distinct step lists are not collapsed (issue #519)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1705` — "// PR #2016/#3231: finalize committed writes before a fail-closed"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1706` — "// window throw propagates (PRRT_kwDORJXyws6zxG6H)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1714` — "// Gates mirror the persist-time suppression gates (PR #2016 SD-nH; #1645 quarantine)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1916` — "// Same connector scoping as decideSemanticDedup below: a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1917` — "// cross-connector neighbor must not noop this candidate."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1932` — "// Pass the resolved target storage so the lookup scopes the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1933` — "// embedding index to the target namespace (PR #399 P1 fix)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1934` — "// Without this, a high-similarity hit in a different namespace"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1935` — "// would cause the fact to be dropped here — cross-namespace"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1936` — "// write suppression / data loss."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1938` — "// PR #1852 review finding on 7e0eb1a0: forward the candidate's"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1939` — "// sourceConnector so the connector-aware skip gate can refuse to"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1940` — "// drop a connector B paraphrase against connector A's memory."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2097` — "// Do NOT add fact.content to contentHashIndex here. No memory was"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2098` — "// persisted for this fact, so registering a synthetic hash would"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2099` — "// permanently suppress exact-copy writes once the neighbor memory is"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2100` — "// archived or deleted (the hash would linger with no backing record)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2414` — "// Thread 3 fix: canonicalize by stripping any pre-existing citation"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2415` — "// so the stored hash matches what the dedup check computes."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2423` — "// dedup index — writeMemory already skipped it (rule 44). Re-adding"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2424` — "// would let the next extraction dedup-skip the tombstone chokepoint"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2425` — "// and silently ban the retired content (no pending_review row)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2455` — "// timestamp as the parent memory write above (Fix #3 — duplicate-citation)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2605` — "// sources + the coarse strength tag from the extraction validator"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2606` — "// through to frontmatter so they survive end-to-end."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2610` — "// rule): a peer loading an authoritative index after the release"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2611` — "// must see this hash, or its recheck misses and duplicates it."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2616` — "// indexes facts only (rule 44 #1579), so non-fact categories"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2617` — "// previously registered after the window released, letting a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2618` — "// concurrent session's in-window recheck miss and both write the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2619` — "// same content (issue #3312). Fail-open, like the post-write"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2620` — "// registration this replaces."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2810` — "// timestamp as the memory write above (Fix #3 — duplicate-citation)."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:13` — "Fact-dedup commit window (codex P2, #1526): serializes the short recheck->write window per storage dir, fail-closed lock; persist-time check stays outside"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:38` — "Thread 5 (QPDE5): for procedures the hash is keyed on the full body"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:39` — "body (title + steps via buildProcedurePersistBody), so compare"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:40` — "against contentHashDedupKey — not the canonical title-only form."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:41` — "Thread 3 (QO42V): facts with structuredAttributes get an appended"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:42` — "[Attributes: ...] suffix in the stored body that the hash key lacks;"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:43` — "strip it before comparing so same-connector enriched facts dedup"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:44` — "correctly."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:63` — "One lookup returns the MISS together with the authority behind it"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:64` — "stale MISS is never paired with authority from another moment"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:65` — "second read of authority can rebuild the index and bless it (#3312)."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:73` — "#2016 cold-tier finding: the authoritative content-hash rebuild unions"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:74` — "the HOT and COLD tiers, so a cold-only active copy must still confirm"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:75` — "the duplicate and suppress the redundant hot write."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:107` — "Bounded: the window holds one corpus confirm + one memory write, not a"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:108` — "scan-length lock (catalog round 5 adoption note)."
