# QMD 2.8.3 for Remnic

Remnic's supported QMD install reports `2.8.3` from `qmd --version`. Stock
`npm install -g @tobilu/qmd@2.8.3` prints the same string and is not the
binary this tree expects. The install is one pinned commit of
[tobi/qmd](https://github.com/tobi/qmd) plus the patches in this repo.

| | |
| --- | --- |
| Commit | `93d211f9ef4a869a9aed0d075ca767dda552627f` |
| `package.json` version | `2.8.3` (same as the tag and as current main) |
| Tag `v2.8.3` | `30edfa8b11b3bdcb8ff2bb34d85c10d542333cc1` (2026-08-16) |
| Patches | `docs/patches/qmd-2.8.3-mcp-cancel.patch`, `docs/patches/qmd-2.8.3-stdio-stdout.patch`, `docs/patches/qmd-2.8.3-rerank-mocks.patch` (tests only) |

Do not track floating `main`. Do not open a pull request or issue on tobi/qmd
for these patches from this tree; the patches are written so they can be
sent upstream later.

`qmdSupportedVersion` stays `"2.8.3"` because that is what `qmd --version`
prints. The preflight cannot tell stock npm 2.8.3 from this commit.
`qmdAutoUpgradeEnabled` stays off. Turning it on runs
`npm install -g @tobilu/qmd@2.8.3`, which drops the per-collection vector
index, the repack, the cancel patch, and the stdout fix.

Older QMD installs still work. Remnic omits flags the probed version does not
have. `--format json` stays gated at 2.5.3+. The stdio client still sends MCP
protocol `2024-11-05`. `@modelcontextprotocol/core@2.0.0` lists that version
in `SUPPORTED_PROTOCOL_VERSIONS`.

CPU-only stays the production constraint (`QMD_FORCE_CPU=1` on that host).
Nothing here lowers top-k, drops a tier, turns rerank off, cuts the 40
candidates, or tightens a deadline.

## What this build takes

125 commits sit between tag `v2.5.3` and tag `v2.8.3`. 113 more sit between
`v2.8.3` and `93d211f`. Cherry-picking the vector work onto the 2.8.3 tag is
not a reviewable patch: `store.ts` moves by about +1686/−558 lines and adds
`src/vec-layout.ts`. The install is the commit, not a stack of backports.

### Already in tag v2.8.3

These ride along because the pin is after the tag. Remnic does not reimplement
them.

- `node-llama-cpp` 3.18.1 → 3.20.0 (llama.cpp b8390 → b10361). This VM has
  not timed 3.20 rerank. Do not treat the 3.18.1 profile below as a 3.20
  speedup.
- MCP SDK 2.x, protocol revision 2026-07-28. HTTP is sessionless. Stdio still
  accepts a 2024-11-05 client. The tool callback's second argument is
  `ServerContext`, and `signal` is the abort from `notifications/cancelled`.
- `qmd trust`, `qmd trust list`, `qmd trust revoke` (#886, #889). A
  project-local `.qmd/index.yml` `update:` hook, a collection path outside
  the project, and a non-default `models.embed` / `rerank` / `generate` URI
  are skipped until approved. Approvals live in `<config dir>/trusted.json`.
  `QMD_TRUST_UPDATE_HOOKS=1` and `QMD_TRUST_LOCAL_CONFIG=1` opt unattended
  runs back in. Commands in the user's own `~/.config/qmd/*.yml`, including
  `qmd collection update-cmd`, are not gated. Remnic does not shell out to
  those project-local hooks. An operator who runs `qmd update` from a git
  checkout that carries `.qmd/index.yml` still has to trust it.
- Indexing does not follow file symlinks or glob `../` / absolute patterns
  out of the collection. `qmd://` resolution uses the same containment check.
- `qmd mcp --http` checks `Origin` and `Host` and returns 403 for a
  non-loopback name (#881). Requests with no `Origin` are unchanged.
  `QMD_ALLOWED_ORIGINS` / `QMD_ALLOWED_HOSTS` extend the lists. A wildcard
  bind skips the host check. Remnic's live path is stdio, not this HTTP server.
- Case-sensitive document identities (#801, #857). `findOrMigrateLegacyDocument`
  no longer uses `COLLATE NOCASE`. `README.md` and `readme.md` stay distinct.
  A handelized slug still migrates when no live file owns that path. There is
  no separate migrate command. After the upgrade, `qmd update` indexes each
  casing as its own document. If an older index stored only one of a case-only
  pair, the other shows up as a new document. Review those paths; do not expect
  them to collapse.
- Collection-scoped exact vector scan (#847). A global ANN plus a post-filter
  starved small collections because sqlite-vec's `k=4096` cap makes multiplier
  over-fetch insufficient. `vsearch -c` scans with `vec_distance_cosine`
  inside the collection.
- Each named collection is searched before the lists are merged (#775), so
  `-c A -c B` is not starved by one collection filling the window.
- Rerank cold-start is serialized so two overlapping queries cannot dispose
  each other's context (#682). The embed context pool is sized from the GGUF
  instead of a 150MB constant (#799). Context-creation failures surface the
  underlying error (#782). The rerank cache key includes the resolved model
  (#764). If context creation fails, rerank returns score 0.5 for every
  document (#819). That fallback changes scores only on the failure path.
  The success path is unchanged.
- `--glob` alias for `collection add --mask`. The launcher execs
  `process.execPath`. Unreadable files are skipped and counted. Concurrent
  FTS creation uses `BEGIN IMMEDIATE`. `busy_timeout` defaults to 120s
  (`QMD_SQLITE_BUSY_TIMEOUT`). `embed --timeout` caps a run. Paths are stored
  literally; `handelize()` is no longer applied at index time except the
  legacy slug migration above.

### On the pinned commit, after the tag

These are why the pin is past `v2.8.3`.

- Per-collection vector index (#983). Vectors live in
  `vectors_by_collection` with `collection_id INTEGER PARTITION KEY`. One row
  per chunk per active collection. `vector_rows` maps rowid to
  `(hash, seq, collection_id)`. `vector_collection_ids` maps the integer to
  the collection name, so `qmd collection rename` is one row (vec0 rejects
  `UPDATE` on a partition key). The first open of this binary copies the
  legacy table into the partitions in place.
- `qmd cleanup` repacks that partitioned table when occupancy is under 90%
  (the #937 algorithm, retargeted in `5ed47af`). The unpartitioned 2.5.3
  backport in `docs/patches/qmd-2.5.3-vec0-repack.patch` is not the production
  path. A table already at or above 90% occupancy is left alone.
- A vector search widens until it fills its limit. Distance ties break by
  filepath. A filtered scan uses a subquery rather than an id list. Stale
  vector rows are removed at the end of `qmd update`. A collection that gains
  an already-embedded hash copies those vectors before stale rows are dropped.
  A missing collection root leaves the index unchanged.
- Remnic scopes every daemon search to one collection, so the within-collection
  top-k is the result we want. It is not the same neighbor set as today's
  global-top-k-then-drop. Do not expect top-1 10/10, full overlap, and
  Spearman 1.0 after this migration. Compare with
  `scripts/recall-qmd-compare.mjs` on the host before treating the lists as
  identical. Cancellation alone, on an unpatched index, is the case that
  should stay identical.

The binary also contains metadata filters, a 10MB file skip, expansion
dedupe, and keyword scope at the index. Remnic does not send metadata filters
and does not call those new CLI surfaces.

## What this tree does not take

- No install of floating `main`, and no cherry-pick of #983 onto tag `v2.8.3`.
- No 2.5.3 vec0 backport as the operator install. The bench script remains as
  a measurement of that unpartitioned algorithm.
- No prefix-reuse rerank, no batch-size change, no thread-count change.
  Measured on node-llama-cpp 3.18.1 below. Not shipped.
- No second Remnic rerank cache. `llm_cache` already stores the score.
- No smaller reranker and no flag. Defaults stay `qwen3-reranker-0.6b` Q8.
- No remote MCP client. `qmdDaemonUrl` is still only a boolean that turns on
  the local stdio child.
- No `QMD_FORCE_CPU` default for the Mac Studio. #938 is documented, not
  papered over by disabling Metal or rerank.
- No change to Remnic's MCP protocol version.
- The HTTP `POST /query` handler in QMD does not observe client disconnect.
  Remnic does not use that route.

## Cancel and #971

Remnic already writes `notifications/cancelled` and does not wait for a
result, and it does not kill the child. Stock QMD ignores that signal inside
rerank. `qmd-2.8.3-mcp-cancel.patch` threads `ctx.signal` from the MCP `query`
tool into `store.search` → `structuredSearch` / `hybridQuery` → `rerank` →
`LlamaCpp.rerank`.

`rank()` and `rankAll()` share `_evaluateRankingForInput` in node-llama-cpp
3.20.0, same as 3.18.1. The patch scores with `rank()` on a shared cursor so
a cancel stops between documents. A document that finishes keeps that score.
The call throws `AbortError` and does not return a partial ranking. The
`llm_cache` write stays after `llm.rerank` returns, so a throw stores nothing.
sqlite-vec itself is not interrupted. The abort check runs after `embedBatch`
returns and before each vector scan and before rerank. `embed()` is not
aborted mid-call. The 0.5 fallback when no rerank context could be created is
unchanged, and it is not taken when the signal is already aborted.

`qmd-2.8.3-stdio-stdout.patch` is #971. `withNativeStdoutRedirectedToStderr`
replaces `process.stdout.write` for the whole `import("node-llama-cpp")` and
`getLlama()` call. The MCP SDK writes one JSON-RPC message per
`stdout.write`. A `status` or `query` reply that finishes while the model is
loading lands on stderr, and the client waits forever. The model is disposed
after five idle minutes, so every later semantic query that reloads it opens
the window again. Remnic hits this with `QMD_FORCE_CPU=1` and concurrent
calls. The patch leaves a chunk that starts with `{"jsonrpc":` (the 11 bytes
`7b 22 6a 73 6f 6e 72 70 63 22 3a`) on the original stdout, including the
boolean backpressure return. Native progress is not JSON-RPC and still goes
to stderr. This does not `dup2` fd 1 onto stderr.

#938 is open on that commit. Report: `qmd mcp` SIGSEGV on a vector or rerank
query under macOS Metal (Apple Silicon, Node 22, node-llama-cpp 3.20, qmd
2.8.3). The crash type is `EXC_CRASH` / `SIGSEGV`, and the stack is
`__kill` → `uv_kill` → `node::Kill`, a deliberate kill from the native layer.
CLI `qmd query` and BM25-only `qmd mcp` were reported fine. This Linux CPU VM
cannot reproduce Metal. No workaround is shipped. A Mac Studio running
`qmd mcp` on Metal can still hit it. Forcing CPU there would be a local
operator choice (`QMD_FORCE_CPU=1`), not a Remnic default.

## Install

Stop QMD first, including Remnic, so nothing has the index open. Back up
before the new binary's first start. The conversion runs on open.

```bash
# paths are the host's QMD index, often ~/.cache/qmd/index.sqlite
# plus the -wal and -shm next to it. Stop writers before the copy.
cp -a "$QMD_INDEX" "$QMD_INDEX.before-2.8.3"
cp -a "$QMD_INDEX-wal" "$QMD_INDEX.before-2.8.3-wal" 2>/dev/null || true
cp -a "$QMD_INDEX-shm" "$QMD_INDEX.before-2.8.3-shm" 2>/dev/null || true

git clone https://github.com/tobi/qmd.git
cd qmd
git fetch --depth 1 origin 93d211f9ef4a869a9aed0d075ca767dda552627f
git checkout --detach 93d211f9ef4a869a9aed0d075ca767dda552627f
git apply /path/to/remnic/docs/patches/qmd-2.8.3-mcp-cancel.patch
git apply /path/to/remnic/docs/patches/qmd-2.8.3-stdio-stdout.patch
git apply /path/to/remnic/docs/patches/qmd-2.8.3-rerank-mocks.patch
npm install
npm run build
npm install -g .
qmd --version   # prints 2.8.3
```

`qmd-2.8.3-rerank-mocks.patch` touches `test/llm.test.ts` only. A checkout
that already has the cancel and stdout patches applies just that file. It
does not change ranking. Without it, `LlamaCpp rerank deduping` and
`uses fewer active rerank contexts for small batches` throw
`ctx.rank is not a function`, because those mocks still call `rankAll`.

`npm pack` in that tree produces a tarball of the same bits. Install it with
`npm install -g ./tobilu-qmd-2.8.3.tgz`. A git fork is the same checkout with
the patches applied; do not point Remnic's auto-upgrade at a git URL.
The version parser accepts only semver.

Restart the host so Remnic respawns `qmd mcp`. Then:

```bash
qmd trust          # only if update hooks, out-of-project paths, or custom model URIs are skipped
qmd cleanup        # prints occupancy; repacks the partitioned table when it is under 90%
```

The Dockerfile builds this same commit. It copies the patches, fetches
the SHA, applies them, and `npm install -g` so `/usr/local/bin/qmd` still
points at `@tobilu/qmd`.

## Rollback

The vector migration is in place. Stock 2.5.3 and stock 2.8.3 cannot read
`vectors_by_collection`. Restoring the binary without restoring the file
leaves search unable to open the index.

```bash
# stop Remnic and qmd first
npm install -g @tobilu/qmd@2.5.3
# or stock @tobilu/qmd@2.8.3, which still lacks #983 and these patches
cp -a "$QMD_INDEX.before-2.8.3" "$QMD_INDEX"
cp -a "$QMD_INDEX.before-2.8.3-wal" "$QMD_INDEX-wal" 2>/dev/null || true
cp -a "$QMD_INDEX.before-2.8.3-shm" "$QMD_INDEX-shm" 2>/dev/null || rm -f "$QMD_INDEX-shm"
```

Cost: the copy is the size of the index (a ~1.2M-vector store is multiple
GB; the synthetic holey file on the VM was 10,434,342,912 bytes). Every
index write after the first open of the new binary is dropped when the copy
is restored. There is no forward migration of those writes back onto the old
layout. Take the backup before the first start, not after.

The case-identity change is in stock 2.8.3 as well. Rolling back only as far
as stock 2.8.3 keeps it. Rolling back to 2.5.3 restores the old
`COLLATE NOCASE` lookup on the restored file. Do not copy a partitioned index
onto 2.5.3.

## CPU numbers measured on this VM

Labeled `measuredOn: "vm"`. 4 CPUs, no GPU. These milliseconds do not transfer
to the host. The earlier host capture, before the #983 conversion, had a
vector stage of about 6s and a rerank of 40 candidates at 8.7–45.9s, median
20s. The host measurement after that conversion is in the next section.

### Unpartitioned vec0 repack

`scripts/qmd-vec0-repack-bench.mjs` runs the unpartitioned #937 algorithm
(the 2.5.3 patch). Production cleanup on the pinned commit repacks the
partitioned table instead. The occupancy rule is the same: under 90% full,
repack. The speedup exists only when the index is sparse.

768 dimensions, 1,201,464 live rows, 36.06% occupancy, `mmap_size 0`, no
`VACUUM`:

| | chunks | occupancy | k=20 times (ms) | median |
| --- | ---: | ---: | --- | ---: |
| before | 3256 | 36.06% | 6897, 6563, 6334, 6660 | 6611 |
| after | 1174 | 100% | 1501, 1291, 1284, 1285 | 1288 |

Embedding sha256 and top-20 `(hash_seq, distance)` matched exactly. The file
stayed 10,434,342,912 bytes because the bench does not `VACUUM`. Dropped
chunks are not scanned. Insert-and-punch took 218s and the repack took 122s.
Ratio 5.13×.

That 5.13× ratio is this VM's unpartitioned bench. It is not the host's
partitioned conversion. The host numbers below replace the earlier projection
that a ~6s two-scan stage would land near 1.2–3s.

### Rerank profile (node-llama-cpp 3.18.1)

Model file `qwen3-reranker-0.6b-q8_0.gguf`, `QMD_FORCE_CPU=1`, context 4096,
4 threads. `scripts/qmd-rerank-cpu-bench.mjs`. Not re-run on 3.20.

800-character documents, 8 docs: stock 8144ms, stock repeated 8128ms, prefix
reuse 6429ms. Stock versus stock max abs diff 6.77e-5, and the order already
flipped. Prefix versus stock max abs diff 5.73e-5, 3 of 28 pairs inverted.
Raising the token batch from 512 to 2048 was 8210ms and not order-identical.
2 threads was 14966ms, slower. Full 40 short documents: stock 42344ms, prefix
31263ms (1.35×). Score gaps on that synthetic set are ~1e-6, smaller than
stock's own repeat noise, so the order flips are near-ties.

3600-character documents (QMD's chunk is 900 tokens / 3600 characters; QMD
does not truncate a normal chunk): 8 docs stock 31011ms, stock repeated
32888ms, prefix 32075ms. Prefix is slower. The prefix is ~77 tokens against a
~900-token document, and the extra eval does not pay for itself. The full-40
chunk-sized run did not finish; the script stopped with "prefix length
differs across documents" after the 8-doc measurement. That is enough to
leave prefix reuse out.

`llm_cache` already caches rerank scores for this model name. A hit skips
rerank and does not skip the vector scan. The cap stays ~1000 rows. `qmd
cleanup` deletes the cache. Repeat rate of live queries was not measured
here.

Turning rerank off against the captured BEFORE lists: top-1 10/10, mean
top-10 overlap 4.20, mean Spearman 0.3800. Rerank stays on.

## Host numbers after the #983 conversion

Labeled `measuredOn: "host"`. The binary was `93d211f9` plus the cancel patch,
the stdout patch, and the idle-unload fix on `joshuaswarren/qmd` branch
`fix-938-idle-unload-race`. That #938 fix is not one of the patches in this
repo. It stops an idle unload from freeing a context under an in-flight
embed or rerank. It does not change scores. The search and index changes
below are the #983 conversion on that index.

| | before | after |
| --- | ---: | ---: |
| search mean | ~6.0 s | 0.6 s |
| index size | 5.68 GB | 1.96 GB |
| packing | orphans present | 100% packed, ~1.05M orphan vectors dropped |
| rerank candidates, mean | 19.4 | 35.9 |
| CPU rerank mean | 27 s | 41 s |
| total recall mean | 33 s | 41.5 s |

On 10 queries, top-1 matched the before list on 9 of 10. Content spot-checks
of the returned memories were equal or better.

Collection-scoped search no longer takes a global top-k and then drops rows
from other collections, so this collection is no longer starved inside that
top-k. More of the 40-candidate cap reaches rerank (19.4 → 35.9). The scan
got faster. The CPU rerank grew by more than the scan saved, so total recall
rose from 33 s to 41.5 s.

## Host compare

```bash
QMD_STORE_MODULE=/path/to/@tobilu/qmd/dist/store.js \
QMD_COLLECTION="$QMD_COLLECTION" \
QMD_FORCE_CPU=1 \
OUTDIR=/tmp/recall-after \
node scripts/recall-qmd-bench.mjs /path/to/queries.json daemon

node scripts/recall-qmd-compare.mjs /path/to/before/per-query /tmp/recall-after
```

The bench uses lex + vec + hyde, limit 20, candidate limit 40, rerank on.
Queries stay off the repo. After #983, a Spearman below 1.0 is a neighbor-set
change to record, not a failed cancel patch.
