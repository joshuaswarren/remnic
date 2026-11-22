# Entity references are canonicalized at the write, with post-write repair and a single post-import reconcile marker

Status: accepted

## Context
Peer migrations can complete during any await in a long import; snapshot-time canonicalization would strand references irreversibly. Write-time resolution plus repair and a single deferred marker cost one extra journal read and lstat per record, and pre-write snapshots on collision paths.

## Decision
Memory-tier records from capsules get their entityRef resolved through the target's migration journal at the moment of each write, never from a pre-import snapshot.

Rules:
- Read the migration journal through the identity-keyed cache PER RECORD (one lstat per record) so a peer migration completing mid-import/merge is picked up for every record written after it — the completed migration journal is a write boundary, and no recurring reconciliation pass exists to absorb a stale ref afterwards.
- Write with the ref resolved at the write, then REPAIR after the write if the journal moved across it (peer migrations complete during snapshot/mkdir awaits; capsule writes bump only the corpus version, which the migration fingerprint deliberately ignores). A parked mapping cannot be fixed after the fact. Only memory-tier records canonicalize; entities/ pages carry relationship targets only that rewriteRelationshipTargets understands and import/merge byte-faithful behind a reconcile marker; everything else is lossless.
- Memories whose ref targets a capsule-supplied entity id (potential collision claimant) keep legacy bytes behind the deferred marker so the migration settles the collision and rewrites per its verdict — canonicalizing early would permanently misattribute the memory onto the wrong claimant.
- The reconcile marker is published exactly once, after every record including collision claimants is on disk; a per-record marker could be consumed by a peer between a legacy-preserving memory write and its colliding entity page.
- Snapshot pre-write bytes so a repair failure after the write restores them (or removes a newly created target) before propagating — the import/merge reports failure, so disk must return to its pre-write state and warm caches stay consistent.
- Bump the corpus sentinel per write, inside the loop, so a concurrent readAllMemories mid-batch rescans and never serves the pre-import corpus; no after-batch bump. In merge, the corpus bump lands after the repair so a warm-cache rescan never captures pre-repair bytes. A local copy already holding the canonicalized form (computed after the local read) is done; a copy matching raw archive bytes while a mapping applies is upgraded in place — skipping would leave the legacy entityRef on disk forever since corpus bumps no longer trigger migration rewrites. An identical verdict is valid only for the snapshot it was computed under; a moved journal falls through to the write path.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/transfer/capsule-import.ts:393` — "// The target's completed migration journal is a write boundary here too"
- `packages/remnic-core/src/transfer/capsule-import.ts:394` — "// (issue #2213): a capsule can carry pre-migration memories whose entityRef"
- `packages/remnic-core/src/transfer/capsule-import.ts:395` — "// the target already renamed, and no recurring reconciliation pass exists"
- `packages/remnic-core/src/transfer/capsule-import.ts:396` — "// to absorb a stale ref after the fact. Read through the identity-keyed"
- `packages/remnic-core/src/transfer/capsule-import.ts:397` — "// cache PER RECORD so a peer migration completing mid-import is picked up"
- `packages/remnic-core/src/transfer/capsule-import.ts:398` — "// for every record written after it (one lstat per record)."
- `packages/remnic-core/src/transfer/capsule-import.ts:401` — "// Entity pages in THIS capsule can re-establish collisions the target's"
- `packages/remnic-core/src/transfer/capsule-import.ts:402` — "// journal already resolved (Codex P1): once the next migration parks the"
- `packages/remnic-core/src/transfer/capsule-import.ts:403` — "// mapping, a memory canonicalized onto the canonical claimant is"
- `packages/remnic-core/src/transfer/capsule-import.ts:404` — "// permanently misattributed. Memories whose ref targets a capsule-supplied"
- `packages/remnic-core/src/transfer/capsule-import.ts:405` — "// entity id import byte-faithful behind the reconcile marker instead; the"
- `packages/remnic-core/src/transfer/capsule-import.ts:406` — "// migration settles the collision and rewrites references per its verdict."
- `packages/remnic-core/src/transfer/capsule-import.ts:421` — "// The reconcile marker is published ONCE, after every record landed"
- `packages/remnic-core/src/transfer/capsule-import.ts:422` — "// (Codex P1, round 21): a per-record marker could be consumed by a peer"
- `packages/remnic-core/src/transfer/capsule-import.ts:423` — "// between a legacy-preserving memory write and its colliding entity page,"
- `packages/remnic-core/src/transfer/capsule-import.ts:424` — "// canonicalizing the memory onto the wrong claimant irreversibly."
- `packages/remnic-core/src/transfer/capsule-import.ts:475` — "// Resolve at the write itself (mirrors capsule-merge): a peer migration"
- `packages/remnic-core/src/transfer/capsule-import.ts:476` — "// can complete during the snapshot/mkdir awaits, and capsule writes bump"
- `packages/remnic-core/src/transfer/capsule-import.ts:477` — "// only the corpus version, which the migration fingerprint ignores. The"
- `packages/remnic-core/src/transfer/capsule-import.ts:478` — "// post-write REPAIR re-canonicalizes and rewrites when the journal moved"
- `packages/remnic-core/src/transfer/capsule-import.ts:479` — "// across the write itself (a parked mapping cannot be fixed after the"
- `packages/remnic-core/src/transfer/capsule-import.ts:480` — "// fact by the reconcile pass). Only memory-tier records canonicalize;"
- `packages/remnic-core/src/transfer/capsule-import.ts:481` — "// entities/ pages carry relationship TARGETS only"
- `packages/remnic-core/src/transfer/capsule-import.ts:482` — "// rewriteRelationshipTargets understands, so they import byte-faithful"
- `packages/remnic-core/src/transfer/capsule-import.ts:483` — "// with a reconcile marker; everything else imports losslessly."
- `packages/remnic-core/src/transfer/capsule-import.ts:487` — "// Ref targets a capsule-supplied entity page (potential collision"
- `packages/remnic-core/src/transfer/capsule-import.ts:488` — "// claimant): keep the legacy bytes; the DEFERRED marker below lets the"
- `packages/remnic-core/src/transfer/capsule-import.ts:489` — "// migration settle the collision and rewrite per its verdict (Codex P1)."
- `packages/remnic-core/src/transfer/capsule-import.ts:496` — "// Snapshot the pre-write bytes: a repair failure after the write must"
- `packages/remnic-core/src/transfer/capsule-import.ts:497` — "// restore them (or remove a newly created target), or the import"
- `packages/remnic-core/src/transfer/capsule-import.ts:498` — "// reports failure while an overwrite already destroyed the prior state"
- `packages/remnic-core/src/transfer/capsule-import.ts:499` — "// and the skipped corpus bump leaves warm caches stale (AGENTS.md §14)."
- `packages/remnic-core/src/transfer/capsule-import.ts:537` — "// Every record — including every collision claimant entity page — is on"
- `packages/remnic-core/src/transfer/capsule-import.ts:538` — "// disk; NOW the reconcile pass can settle collisions safely."
- `packages/remnic-core/src/transfer/capsule-import.ts:525` — "// Bump the corpus sentinel per write (Cursor Medium, #1902): a concurrent"
- `packages/remnic-core/src/transfer/capsule-import.ts:526` — "// readAllMemories during the import must rescan and see records already on"
- `packages/remnic-core/src/transfer/capsule-import.ts:527` — "// disk, never the pre-import corpus, mid-batch."
- `packages/remnic-core/src/transfer/capsule-import.ts:557` — "// Per-record corpus bumps happen inside the loop above (Cursor Medium,"
- `packages/remnic-core/src/transfer/capsule-import.ts:558` — "// #1902); no after-batch bump needed here."
- `packages/remnic-core/src/transfer/capsule-merge.ts:353` — "// Same write-boundary rule as capsule-import (issue #2213): records land"
- `packages/remnic-core/src/transfer/capsule-merge.ts:354` — "// with their entityRef resolved through the target's migration journal,"
- `packages/remnic-core/src/transfer/capsule-merge.ts:355` — "// read through the identity-keyed cache PER RECORD so a peer migration"
- `packages/remnic-core/src/transfer/capsule-merge.ts:356` — "// completing mid-merge is picked up for every record written after it."
- `packages/remnic-core/src/transfer/capsule-merge.ts:359` — "// Entity pages in THIS capsule can re-establish collisions the target's"
- `packages/remnic-core/src/transfer/capsule-merge.ts:360` — "// journal already resolved (Codex P1): once the next migration parks the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:361` — "// mapping, a memory canonicalized onto the canonical claimant is"
- `packages/remnic-core/src/transfer/capsule-merge.ts:362` — "// permanently misattributed. Memories whose ref targets a capsule-supplied"
- `packages/remnic-core/src/transfer/capsule-merge.ts:363` — "// entity id merge byte-faithful behind the reconcile marker instead."
- `packages/remnic-core/src/transfer/capsule-merge.ts:370` — "// Write a record with its entityRef resolved AT the write, then repair if"
- `packages/remnic-core/src/transfer/capsule-merge.ts:371` — "// the journal moved across the write itself — a parked mapping cannot be"
- `packages/remnic-core/src/transfer/capsule-merge.ts:372` — "// fixed after the fact by the reconcile pass (issue #2213). Only memory-tier"
- `packages/remnic-core/src/transfer/capsule-merge.ts:373` — "// records canonicalize; entities/ pages carry relationship TARGETS only"
- `packages/remnic-core/src/transfer/capsule-merge.ts:374` — "// rewriteRelationshipTargets understands, so they merge byte-faithful with"
- `packages/remnic-core/src/transfer/capsule-merge.ts:375` — "// a reconcile marker; everything else merges losslessly. The corpus bump"
- `packages/remnic-core/src/transfer/capsule-merge.ts:376` — "// lands AFTER the repair so a warm cache rescan never captures pre-repair"
- `packages/remnic-core/src/transfer/capsule-merge.ts:377` — "// bytes."
- `packages/remnic-core/src/transfer/capsule-merge.ts:378` — "// The reconcile marker is published ONCE, after every record landed"
- `packages/remnic-core/src/transfer/capsule-merge.ts:379` — "// (Codex P1, round 21): a per-record marker could be consumed by a peer"
- `packages/remnic-core/src/transfer/capsule-merge.ts:380` — "// between a legacy-preserving memory write and its colliding entity page,"
- `packages/remnic-core/src/transfer/capsule-merge.ts:381` — "// canonicalizing the memory onto the wrong claimant irreversibly."
- `packages/remnic-core/src/transfer/capsule-merge.ts:387` — "// Ref targets a capsule-supplied entity page (potential collision"
- `packages/remnic-core/src/transfer/capsule-merge.ts:388` — "// claimant): keep the legacy bytes; the deferred marker lets the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:389` — "// migration settle the collision and rewrite per its verdict (Codex P1)."
- `packages/remnic-core/src/transfer/capsule-merge.ts:392` — "// per-write bump (Cursor Medium, #1902)"
- `packages/remnic-core/src/transfer/capsule-merge.ts:405` — "// Snapshot the pre-write bytes: a repair failure after the write must"
- `packages/remnic-core/src/transfer/capsule-merge.ts:406` — "// restore them (or remove a newly created target) before propagating —"
- `packages/remnic-core/src/transfer/capsule-merge.ts:407` — "// the merge reports failure, so disk must return to its pre-write state"
- `packages/remnic-core/src/transfer/capsule-merge.ts:408` — "// and warm caches stay consistent (AGENTS.md §14)."
- `packages/remnic-core/src/transfer/capsule-merge.ts:444` — "// No local copy — always write regardless of mode. Resolve at the write"
- `packages/remnic-core/src/transfer/capsule-merge.ts:445` — "// itself and verify the journal afterwards: a peer migration completing"
- `packages/remnic-core/src/transfer/capsule-merge.ts:446` — "// during any of these awaits (or the write) would otherwise strand the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:447` — "// reference — capsule writes bump only the corpus version, which the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:448` — "// migration fingerprint deliberately ignores."
- `packages/remnic-core/src/transfer/capsule-merge.ts:455` — "// Local file exists. A local copy already holding the CANONICALIZED form"
- `packages/remnic-core/src/transfer/capsule-merge.ts:456` — "// (computed AFTER the local read, so a journal published during that"
- `packages/remnic-core/src/transfer/capsule-merge.ts:457` — "// await is reflected) is done. A local copy matching the RAW archive"
- `packages/remnic-core/src/transfer/capsule-merge.ts:458` — "// bytes while a mapping applies is UPGRADED in place — skipping would"
- `packages/remnic-core/src/transfer/capsule-merge.ts:459` — "// leave the legacy entityRef on disk forever, since corpus bumps no"
- `packages/remnic-core/src/transfer/capsule-merge.ts:460` — "// longer trigger migration rewrites (issue #2213)."
- `packages/remnic-core/src/transfer/capsule-merge.ts:472` — "// The identical verdict is only valid for the snapshot it was computed"
- `packages/remnic-core/src/transfer/capsule-merge.ts:473` — "// under (Codex P1): a mapping parked/removed mid-compare can make the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:474` — "// local copy's formerly-canonical ref stale with nothing left to repair"
- `packages/remnic-core/src/transfer/capsule-merge.ts:475` — "// it. A moved journal falls through to the write path, which resolves at"
- `packages/remnic-core/src/transfer/capsule-merge.ts:476` — "// the write and repairs after it."
- `packages/remnic-core/src/transfer/capsule-merge.ts:517` — "// Same write-time re-resolve + post-write repair as above — the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:518` — "// snapshot/read awaits give a peer migration a real window."
- `packages/remnic-core/src/transfer/capsule-merge.ts:523` — "// Every record — including every collision claimant entity page — is on"
- `packages/remnic-core/src/transfer/capsule-merge.ts:524` — "// disk; NOW the reconcile pass can settle collisions safely."
- `packages/remnic-core/src/transfer/capsule-merge.ts:545` — "// Per-write corpus bumps happen inside the loop above (Cursor Medium, #1902):"
- `packages/remnic-core/src/transfer/capsule-merge.ts:546` — "// a concurrent readAllMemories during the merge rescans and never serves the"
- `packages/remnic-core/src/transfer/capsule-merge.ts:547` — "// pre-merge corpus mid-batch."
