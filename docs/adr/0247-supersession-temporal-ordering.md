# Supersession ordering is driven by persisted validity timestamps with a monotonic clamp

Status: accepted

## Context
Concurrent writers and replayed events make wall-clock sampling produce wrong-direction supersession and nonsensical timestamps (a supersededAt preceding the old memory's own creation). Persisted-validity ordering plus the monotonic clamp keep the bitemporal record coherent; the cost is that ordering depends on the durability of `valid_at`/`created` on disk.

## Decision
When a new fact supersedes an old one, ordering and the written timestamps derive from persisted temporal fields, not wall-clock samples, and timestamps never run backwards.

Rules:
- The caller's ordering anchor is validated before any corpus scan or durable side-effect preparation; a malformed timestamp is a true no-op (a later clamp must never manufacture a 1970 mutation or leave a propagation job without a replayable temporal identity).
- The old fact must be strictly older than the new fact's effective validity start; equal timestamps are ignored to avoid same-millisecond races. When replay/import supplies `valid_at`, it drives ordering instead of persistence wall-clock; otherwise the newly-written memory's persisted `created` is the legacy fallback, falling back to `args.createdAt` if the memory is not yet visible in the cache during fast concurrent writes.
- On the hash-dedup early-return path (no new file is written; `newMemoryId` is the old fact), `useCallerTimestamp` opts out of the persisted-timestamp lookup so `args.createdAt` — the incoming event time: source valid_at when present, otherwise wall-clock — is used directly, keeping ordering correct regardless of how old the matching fact is.
- `supersededAt`/`updated` written to the old fact are clamped to the monotonic maximum of the new fact's persisted `created`, the old fact's persisted `created`, and the caller-supplied `args.createdAt` — time only moves forward, for hot and cold tiers alike.
- On supersession the predecessor's `invalid_at` is set to the successor's effective `valid_at`, preserving any pre-existing `invalid_at` (idempotent). In the dedup path the persisted created time is used directly so `invalid_at` aligns with the caller's wall-clock rather than the matching fact's old `valid_at`; the non-dedup path prefers the new file's explicit valid_at, falling back to its persisted created.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/temporal-supersession.ts:184` — "// Must be older than the new fact's effective validity start — equal"
- `packages/remnic-core/src/temporal-supersession.ts:185` — "// timestamps are ignored to avoid races within the same millisecond. When"
- `packages/remnic-core/src/temporal-supersession.ts:186` — "// replay/import supplies source time, valid_at must drive ordering instead"
- `packages/remnic-core/src/temporal-supersession.ts:187` — "// of wall-clock persistence time."
- `packages/remnic-core/src/temporal-supersession.ts:696` — "// Finding 1 fix: use the on-disk effective validity start of the"
- `packages/remnic-core/src/temporal-supersession.ts:697` — "// newly-written memory rather than a wall-clock timestamp sampled after"
- `packages/remnic-core/src/temporal-supersession.ts:698` — "// `writeMemory` returns. In concurrent writers the two can differ by enough"
- `packages/remnic-core/src/temporal-supersession.ts:699` — "// to cause wrong-direction supersession. If source replay/import provided"
- `packages/remnic-core/src/temporal-supersession.ts:700` — "// valid_at, it must drive ordering; otherwise created remains the legacy"
- `packages/remnic-core/src/temporal-supersession.ts:701` — "// fallback. If the memory is not yet visible in the cache (edge case during"
- `packages/remnic-core/src/temporal-supersession.ts:702` — "// fast concurrent writes) fall back to args.createdAt."
- `packages/remnic-core/src/temporal-supersession.ts:704` — "// PR #402 round-12 (Finding Uyui): on the hash-dedup early-return path the"
- `packages/remnic-core/src/temporal-supersession.ts:705` — "// caller supplies the OLD matching fact's id as `newMemoryId` (no new file is"
- `packages/remnic-core/src/temporal-supersession.ts:706` — "// written). That makes `newMemoryFile.frontmatter.created` an arbitrarily"
- `packages/remnic-core/src/temporal-supersession.ts:707` — "// old timestamp. When `args.useCallerTimestamp` is set the caller explicitly"
- `packages/remnic-core/src/temporal-supersession.ts:708` — "// opts out of the persisted-timestamp lookup so `args.createdAt` (the"
- `packages/remnic-core/src/temporal-supersession.ts:709` — "// incoming event time: source valid_at when present, otherwise wall-clock) is"
- `packages/remnic-core/src/temporal-supersession.ts:710` — "// used directly, keeping ordering correct regardless of how old the matching"
- `packages/remnic-core/src/temporal-supersession.ts:711` — "// fact is."
- `packages/remnic-core/src/temporal-supersession.ts:849` — "// Finding 2 fix: the `supersededAt` / `updated` timestamps written to the"
- `packages/remnic-core/src/temporal-supersession.ts:850` — "// old fact must never run backwards relative to its own persisted"
- `packages/remnic-core/src/temporal-supersession.ts:851` — "// `created` timestamp. If the caller-supplied `args.createdAt` (which"
- `packages/remnic-core/src/temporal-supersession.ts:852` — "// represents "when the new replacing fact was authored") is earlier than"
- `packages/remnic-core/src/temporal-supersession.ts:853` — "// either the new fact's persisted `created` (T_new) or the old fact's"
- `packages/remnic-core/src/temporal-supersession.ts:854` — "// persisted `created` (T_old), we'd be writing a nonsensical"
- `packages/remnic-core/src/temporal-supersession.ts:855` — "// `supersededAt` that precedes the old memory's own creation. Clamp to"
- `packages/remnic-core/src/temporal-supersession.ts:856` — "// the monotonic maximum so time only moves forward."
- `packages/remnic-core/src/temporal-supersession.ts:857` — "// This monotonic clamp is applied for both hot and cold tier writes."
- `packages/remnic-core/src/temporal-supersession.ts:669` — "// Validate the caller's ordering anchor before any corpus scan or durable"
- `packages/remnic-core/src/temporal-supersession.ts:670` — "// side-effect preparation. A malformed timestamp must be a true no-op:"
- `packages/remnic-core/src/temporal-supersession.ts:671` — "// otherwise a later monotonic clamp could manufacture a 1970 mutation and"
- `packages/remnic-core/src/temporal-supersession.ts:672` — "// leave a prepared propagation job without a replayable temporal identity."
- `packages/remnic-core/src/temporal-supersession.ts:868` — "// Issue #680 — explicit fact lifecycle. When the new fact"
- `packages/remnic-core/src/temporal-supersession.ts:869` — "// supersedes this one, set the predecessor's `invalid_at` to the"
- `packages/remnic-core/src/temporal-supersession.ts:870` — "// successor's effective valid_at. Skip when the predecessor"
- `packages/remnic-core/src/temporal-supersession.ts:871` — "// already carries an `invalid_at` so manual / earlier values"
- `packages/remnic-core/src/temporal-supersession.ts:872` — "// are preserved (idempotent)."
- `packages/remnic-core/src/temporal-supersession.ts:874` — "// Codex P1 on PR #713: in the hash-dedup early-return path"
- `packages/remnic-core/src/temporal-supersession.ts:875` — "// (`useCallerTimestamp: true`), `newMemoryFile` is actually the"
- `packages/remnic-core/src/temporal-supersession.ts:876` — "// OLD matching fact — no new file was written — so its"
- `packages/remnic-core/src/temporal-supersession.ts:877` — "// `valid_at` is the predecessor's own old timestamp, not the"
- `packages/remnic-core/src/temporal-supersession.ts:878` — "// successor's effective time. Use `persistedCreatedAt`"
- `packages/remnic-core/src/temporal-supersession.ts:879` — "// directly in that path so the predecessor's invalid_at lines"
- `packages/remnic-core/src/temporal-supersession.ts:880` — "// up with the caller's wall-clock, not the matching fact's old"
- `packages/remnic-core/src/temporal-supersession.ts:881` — "// valid_at. The non-dedup path keeps the previous behavior"
- `packages/remnic-core/src/temporal-supersession.ts:882` — "// (prefer the new file's explicit valid_at, fall back to its"
- `packages/remnic-core/src/temporal-supersession.ts:883` — "// persisted created)."
