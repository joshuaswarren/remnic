# Incremental reindex advances the index head only on authoritative candidate evidence and retries transient failures

Status: accepted

## Context
The reindex planner decides what to parse, what to prune, and whether the index may
claim freshness. Its inputs are unreliable in specific ways: git history can be rewritten
(unreachable last head), the diff call can fail, the caller may omit the candidate list,
files can vanish transiently (partial worktree, list-vs-disk races), paths can be
symlinks escaping the repo root, and the store itself can be unreadable. Every one of
these was historically conflated with an honest signal: a store read error looked like
"never indexed + empty index" (planning a destructive full reindex), an omitted candidate
list looked like "zero files" (pruning everything or falsely claiming freshness), and a
transient I/O error pruned files that still exist.

## Decision
Freshness claims require authoritative evidence; every transient failure routes to
retry, never to deletion or a false "done":

- Candidate lists are authoritative ONLY when the caller supplied a non-empty one. An
  empty or omitted list is never an authoritative "zero files" signal: it must not drive
  pruning and must not advance `last_indexed_head` — without candidates the run has not
  built an index, and claiming freshness would be dishonest. A genuine empty repo
  (no candidates, no retries) reports its own empty mode rather than advancing head.
- Pruning stored files is allowed only against an authoritative candidate list; pruning
  against a retry-only or scan-only set would destructively delete every successfully
  indexed file. The hash-scan fallback unions caller candidates WITH previously-indexed
  files AND pending retries, so neither newly-added nor newly-deleted files are missed.
- When `last_head` is unreachable (rebase/force-push) or the incremental diff fails, the
  planner degrades to hash_scan — hashing every candidate and re-parsing only mismatches —
  and says so; it never crashes and never silently full-reindexes.
- Paths that failed to parse on a prior run are retried even when HEAD is unchanged (a
  noop plan must not strand them forever); the pending set is rewritten after every run
  with the CURRENT run's failures. New candidates absent on disk (list-vs-disk races) are
  retained in pending so a later run indexes them instead of advancing head as if done. A
  hash-scan candidate whose on-disk hash matches but which was never successfully parsed
  stays pending.
- The read probe distinguishes a confirmed deletion (prune if known) from a transient I/O
  error (keep the stored entry, route to ingest, record for retry) — a transient error is
  never treated as a deletion, and a read failure never silently drops a path that was
  never ingested.
- Store metadata reads (head, file hashes) return tagged results; a backend failure bails
  BEFORE any mutation and is never conflated with "never indexed" or an empty index. The
  snapshot is read once and reused for every prune decision, since nothing mutates the
  store between the read and the ingest.
- Path handling is fail-closed: non-canonical repo-relative paths are rejected before any
  disk access; symlinks that escape repoRoot are rejected before reading (splitting on
  forward slashes and re-joining with the platform separator keeps a Windows backslash in
  a relPath from being treated as an escape). A previously-indexed path that becomes
  non-canonical or escaping has its stale nodes pruned (it is no longer a readable repo
  file) but is not retained as a parse failure; skipped escapes are not pending retries.
  Files are read as a copy-free view over the same buffer to satisfy the FileIR contract
  without duplicating memory.
- Candidate paths are deduplicated (a path can appear in candidates, the commit diff, and
  the pending set at once); reindex runs are serialized per store; index-status changed
  ranges must be non-empty even for deletion-only hunks so they can overlap symbol spans.

## Consequences
The index head only moves when the run actually verified the tree it claims to have
indexed; crashes and partial failures leave a retryable pending set instead of a lying
"fresh" marker; and hostile or broken paths can neither inject arbitrary files into the
graph nor strand valid ones. The costs: runs without candidate lists can never prune or
claim freshness (conservative by construction), hash-scan fallback re-hashes every
candidate, and the pending-set machinery adds a metadata read/write per run.

Theme coverage: Records under the reindex planner/executor topics (including the reindex test comments and copy-free-buffer-view).

