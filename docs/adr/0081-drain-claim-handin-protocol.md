# Drain claims use fenced owner leases with append-only hand-in inboxes

Status: accepted

## Context
A drain claim must survive crashes, concurrent drainers, and cross-list moves of
pending turns without ever losing or duplicating a turn. Cached or parsed counts can
be stale, and a claim whose inbox only repeats already-drained turns would otherwise
read as unfinished forever.

## Decision
Drain claims are fenced by `ownerId`: progress replaces the claim content with
what is left to do, and lease extension is serialized on the claim lock so a stale
heartbeat that lost ownership reports "lost" instead of clobbering the new owner.

Hand-ins are append-only inboxes; a live buffer owner memoizes what it already
handed in (by digests, not identity keys, since a key embeds the whole turn text)
so the next hand-in carries only the delta, and an evicted memo simply causes a
full hand-in.

Ordering rules for ambiguous identities:
- Equal identities across source lists cannot reveal which original occurrence
  survived a cross-list move; keep ALL source lists pending until a later progress
  write removes every copy.
- A pending copy that crossed lists stays tombstoned in its ORIGINAL list once
  extracted; a copy that crosses back is home again.
- Source occurrences of an ambiguous identity are restored BEFORE late arrivals are
  appended, so a late equal turn cannot stand in for them.

Listing and counting:
- A claim's listing comes from its summary plus its inbox; the body is never parsed
  for a count. Unknown-but-positive counts keep the claim a candidate and the drain
  counts the inbox exactly.
- Cached counts may only answer FALSE (pending turns, nothing drained); a stale
  cache in that direction costs one deferred tombstone. They must never answer TRUE
  — a TRUE releases the claim and unlinks pending turns. Every TRUE is verified by
  one real fold, once per finished drain.
- Compact a claim whose inbox only repeats drained turns, but keep the empty claim
  as a tombstone until its live owner consumes it.
- Paged scans use the LAST CONSUMED entry name as the cursor: the next page starts
  strictly after it, so no claim is ever skipped at a page boundary.

Oldest-age bounds for drain totals use the body sidecar's turn timestamp when it
parses, else the body mtime as a lower bound, plus the inbox mtime (the file only
grows by appends, so its mtime is a lower bound on the oldest turn inside it); the
per-claim minimum competes in the global minimum on its own basis.

Rollback folds every claim's inbox into its body and deletes the inboxes so a build
predating inboxes reads the same state.

## Consequences
The inboxes and fences trade a little extra I/O (hand-in memos, fold verification, mtime stats) for the invariant that no pending turn is dropped or double-counted across crashes and races.

## Origin comments
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:781` — "// record's newline instead of fusing into it."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:789` — "/** Drainer progress: replace the claim content with what is left to do. * * Fenced: `ownerId` must still match the clai"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:834` — "// Equal identities across source lists cannot reveal which original"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:835` — "// occurrence survived a cross-list move. Keep both source lists"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:836` — "// pending until a later progress write removes every copy."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:857` — "// A pending copy that crossed lists stays tombstoned in its ORIGINAL"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:858` — "// list too once it is extracted. A copy that crosses back is home again."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:877` — "// Source occurrences of an ambiguous identity are restored BEFORE late"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:878` — "// arrivals are appended, so a late equal turn cannot stand in for them."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:900` — "/** Extend the lease. \"lost\" means another drainer took the claim over. * Serialized on the claim lock so a stale heartb"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:945` — "// Compact here too: a claim whose inbox only repeats drained turns"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:946` — "// would otherwise keep reading as unfinished forever."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:949` — "// Keep the empty claim as a tombstone until its live owner consumes it."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:988` — "// This runs on every hand-over save. The cached counts may only answer"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:989` — "// FALSE (pending turns, nothing drained): a stale cache in that direction"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:990` — "// costs a deferred tombstone. They must never answer TRUE, because the"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:991` — "// caller then releases the claim and unlinks whatever is still pending, and"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:992` — "// a same-size rewrite inside one mtime tick can leave a stale cache that"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:993` — "// says \"nothing pending\". So a TRUE is verified by one real fold, once per"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:994` — "// finished drain."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1021` — "/** * One claim's listing from its summary plus its inbox: the body is never * parsed for a count. While an inbox is unf"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1038` — "// Unknown but positive: the claim stays a candidate, and the drain counts the inbox exactly."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1065` — "/** * Paged listing for bounded periodic scans: at most `limit` claims with * pending turns, starting AFTER `afterName` "
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1081` — "// The cursor is the LAST CONSUMED entry name: the next page starts"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1082` — "// strictly after it, so the first unconsumed name is never skipped."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1083` — "// Returning the first unconsumed name instead would make every page"
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1084` — "// boundary permanently skip one claim."
- `packages/remnic-core/src/storage/buffer-drain-claims.ts:1099` — "/** * Rollback helper: fold every claim's inbox into its body and delete the * inboxes, so a build that predates the inb"
- `packages/remnic-core/src/storage/buffer-drain-handin-memo.ts:1` — "/** * What a live buffer owner has already handed to a drain claim's inbox, so the * next hand-in carries only what is n"
- `packages/remnic-core/src/storage/buffer-drain-handin-memo.ts:24` — "/** Claims remembered at once; an evicted claim just gets a full hand-in next. */"
- `packages/remnic-core/src/storage/buffer-drain-handin-memo.ts:35` — "/** Digests, not identity keys: a key embeds the whole turn text. */"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:141` — "// Hand-in inbox: appended after the body counts were cached, so a non-empty"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:142` — "// inbox holds pending turns the sidecar does not know about. One extra"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:143` — "// stat per claim, no parse \u2014 the file only ever grows by appends, so its"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:144` — "// mtime is a lower bound on the oldest turn inside it."
- `packages/remnic-core/src/storage/drain-claim-totals.ts:149` — "// Oldest-age candidates. The sidecar's turn timestamp (when it parses,"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:150` — "// else the body mtime as a lower bound \u2014 see DrainClaimTotals doc)"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:151` — "// describes the body's turns only while pending > 0; the inbox mtime"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:152` — "// covers the hand-ins. The per-claim minimum competes in the global"
- `packages/remnic-core/src/storage/drain-claim-totals.ts:153` — "// minimum with its own basis."