## Origin comments
- `packages/coding-graph/src/index-status.test.ts:246` — "// Must be a non-empty range so it can overlap a symbol span."
- `packages/coding-graph/src/reindex.test.ts:573` — "// Close the store: readMeta / readFileHashes now return tagged"
- `packages/coding-graph/src/reindex.test.ts:574` — "// store_closed failures (rule 22). Before the fix they returned null /"
- `packages/coding-graph/src/reindex.test.ts:575` — "// empty-Map, so the executor treated an unreadable store as "never"
- `packages/coding-graph/src/reindex.test.ts:576` — "// indexed + empty index", planned a full reindex, and could advance"
- `packages/coding-graph/src/reindex.test.ts:577` — "// head or misjudge pruning. Now the read bails with store_error before"
- `packages/coding-graph/src/reindex.test.ts:578` — "// any mutation."
- `packages/coding-graph/src/reindex.test.ts:655` — "// Second run: HEAD unchanged → plan is noop, but pending is non-empty"
- `packages/coding-graph/src/reindex.test.ts:656` — "// so a.ts MUST retry. Without the fix this run is a true noop and"
- `packages/coding-graph/src/reindex.test.ts:657` — "// a.ts would stay missing forever."
- `packages/coding-graph/src/reindex.test.ts:689` — "// No candidates → nothing was indexed. Must NOT claim freshness by"
- `packages/coding-graph/src/reindex.test.ts:690` — "// writing last_indexed_head (index_status would otherwise report"
- `packages/coding-graph/src/reindex.test.ts:691` — "// "fresh" over an empty graph)."
- `packages/coding-graph/src/reindex.test.ts:825` — "// The traversal path must still be in pending (retry-safe) but must"
- `packages/coding-graph/src/reindex.test.ts:826` — "// NOT have been read — verify it stays pending."
- `packages/coding-graph/src/reindex.test.ts:952` — "// A file is added in the new HEAD, then force-push makes the base"
- `packages/coding-graph/src/reindex.test.ts:953` — "// unreachable → hash_scan. The caller OMITS candidatePaths, so the scan"
- `packages/coding-graph/src/reindex.test.ts:954` — "// covers only stored+pending paths and cannot see src/new.ts. Advancing"
- `packages/coding-graph/src/reindex.test.ts:955` — "// head here would falsely report freshness while src/new.ts is unindexed."
- `packages/coding-graph/src/reindex.test.ts:979` — "// Force-push → hash_scan. src/a.ts is unchanged, so its on-disk hash MATCHES"
- `packages/coding-graph/src/reindex.test.ts:980` — "// the stored hash and it is NOT re-ingested. It must nonetheless REMAIN in"
- `packages/coding-graph/src/reindex.test.ts:981` — "// pending (a future full/incremental run must still retry parsing it) — the"
- `packages/coding-graph/src/reindex.test.ts:982` — "// old code dropped it because it was neither a fresh parse failure nor a"
- `packages/coding-graph/src/reindex.test.ts:983` — "// transient retry."
- `packages/coding-graph/src/reindex.test.ts:1009` — "// A canonical relative path can still be a symlink whose target lives"
- `packages/coding-graph/src/reindex.test.ts:1010` — "// outside repoRoot; following it would read arbitrary files into the graph."
- `packages/coding-graph/src/reindex.test.ts:1024` — "// Force-push → hash_scan with an EXPLICIT empty list. An empty list is not"
- `packages/coding-graph/src/reindex.test.ts:1025` — "// an authoritative "zero files" signal, so head must NOT advance (same as"
- `packages/coding-graph/src/reindex.test.ts:1026` — "// omitted)."
- `packages/coding-graph/src/reindex.test.ts:1068` — "// Only src/b.ts changes; src/a.ts is NOT re-ingested, so its lsp-only"
- `packages/coding-graph/src/reindex.test.ts:1069` — "// edge must survive — ingested files are changed-or-fresh by"
- `packages/coding-graph/src/reindex.test.ts:1070` — "// construction, which is the invariant that keeps the [heuristic, lsp]"
- `packages/coding-graph/src/reindex.test.ts:1071` — "// assertion scope safe for lsp-only edges on untouched files."
- `packages/coding-graph/src/reindex.ts:1` — "Incremental git-based reindex for the coding-graph"
- `packages/coding-graph/src/reindex.ts:134` — "Meta key holding a JSON array of repo-relative paths that failed to parse"
- `packages/coding-graph/src/reindex.ts:182` — "Case 4: last_head is unreachable (rebase/force-push). Fall back to hash_scan"
- `packages/coding-graph/src/reindex.ts:183` — "hash_scan — the executor hashes every candidate and re-parses only mismatches."
- `packages/coding-graph/src/reindex.ts:184` — "Never crash, never silently full-reindex without saying so."
- `packages/coding-graph/src/reindex.ts:248` — "Reject non-canonical repo-relative paths before they reach the disk."
- `packages/coding-graph/src/reindex.ts:263` — "Probe a repo-relative path: canonical check + existence/content read"
- `packages/coding-graph/src/reindex.ts:285` — "Reject symlinks that escape repoRoot before reading"
- `packages/coding-graph/src/reindex.ts:296` — "Transient error — the file may still exist. Do not prune."
- `packages/coding-graph/src/reindex.ts:303` — "Split on forward slashes and re-join with the platform separator"
- `packages/coding-graph/src/reindex.ts:304` — "Windows backslash-in-relPath is never accidentally treated as escape."
- `packages/coding-graph/src/reindex.ts:308` — "Symlink-escape guard: a canonical repo-relative path can still resolve outside repoRoot"
- `packages/coding-graph/src/reindex.ts:334` — "Return a Uint8Array view over the same buffer"
- `packages/coding-graph/src/reindex.ts:335` — "Uint8Array subclass; this copy-free view satisfies the FileIR contract"
- `packages/coding-graph/src/reindex.ts:339` — "Per-store reindex serialization."
- `packages/coding-graph/src/reindex.ts:407` — "readMeta now returns a tagged result: a backend failure must NOT be conflated"
- `packages/coding-graph/src/reindex.ts:408` — "NOT be conflated with never indexed (null)"
- `packages/coding-graph/src/reindex.ts:409` — "planner down a full-reindex path against a store it cannot read."
- `packages/coding-graph/src/reindex.ts:410` — "before any mutation (cursor Bugbot: readMeta conflates absent key"
- `packages/coding-graph/src/reindex.ts:411` — "with db failure."
- `packages/coding-graph/src/reindex.ts:443` — "Diff failed but heads were reachable — degrade to hash_scan."
- `packages/coding-graph/src/reindex.ts:455` — "Read the file-hash snapshot ONCE. A backend failure here must NOT be"
- `packages/coding-graph/src/reindex.ts:456` — "treated as an empty index — that would either skip pruning"
- `packages/coding-graph/src/reindex.ts:457` — "advances, or prune against a falsely-empty set. Bail before any mutation"
- `packages/coding-graph/src/reindex.ts:458` — "readFileHashes conflates error with empty"
- `packages/coding-graph/src/reindex.ts:459` — "The same snapshot is reused for every prune decision below"
- `packages/coding-graph/src/reindex.ts:460` — "nothing mutates the store between here and the ingest"
- `packages/coding-graph/src/reindex.ts:461` — "at each site would only re-introduce the error/empty conflation."
- `packages/coding-graph/src/reindex.ts:480` — "Paths that failed to parse on a prior run must be retried"
- `packages/coding-graph/src/reindex.ts:481` — "HEAD is unchanged (a noop plan would otherwise skip them). Read once;"
- `packages/coding-graph/src/reindex.ts:482` — "we rewrite this set after every run with the CURRENT run's failures."
- `packages/coding-graph/src/reindex.ts:499` — "HEAD unchanged but some files still need a parse retry. Re-ingest"
- `packages/coding-graph/src/reindex.ts:500` — "ONLY the pending set (no diff, no deletes)."
- `packages/coding-graph/src/reindex.ts:501` — "parse; keeps failures for the next run."
- `packages/coding-graph/src/reindex.ts:525` — "An EMPTY explicit list is as insufficient as an omitted one"
- `packages/coding-graph/src/reindex.ts:526` — "an authoritative the repo has zero files signal"
- `packages/coding-graph/src/reindex.ts:527` — "pruning or head advancement"
- `packages/coding-graph/src/reindex.ts:528` — "Require a non-empty list to treat candidates as authoritative."
- `packages/coding-graph/src/reindex.ts:529` — "The genuine empty-repo case (no candidates, no retries)"
- `packages/coding-graph/src/reindex.ts:530` — "is handled below as a noop."
- `packages/coding-graph/src/reindex.ts:535` — "Nothing to index and nothing to retry. Do NOT advance last_indexed_head"
- `packages/coding-graph/src/reindex.ts:536` — "without candidates we did not build an index"
- `packages/coding-graph/src/reindex.ts:537` — "so claiming freshness would be dishonest"
- `packages/coding-graph/src/reindex.ts:538` — "repo reports mode empty via index_status"
- `packages/coding-graph/src/reindex.ts:539` — "Empty full run marks indexed"
- `packages/coding-graph/src/reindex.ts:542` — "Dedup: a path can appear in both candidates and pendingRetry"
- `packages/coding-graph/src/reindex.ts:543` — "upsertFileBatch rejects duplicate paths in one batch"
- `packages/coding-graph/src/reindex.ts:544` — "Full reindex duplicate ingest paths"
- `packages/coding-graph/src/reindex.ts:546` — "Prune stored files that are absent from the candidate set"
- `packages/coding-graph/src/reindex.ts:547` — "full reindex against a pre-existing store"
- `packages/coding-graph/src/reindex.ts:548` — "before the first meta write) does not leave deleted-file symbols"
- `packages/coding-graph/src/reindex.ts:549` — "behind while marking the index current"
- `packages/coding-graph/src/reindex.ts:550` — "Prune absent files during full reindex"
- `packages/coding-graph/src/reindex.ts:551` — "Only prune when the caller supplied an AUTHORITATIVE candidate list."
- `packages/coding-graph/src/reindex.ts:552` — "Without candidatePaths we cannot know which stored files are truly absent"
- `packages/coding-graph/src/reindex.ts:553` — "stored files are truly absent; pruning against a retry-only set would"
- `packages/coding-graph/src/reindex.ts:554` — "destructively delete every successfully-indexed file."
- `packages/coding-graph/src/reindex.ts:555` — "not advance last_indexed_head in that case"
- `packages/coding-graph/src/reindex.ts:556` — "pass has not re-verified the whole tree"
- `packages/coding-graph/src/reindex.ts:557` — "not prune full indexes when candidates are absent"
- `packages/coding-graph/src/reindex.ts:599` — "Deduplicate — a file can appear staged AND in the commit diff"
- `packages/coding-graph/src/reindex.ts:600` — "Use a Set for dynamic runtime membership tracking."
- `packages/coding-graph/src/reindex.ts:603` — "Pending parse-failures from a prior run are also candidates."
- `packages/coding-graph/src/reindex.ts:606` — "Determine which paths still exist on disk vs are deleted."
- `packages/coding-graph/src/reindex.ts:607` — "probe that distinguishes a confirmed deletion from a transient I/O error"
- `packages/coding-graph/src/reindex.ts:608` — "transient I/O error (which must NOT prune the file)."
- `packages/coding-graph/src/reindex.ts:612` — "New candidate paths that probe missing on disk"
- `packages/coding-graph/src/reindex.ts:613` — "partial worktree / list-vs-disk race): retained in pending"
- `packages/coding-graph/src/reindex.ts:614` — "run indexes them instead of advancing head as if done."
- `packages/coding-graph/src/reindex.ts:619` — "A previously-indexed path that is now non-canonical or an escaping symlink"
- `packages/coding-graph/src/reindex.ts:620` — "symlink (probe skip) is no longer a readable repo file — prune its"
- `packages/coding-graph/src/reindex.ts:621` — "stale nodes rather than leaving them while head advances"
- `packages/coding-graph/src/reindex.ts:622` — "Retain skipped symlink paths before advancing"
- `packages/coding-graph/src/reindex.ts:623` — "advancing"
- `packages/coding-graph/src/reindex.ts:628` — "exists → re-ingest; unknown (transient error) → route to ingest"
- `packages/coding-graph/src/reindex.ts:629` — "ingest so ingestFiles records it as a pending retry"
- `packages/coding-graph/src/reindex.ts:630` — "read still fails, WITHOUT deleting the existing nodes."
- `packages/coding-graph/src/reindex.ts:633` — "Confirmed deletion → prune if known; a NEW absent path → retain in pending"
- `packages/coding-graph/src/reindex.ts:634` — "Missing new paths skip pending"
- `packages/coding-graph/src/reindex.ts:675` — "Hash every candidate, re-parse only mismatches."
- `packages/coding-graph/src/reindex.ts:676` — "taken when last_head is unreachable or the incremental diff failed"
- `packages/coding-graph/src/reindex.ts:677` — "the incremental diff itself failed."
- `packages/coding-graph/src/reindex.ts:678` — "Union caller-supplied candidates WITH the previously-indexed files AND pending retries."
- `packages/coding-graph/src/reindex.ts:679` — "Omitting stored files would miss newly-deleted files"
- `packages/coding-graph/src/reindex.ts:680` — "their symbols would linger while head advances"
- `packages/coding-graph/src/reindex.ts:681` — "omitting candidates would miss newly-added files"
- `packages/coding-graph/src/reindex.ts:682` — "Require candidates before completing hash-scan"
- `packages/coding-graph/src/reindex.ts:683` — "Include indexed files in hash-scan candidates"
- `packages/coding-graph/src/reindex.ts:685` — "so it must not drive head advancement."
- `packages/coding-graph/src/reindex.ts:693` — "Hash every candidate via the canonical+ENOENT-aware probe."
- `packages/coding-graph/src/reindex.ts:694` — "transient read error must NOT be treated as a deletion."
- `packages/coding-graph/src/reindex.ts:702` — "Previously-indexed path now non-canonical / escaping symlink"
- `packages/coding-graph/src/reindex.ts:703` — "prune stale nodes rather than leave them while head advances."
- `packages/coding-graph/src/reindex.ts:708` — "Confirmed deletion of a known file → prune."
- `packages/coding-graph/src/reindex.ts:709` — "A NEW candidate absent on disk → retain in pending"
- `packages/coding-graph/src/reindex.ts:710` — "a later run indexes it rather than advancing head as if done"
- `packages/coding-graph/src/reindex.ts:717` — "Transient read error — keep the stored entry, do not prune"
- `packages/coding-graph/src/reindex.ts:718` — "record the path for a pending retry"
- `packages/coding-graph/src/reindex.ts:719` — "next run even when HEAD is unchanged"
- `packages/coding-graph/src/reindex.ts:720` — "Retain hash-scan read failures for retry"
- `packages/coding-graph/src/reindex.ts:753` — "persist head ONLY after data commits — and ONLY when caller supplied candidates"
- `packages/coding-graph/src/reindex.ts:754` — "Without candidatePaths the scan covers only stored + pending paths"
- `packages/coding-graph/src/reindex.ts:755` — "a file newly added in the current HEAD would be missed"
- `packages/coding-graph/src/reindex.ts:756` — "advancing head would falsely report freshness"
- `packages/coding-graph/src/reindex.ts:757` — "Require current candidates before advancing hash-scan"
- `packages/coding-graph/src/reindex.ts:771` — "Read the persisted set of paths that failed to parse on the last run"
- `packages/coding-graph/src/reindex.ts:798` — "Compute the next pending_parse_failures set."
- `packages/coding-graph/src/reindex.ts:842` — "Paths that failed to parse — must retry next run."
- `packages/coding-graph/src/reindex.ts:846` — "Parse + ingest a list of files. Returns the count ingested or a tagged failure."
- `packages/coding-graph/src/reindex.ts:866` — "Non-canonical path would read outside repoRoot / be rejected by the store anyway."
- `packages/coding-graph/src/reindex.ts:867` — "Record + skip — retry-safe."
- `packages/coding-graph/src/reindex.ts:872` — "Reject symlinks that escape repoRoot before reading."
- `packages/coding-graph/src/reindex.ts:873` — "A skipped escape is not a parse failure — do not retain it as a pending retry."
- `packages/coding-graph/src/reindex.ts:879` — "File unreadable — record it for retry"
- `packages/coding-graph/src/reindex.ts:880` — "transient I/O error. Record it for retry"
- `packages/coding-graph/src/reindex.ts:881` — "failure does not silently drop a path that was never ingested"
- `packages/coding-graph/src/reindex.ts:882` — "Read errors drop pending retries"
- `packages/coding-graph/src/reindex.ts:883` — "deleted file is pruned via deletePaths"
- `packages/coding-graph/src/reindex.ts:884` — "here we only keep it retrying."
- `packages/coding-graph/src/reindex.ts:890` — "record unparseable files so they retry next run"
- `packages/coding-graph/src/reindex.ts:891` — "not fail the batch."
