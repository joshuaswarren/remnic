# Search Backends

Remnic supports six search backends through a pluggable port/adapter architecture. Each backend implements the same `SearchBackend` interface, so switching engines requires only a config change — no code modifications.

## Choosing a Backend

| Backend | Dependencies | Setup | Search Quality | Best For |
|---------|-------------|-------|---------------|----------|
| **QMD** | QMD binary (2.1 GB models) | Medium | Highest (BM25 + vector + LLM reranking) | Production, best recall quality |
| **Orama** | None (pure JS) | Easy | Good (hybrid FTS + vector) | Quick start, no native deps |
| **LanceDB** | Native Arrow bindings | Medium | High (hybrid FTS + vector + RRF) | Large collections, fast vector search |
| **Meilisearch** | Running server | Medium | High (hybrid with server-side embeddings) | Shared search, multi-service |
| **Remote** | HTTP endpoint | Varies | Depends on service | Custom search infrastructure |
| **Noop** | None | None | None | Extraction-only mode |

## QMD (Default)

QMD provides the highest quality retrieval through hybrid BM25 + vector + LLM reranking. It's the default and recommended backend.

### Setup

Install QMD. `qmd --version` must print `2.8.3`. Stock
`npm install -g @tobilu/qmd@2.8.3` prints that and is not this tree's binary.
The install is commit `93d211f9ef4a869a9aed0d075ca767dda552627f` plus the two
patches in `docs/patches/`. Steps, the index backup, and rollback are in
[QMD 2.8.3](qmd-2.8.3.md). Remnic still detects the installed version at
runtime and omits flags an older binary does not have.

Add your memory directory to `~/.config/qmd/index.yml`:

```yaml
openclaw-engram:
  path: ~/.openclaw/workspace/memory/local
  extensions: [.md]
```

Index the collection:

```bash
qmd update && qmd embed
```

### Config

```jsonc
{
  "searchBackend": "qmd",        // Default — can be omitted
  "qmdEnabled": true,
  "qmdCollection": "openclaw-engram",
  "qmdMaxResults": 8,
  "qmdSupportedVersion": "2.8.3",
  "qmdAutoUpgradeEnabled": false, // leave off: auto-upgrade installs stock npm 2.8.3
  "qmdChunkStrategy": "auto",
  // Leave qmdIndexName unset unless you intentionally use a separate QMD DB.
  // Existing Remnic/OpenClaw installs usually keep data in QMD's default "index".
  "qmdForceCpu": false,
  "qmdDaemonEnabled": true,      // Keep the shared MCP session warm for fast queries
  "qmdIntentHintsEnabled": false,
  "qmdExplainEnabled": false
}
```

Standalone daemon config accepts these keys at the top level **or** under a
`remnic` (or legacy `engram`) block. Nested `remnic.searchBackend` /
`remnic.qmdEnabled` win when both shapes are set.

When QMD `2.5.0` or newer is installed, Remnic uses the newer capability set when
available: `qmd doctor` diagnostics, version-matched skill metadata, structured
MCP `lex`/`vec`/`hyde` searches, candidate-limit forwarding, rerank toggles,
AST-aware chunking for CLI/embed paths, scoped collection embedding, model/env
overrides (`QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, `QMD_GENERATE_MODEL`,
`QMD_FORCE_CPU`, `QMD_LLAMA_GPU`, `QMD_EMBED_PARALLELISM`), named index selection
via `qmdIndexName`, and absolute snippet line numbers. Older QMD installs
continue to work with unsupported flags omitted.

Remnic also detects QMD `2.5.3+`'s preferred `--format json` output selector
for `qmd query`/`qmd search` subprocess calls. QMD `2.5.3` adds richer
human/agent retrieval output (`get` line-range suffixes, default line-numbered
`get`/`multi-get`, `#docid` headers, and `--full-path` for direct filesystem
paths), but Remnic keeps its machine-readable search path on QMD's JSON output
and preserves docids for provenance and dedupe. QMD `2.5.1` and older installs
continue to receive the legacy `--json` aliases.

Do not set `qmdIndexName` during upgrades unless you have confirmed the existing
QMD data lives in that named index. QMD's default index is named `index` and is
stored at `~/.cache/qmd/index.sqlite`; changing `qmdIndexName` to a new value
creates or selects a different SQLite database, which can make existing memories
appear missing even though the old QMD database is still intact. Before changing
it, compare `qmd collection list` or inspect `~/.cache/qmd/*.sqlite` and preserve
the index that contains the current `openclaw-engram*` collections.

Auto-upgrade is intentionally disabled by default. Set
`qmdAutoUpgradeEnabled: true` to let Remnic upgrade PATH/fallback QMD installs to
`qmdSupportedVersion`. Remnic does not auto-upgrade an explicitly configured
`qmdPath`; install the supported package manually for that path.

QMD version coverage:

| QMD version | Remnic behavior |
|-------------|-----------------|
| `2.0.0` | Uses the v2 MCP `query` tool shape and unified search semantics; legacy `search`/`vsearch` daemon tools are avoided. |
| `2.0.1` | Detects the skill-install generation, but leaves user/global agent skill installation explicit. |
| `2.1.0` | Enables AST chunk strategy on CLI/embed paths, rerank toggles, candidate limits, per-collection model config compatibility, and JSON line capture. |
| `2.5.0` | Enables doctor/status diagnostics, version-matched skills, structured MCP `lex`/`vec`/`hyde` searches, absolute snippet lines, scoped embed behavior, and QMD model/GPU env controls. |
| `2.5.3` | Uses QMD's preferred `--format json` selector for `query`/`search` subprocess calls and inherits QMD's line-range, docid-header, full-path, launcher, and Metal-teardown fixes. Remnic keeps legacy `--json` for older QMD versions. |
| `2.8.3` | Supported version string. The recall binary is the pinned commit in [QMD 2.8.3](qmd-2.8.3.md), not the stock npm tarball. Same `--format json` gate as 2.5.3. |

### Upgrading QMD

QMD `2.8.3` is not a drop-in for a 2.5.3 index. The pinned commit converts
the vector table in place the first time it opens the database. Back up the
sqlite file, the `-wal`, and the `-shm` before that open. Collections and the
YAML config stay. Document identities that differ only by path casing no longer
collapse. The install commands, `qmd trust`, and rollback are in
[QMD 2.8.3](qmd-2.8.3.md).

```bash
# After the pinned build is on PATH:
qmd --version        # 2.8.3
qmd doctor           # available on QMD 2.5+
qmd status           # existing collections should still list
qmd cleanup          # repacks the partitioned vector table when occupancy is under 90%

# Restart the host so Remnic respawns `qmd mcp`.
# Standalone:  remnic daemon restart
# OpenClaw:    launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

If native bindings misbehave after the upgrade, rebuild them with
`npm rebuild better-sqlite3`.

Moving up from QMD 1.x also resolves three issues that previously required manual
patches, all fixed natively in 2.0+:

- MCP session-ID crash — built-in `sessionIdGenerator`.
- Model override env vars — `QMD_EMBED_MODEL`, `QMD_GENERATE_MODEL`, `QMD_RERANK_MODEL`.
- Vector-search join performance — two-step query pattern.

If you used the OpenClaw patcher for those 1.x patches, it targets source paths that no
longer exist in 2.x and will harmlessly skip them; remove the stale QMD patch entries.
To upgrade PATH/fallback installs automatically, set `qmdAutoUpgradeEnabled` (see the
QMD config table above).

### QMD Daemon Mode

For lower latency, Remnic prefers a shared stdio `qmd mcp` session when QMD is healthy. It does not currently talk to the HTTP daemon endpoint directly, even though the legacy `qmdDaemonUrl` setting is still retained for compatibility.

Remnic automatically prefers the shared MCP session when available and falls back to subprocess calls on empty results, timeouts, or transport failure.

| Setting | Default | Description |
|---------|---------|-------------|
| `qmdDaemonEnabled` | `true` | Prefer the shared MCP/daemon path for search when available |
| `qmdDaemonUrl` | `http://localhost:8181/mcp` | Legacy compatibility knob retained in config; current runtime uses shared stdio MCP |
| `qmdDaemonRecheckIntervalMs` | `60000` | Re-probe interval after failure |
| `qmdIntentHintsEnabled` | `false` | Forward inferred recall intent into QMD unified search when supported |
| `qmdExplainEnabled` | `false` | Capture QMD explain traces into `memory_qmd_debug` snapshots |
| `qmdSupportedVersion` | `2.8.3` | Version string auto-upgrade would install. Leave auto-upgrade off; stock npm 2.8.3 is not the pinned build. |
| `qmdAutoUpgradeEnabled` | `false` | Opt-in auto-upgrade for PATH/fallback QMD installs |
| `qmdAutoUpgradeCheckIntervalMs` | `86400000` | Minimum interval between auto-upgrade attempts |
| `qmdChunkStrategy` | `auto` | Forward QMD's AST-aware chunk strategy when supported |
| `qmdCandidateLimit` | `(none)` | Optional QMD candidate limit forwarded when supported |
| `qmdQueryRerankEnabled` | `true` | Set `false` to pass QMD's rerank-disable flag when supported |
| `qmdSearchStrategy` | `hybrid` | Daemon search plan: `hybrid` (lex+vec+hyde), `lex-vec`, or `lex`. See tuning note below |
| `qmdSubprocessStrategy` | `query` | CLI fallback command: `query` (LLM expansion + rerank) or `search` (BM25-only) |
| `qmdDaemonTimeoutMs` | `60000` | Per-call daemon search timeout in ms (1000–120000). Default 60s matches `recallEnrichmentDeadlineMs`. Default `recallOuterTimeoutMs` is 75s and still caps the whole recall; a 120s daemon timeout also needs those two budgets raised. |

### Tuning daemon latency on CPU-only models

By design, each daemon search runs **three** sub-queries in one request so QMD can
fuse and rerank across all of them:

| Sub-query | Models used | Relative cost (CPU-only) |
|-----------|-------------|--------------------------|
| `lex` | none (BM25) | fast (~200ms) |
| `vec` | embedding | medium (~3–4s) |
| `hyde` | generate **+** embedding | slow (~8–12s) |

This is why a raw `qmd search "..."` (BM25-only) returns in ~200ms while a full
Remnic recall through the daemon can take many seconds on CPU — the daemon is doing
strictly more work, not adding overhead. The default `hybrid` plan maximizes recall
quality and is unchanged.

If you run QMD models on CPU and want to trade some recall for speed, lower the plan:

```jsonc
{
  // Drop only the expensive HyDE generate leg (keeps BM25 + vector):
  "qmdSearchStrategy": "lex-vec",
  // …or BM25-only for the fastest possible recall:
  // "qmdSearchStrategy": "lex",

  // Multi-GB cold indexes: raise to the 120s ceiling if 60s is still tight:
  "qmdDaemonTimeoutMs": 120000
}
```

`qmdSearchStrategy` and reranking are **orthogonal knobs** — `qmdSearchStrategy`
chooses which retrieval legs run, while `qmdQueryRerankEnabled` controls QMD's
reranker model pass, and reranking stays **on by default for every strategy**
(including `lex`) so default behavior is never silently reduced. For the absolute
lowest-latency BM25 path on CPU, pair `lex` with the reranker off — this skips the
extra reranker-model inference on top of the BM25-only retrieval:

```jsonc
{
  "qmdSearchStrategy": "lex",
  "qmdQueryRerankEnabled": false  // skip the reranker model pass for max speed
}
```

When the daemon is **disabled** (`qmdDaemonEnabled: false`), Remnic falls back to a
`qmd query` subprocess, which runs LLM query expansion + reranking. On very large
collections that can be slow; set `qmdSubprocessStrategy: "search"` to use BM25-only
`qmd search` instead. This is faster but **drops** expansion + reranking, so it stays
opt-in and `query` remains the default. (See issue #1335.)

> **Why `qmd query` and not `qmd search` by default?** `qmd query` performs the LLM
> query expansion + reranking that Remnic relies on (Remnic disables its own rerank
> because QMD handles it). Switching the default to `qmd search` would silently remove
> that capability, so it is gated behind `qmdSubprocessStrategy` instead.

### Cancelled recalls on a single QMD worker

Remnic's enrichment deadline aborts the MCP `tools/call`. Stock QMD ignores
that abort: its one worker keeps reranking, and the next recall sits behind the
abandoned call until it times out too. Remnic writes MCP
`notifications/cancelled` (`requestId` plus a reason) when a tool call is aborted
or hits `qmdDaemonTimeoutMs`, then rejects the caller without waiting for a
JSON-RPC result. The MCP SDK drops the result once the server's request
controller is aborted, so waiting would deadlock. The initialize handshake is
not cancelled, and the child is not killed: reloading the rerank model takes
longer than a recall budget, and killing on every slow query would cold-start
the process each time.

Identical in-flight `search()` calls share one daemon query. The shared call is
cancelled only when every waiter has aborted.

Stopping the worker requires `docs/patches/qmd-2.8.3-mcp-cancel.patch` on the
pinned commit, not the 2.5.3 patch. Apply steps are in
[QMD 2.8.3](qmd-2.8.3.md). The patch passes `ctx.signal` from the MCP `query`
tool through `structuredSearch` / `hybridQuery` into the reranker. `rank()` and
`rankAll()` share one evaluate path, so a document that finishes keeps the same
score. The loop checks the signal between documents and throws. It does not
return a partial ranking, and it does not write those scores into QMD's
`llm_cache`. sqlite-vec cannot be interrupted mid-scan; a cancel that arrives
during a scan skips the remaining scans and the rerank once that scan returns.

`docs/patches/qmd-2.8.3-stdio-stdout.patch` keeps a JSON-RPC stdout write on
fd 1 while `getLlama()` has redirected stdout to stderr (#971). Remnic hits
that window with `QMD_FORCE_CPU=1` when one call is still loading the model.
#938 (Metal `qmd mcp` SIGSEGV on vector/rerank) is still open. This VM cannot
reproduce it, and Remnic does not force CPU on a Metal host to avoid it.

This does not change top-k, the lex+vec+hyde plan, rerank, or candidate limits.
On a patched binary, a completed search matches an unpatched one only while the
index layout is unchanged. The pinned commit's per-collection vectors can change
the neighbor set. A cancelled search returns no QMD hits to that caller, same
as today's timeout, and it releases the worker for the next caller.

### CPU vector scan

On QMD 2.5.3, `searchVec` is a brute-force `embedding MATCH` over the whole
`vectors_vec` table, then a collection filter. That cost is flat in k. A CPU
host with about 1.2 million vectors spends about 6 seconds in this stage.
The daemon plan runs it twice (the vector query and the synthetic hyde query).
The pinned 2.8.3 commit stores vectors per collection (#983) and repacks that
table from `qmd cleanup`. The numbers below are the unpartitioned algorithm,
measured before that move. They still bound a sparse index. They are not a
second install path.

sqlite-vec `vec0` stores vectors in fixed 1024-slot chunks. An insert fills the
newest chunk. A delete leaves a hole, and a chunk is dropped only when every
slot in it is empty. `VACUUM` does not pack those holes, so every scan still
reads every chunk.

QMD #937 (commit `58300dac`, unpartitioned `hash_seq` table) repacks that
layout. It deletes and re-inserts the live rows of chunks that are under 90%
full, one chunk per short transaction, and only when overall occupancy is
under 90%. Neighbors stay the same because the embedding bytes and keys stay
the same. A table that is already at or above 90% occupancy is left alone.
On the pinned commit the same rule runs against `vectors_by_collection`.
`docs/patches/qmd-2.5.3-vec0-repack.patch` is the unpartitioned port used for
the bench below. Do not apply it. Run `qmd cleanup` on the pinned build.

Upstream measured a 794k-row index at 36% occupancy at 1.8s per scan, and 0.9s
after packing the same rows (2×). If a ~1.2M-row host index is similarly
sparse, the ~6s two-scan stage is the holey cost. If cleanup says the table is
already packed, expect no change.

`scripts/qmd-vec0-repack-bench.mjs` checks the same algorithm on a synthetic
index. It needs `better-sqlite3` and `sqlite-vec` on `NODE_PATH` (a QMD
checkout install has both). `--self-check` is the #937 fixture: 1100 rows of
3 dimensions, three live rows, both chunks kept. Embedding bytes and the
nearest neighbor match before and after, a packed table is not rewritten, and
a legacy table without `hash_seq` is left alone. The full-size run uses
embeddinggemma-300M's 768 dimensions (`embedding_length` in the Q8_0 GGUF) and
3256 chunks with 369 live slots each (1,201,464 live rows, 36.06% occupancy):

```bash
NODE_PATH=/path/to/node_modules \
node scripts/qmd-vec0-repack-bench.mjs --self-check

NODE_PATH=/path/to/node_modules \
node scripts/qmd-vec0-repack-bench.mjs \
  --chunks 3256 --keep-per-chunk 369 --dims 768 --queries 4 --k 20 \
  --db /tmp/qmd-vec0-repack.sqlite
```

The JSON report labels itself `measuredOn: "vm"`. It is not a host timing.

One full-size run on a 4-CPU VM (`mmap_size 0`, 64MB cache, no `VACUUM`):

| | chunks | occupancy | k=20 times (ms) | median |
| --- | ---: | ---: | --- | ---: |
| before | 3256 | 36.06% | 6897, 6563, 6334, 6660 | 6611 |
| after | 1174 | 100% | 1501, 1291, 1284, 1285 | 1288 |

That is one cosine scan, not the host's two-scan stage. The sha256 of all
1,201,464 embedding blobs matched, and each top-20 `(hash_seq, distance)` list
matched exactly, including the distance floats. The file stayed 10,434,342,912
bytes because this bench does not `VACUUM`; dropped chunks are simply not
scanned. `qmd cleanup` still vacuums after the repack, which is what reclaims
the hole bytes. Insert-and-punch took 218s and the repack took 122s on this
VM. That is maintenance, not a per-query cost.

Project the host's ~6s two-scan stage only when cleanup prints occupancy near
36%. Divide by the measured 5.13× and the stage is about 1.2s. The published
#937 ratio on a warm index was 2×, which puts the same stage near 3s. A host
with the pages cached can land between those. Absolute milliseconds from this
VM do not transfer: `mmap_size 0` makes the holey scan read every page.

Packing the vector stage does not by itself put a 20s median rerank, or the
8.7–45.9s rerank range, under a 25s budget. A fast rerank (about 9s) plus a
1.2s scan fits. A 20s rerank plus a 1.2–3s scan is 21–23s. The 46s rerank tail
stays over 25s.

The pinned build's per-collection index (#983) scans one collection instead of
the global table. The neighbor set can differ from a global-top-k-then-filter.
Compare it with `scripts/recall-qmd-compare.mjs` before treating it as the same
recall. Backup and rollback are in [QMD 2.8.3](qmd-2.8.3.md).

An approximate index inside Remnic would change neighbors without a measurement
against a captured reranked baseline, so there is no default-on ANN flag here.

### Rerank scores QMD already caches

QMD `rerank()` caches each document score in `llm_cache` under
`sha256("rerank" + JSON({ query, model, chunk }))`. The query includes the
intent prefix when one was passed. The file path is not part of the key,
because the score depends on the chunk text. Identical chunk text is scored
once. The write happens after `llm.rerank` returns, so an aborted call does
not store a partial batch. The cancel patch does not change that.

The cap is soft: about 1% of writes delete everything outside the 1000 newest
rows. `qmd cleanup` calls `deleteLLMCache` and drops the whole table. A cache
hit removes the rerank from that call. It does not make the first call of a
new query cheaper, which is the call that misses a 25s budget. A second Remnic
cache keyed the same way would not change that.

How often live recall queries repeat is not measurable from a bench VM. A
10-query capture used for quality comparison is 10 distinct queries; the one
rerank time of about 1ms in that capture is a rerun of a query already in
`llm_cache`, while the vector scan on that same call was still about 6s.

### CPU rerank profile

`scripts/qmd-rerank-cpu-bench.mjs` timed `qwen3-reranker-0.6b` Q8 on
node-llama-cpp 3.18.1 (`QMD_FORCE_CPU=1`, context 4096, 4 threads). The
pinned build uses 3.20.0. These numbers are not a 3.20 measurement, and the
prefix path is not shipped.

800-character documents, 8 docs: stock 8144ms, stock repeated 8128ms, prefix
reuse 6429ms. Stock versus stock already moved by 6.77e-5 and flipped order.
Prefix versus stock moved by 5.73e-5. A token batch of 2048 was not faster
(8210ms). 2 threads was slower (14966ms). 40 short documents: stock 42344ms,
prefix 31263ms.

3600-character documents, the size of a normal QMD chunk: 8 docs stock
31011ms, stock repeated 32888ms, prefix 32075ms. Prefix is slower there. The
shared query prefix is ~77 tokens against a ~900-token document. The full-40
chunk-sized run did not finish. QMD does not truncate a chunk that already
fits, and this tree does not truncate further.

### Smaller rerankers

The default reranker stays `qwen3-reranker-0.6b` Q8. A smaller model would
change scores, so it is not a default and it is not registered as a flag
here. This tree has no copy of the host index, so a new model cannot be scored
against that capture's document ids.

What the capture itself shows, via `scripts/recall-qmd-compare.mjs --rerank-off`
on the reranked files paired with the same queries run without rerank: top-1
stays 10/10, mean top-10 overlap is 4.20, mean Spearman is 0.3800. Per query
the overlap is 2, 2, 2, 2, 3, 9, 4, 4, 6, 8. Turning rerank off keeps the first
hit and drops the rest of the list. That is why rerank stays on, at the same
40-candidate cap.

### Rerank on a separate CPU host

`qmdDaemonUrl` defaults to `http://localhost:8181/mcp` and is still parsed.
The client uses it only as a boolean: a non-empty URL enables the shared
session, and that session is a local stdio `qmd mcp` child
(`daemonEnabled = Boolean(daemonUrl)`). Remnic does not open the URL.
Pointing `qmdDaemonUrl` at another machine does not move the vector scan or
the rerank.

QMD itself can listen with `qmd mcp --http --port 8181`. This client does not
speak that transport. Running QMD on a separate CPU host is not supported by
the current config. There is no remote MCP setting to turn on.

### Comparing a capture

Compare a fresh capture with a BEFORE reranked capture (same plan: lex + vec +
synthetic hyde, candidate limit 40, rerank on, limit 20). `queries.json` is a
JSON array of strings and stays off the repo:

```bash
QMD_STORE_MODULE=/path/to/@tobilu/qmd/dist/store.js \
QMD_COLLECTION=<collection> \
QMD_FORCE_CPU=1 \
OUTDIR=/tmp/recall-after \
node scripts/recall-qmd-bench.mjs /path/to/queries.json daemon

node scripts/recall-qmd-compare.mjs <before-dir> /tmp/recall-after
node scripts/recall-qmd-compare.mjs --rerank-off <before-dir>
```

Each file is `{ results: [{ docid, score }], timings?: { totalMs } }`. The
report prints top-1, top-10 overlap, and Spearman correlation. It does not
print queries or paths. `--rerank-off` pairs `*-daemon.json` with
`*-norerank.json` and is only a check that the metric notices rerank moving
the list.

### Embedding backlog visibility and prioritized embedding

QMD's vector index is built by `qmd embed`, which Remnic does **not** own or
schedule — the QMD binary and its collection config decide when full
re-embedding runs. Remnic only *observes* the backlog and, optionally, nudges
it for freshly written memories.

**Backlog metrics.** `engram/v1/health` (and `remnic status`) report:

- `pendingEmbeddings` — documents QMD has indexed but not yet embedded
- `oldestPendingAgeMs` — age of the oldest un-embedded document
- `embeddingBacklogThreshold` — the configured ceiling (below)

When `pendingEmbeddings` exceeds `qmdEmbeddingBacklogThreshold`, health is
marked `degraded: true` with a reason naming the backlog. Set the threshold to
`0` to disable backlog-based degradation entirely. This is advisory: search
still works (BM25/fulltext), only vector recall lags.

**Config:**

```jsonc
{
  "qmdEmbeddingBacklogThreshold": 1000, // pending embeddings before health degrades (0 disables backlog degradation)
  "qmdAutoEmbedEnabled": false          // opt-in prioritized embedding on write
}
```

**Prioritized embedding** (`qmdAutoEmbedEnabled: true`). When enabled, each
memory write queues its path for a debounced collection-level `qmd embed`
trigger. The QMD CLI does not support per-file embed targeting, so each flush
runs `qmd embed -c <collection>`, which embeds all pending documents. Writes
are debounced (30 s) and batched (max 50 paths per flush) so a burst of
extractions produces one embed call, not one per file. The trigger is
fire-and-forget: an embed failure logs a warning and never blocks the write.
This keeps new hot-collection memories vector-searchable within minutes
instead of waiting for the next full `qmd embed`.

**`qmd embed` ownership and cadence by deployment mode:**

| Mode | Who runs `qmd embed` | Cadence |
|------|----------------------|---------|
| Standalone / CLI | Operator (or cron) | Periodic full re-embed; Remnic never schedules it |
| OpenClaw plugin | Operator's gateway host | Same — Remnic only reports the backlog |
| `qmdAutoEmbedEnabled: true` | Remnic, per-write | Debounced collection-level embed trigger after fresh writes |

In every mode the full-collection `qmd embed` remains the operator's
responsibility; Remnic's prioritized path triggers collection-level embeds
after fresh writes and does not replace periodic full re-embedding.

**Alerting.** Alert when `pendingEmbeddings` grows monotonically across
consecutive health checks (the backlog is never draining). A steadily rising
count means `qmd embed` is not running or is failing — check the QMD daemon
and embedding provider before raising the threshold.

## Orama

Orama is an embedded, pure JavaScript search engine with hybrid FTS + vector support. Zero native dependencies — the easiest backend to get running.

### Config

```jsonc
{
  "searchBackend": "orama"
}
```

That's all you need. Remnic handles database creation, document indexing, and persistence automatically.

### How It Works

- Database files stored at `{oramaDbPath}/{collection}.msp` (JSON format)
- `update()` scans your memory directory for `.md` files, diffs against the index, and upserts changes
- `embed()` computes vectors for documents missing them (requires an embedding provider)
- Search modes: fulltext (BM25), vector, or hybrid (combines both)

### Optional Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `oramaDbPath` | `{memoryDir}/orama` | Database storage directory |
| `oramaEmbeddingDimension` | `1536` | Vector dimension (match your embedding model) |
| `oramaCjkSegmentation` | `true` | Segment space-free scripts (CJK/Thai) into character n-grams in the lexical index (issue #2187). Set `false` to restore the stock English-only tokenizer. |

### Embedding Support

For vector and hybrid search, Orama needs an embedding provider. Without one, it falls back to fulltext (BM25) search only.

Configure embedding via the shared embed helper:

```jsonc
{
  "searchBackend": "orama",
  "embeddingFallbackEnabled": true,
  "embeddingFallbackProvider": "auto",   // "openai", "local", or "auto"
  "openaiApiKey": "${OPENAI_API_KEY}"    // For OpenAI embeddings
}
```

## LanceDB

LanceDB is an embedded vector database with native Apache Arrow bindings. It excels at large collections and fast vector similarity search, with built-in RRF (Reciprocal Rank Fusion) reranking for hybrid queries.

### Config

```jsonc
{
  "searchBackend": "lancedb"
}
```

### How It Works

- Database stored at `{lanceDbPath}` directory (Arrow format)
- One table per collection with columns: `docid`, `path`, `content`, `snippet`, `vector`
- Hybrid search combines FTS and vector results with `RRFReranker`
- FTS index auto-created on the `content` column

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `lanceDbPath` | `{memoryDir}/lancedb` | Database directory |
| `lanceEmbeddingDimension` | `1536` | Vector dimension |

### Notes

- Requires native bindings (`@lancedb/lancedb`) — may need compilation on some platforms
- Best choice for collections with 10,000+ memories where vector search speed matters
- Embedding configuration is the same as Orama (shared `EmbedHelper`)
- The FTS index uses tantivy's default tokenizer, which cannot segment space-free scripts (CJK/Thai) — lexical recall over those scripts is near zero. Non-English recall on this backend rides on the vector tier (see [Non-English content](#non-english-content)).

## Meilisearch

Meilisearch is a server-based search engine with built-in hybrid search. Use it when you want a shared search service accessible by multiple processes or services.

### Prerequisites

Run a Meilisearch instance:

```bash
docker run -p 7700:7700 getmeili/meilisearch:latest
```

### Config

```jsonc
{
  "searchBackend": "meilisearch",
  "meilisearchHost": "http://localhost:7700",
  "meilisearchAutoIndex": true
}
```

### How It Works

- Connects to a running Meilisearch server via the official SDK
- When `autoIndex` is enabled, `update()` pushes documents from your memory directory to Meilisearch
- Hybrid search uses Meilisearch's built-in embedder (configure on the server side)
- Falls back to BM25-only search if no embedder is configured on the server

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `meilisearchHost` | `http://localhost:7700` | Meilisearch server URL |
| `meilisearchApiKey` | `(none)` | API key for authentication |
| `meilisearchTimeoutMs` | `30000` | Request timeout |
| `meilisearchAutoIndex` | `false` | Auto-push documents on update |

### Meilisearch Embedder Setup

For hybrid/vector search, configure an embedder on your Meilisearch instance:

```bash
curl -X PATCH 'http://localhost:7700/indexes/openclaw-engram/settings' \
  -H 'Content-Type: application/json' \
  --data '{
    "embedders": {
      "default": {
        "source": "openAi",
        "apiKey": "YOUR_KEY",
        "model": "text-embedding-3-small",
        "dimensions": 1536
      }
    }
  }'
```

## Remote

The Remote backend sends search requests to an HTTP REST endpoint. Use it to integrate with custom search infrastructure.

### Config

```jsonc
{
  "searchBackend": "remote",
  "remoteSearchBaseUrl": "https://your-search-service.example.com",
  "remoteSearchApiKey": "your-api-key"
}
```

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteSearchBaseUrl` | `http://localhost:8181` | Search service URL |
| `remoteSearchApiKey` | `(none)` | API key for authentication |
| `remoteSearchTimeoutMs` | `30000` | Request timeout |

## Noop

The Noop backend disables search entirely. Remnic still extracts and stores memories, but recall returns no search results. Useful for extraction-only setups or testing.

```jsonc
{
  "searchBackend": "noop"
}
```

## Switching Backends

Switching backends is a config-only change. Your memory files are always plain markdown on disk — no data migration needed.

1. Update `searchBackend` in your config
2. Add any backend-specific settings
3. Restart your host — standalone: `remnic daemon restart`; OpenClaw: `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
4. Verify the active backend — standalone: `remnic doctor`; OpenClaw: `openclaw engram stats`

Embedded backends (Orama, LanceDB) will automatically index your existing memory files on the next update cycle.

## Non-English Content

Space-free scripts — Japanese, Chinese, Thai — have no word boundaries for a
term-based lexical index to split on. Backends differ in how (or whether) they
segment them (issue #2187):

| Backend | CJK/Thai lexical segmentation | Behavior |
|---------|------------------------------|----------|
| **QMD** | Depends on the QMD binary's tokenizer | Check `qmd doctor` for language support |
| **Orama** | Yes — character n-grams via `oramaCjkSegmentation` (default on) | Japanese/Chinese/Thai phrase queries match lexically, with or without embeddings. Other non-Latin scripts (Hangul, Cyrillic, Greek, Arabic, ...) are indexed as whole words. |
| **LanceDB** | No | The FTS index uses tantivy's default tokenizer, which cannot segment space-free scripts. Non-English lexical recall is near zero; the vector tier carries recall. |
| **Meilisearch** | Yes — natively via charabia | Server-side segmentation; nothing to configure in Remnic. |
| **Remote** | Depends on the remote service | Consult the service's tokenizer documentation. |

### Orama CJK/Thai segmentation

Orama indexes CJK/Thai runs as character n-grams (single characters plus
2–4 character grams), reusing the same segmentation strategy as the
query-side recall tokenizer, so index terms and query terms agree. Latin
content tokenizes exactly as before, so existing English indexes stay
term-compatible. Other non-ASCII scripts (Hangul, Cyrillic, Greek, Arabic,
...) are indexed as whole words in addition to any stock English tokens.

The tokenization version is persisted inside each `.msp` index file. When
Orama loads an index written by an older Remnic version, it rebuilds the
full-text side of that index in place (vectors are preserved) the first time
the file is opened — no operator action needed. Corpora whose content
tokenizes identically under both tokenizers (pure legacy Latin) are not
re-indexed; only the version marker is rewritten.

To restore the pre-#2187 stock English tokenizer:

```jsonc
{
  "searchBackend": "orama",
  "oramaCjkSegmentation": false
}
```

### Multilingual deployments (cross-script recall)

Whatever the backend, matching a query in one script against memories written
in another (Japanese query against English memories, or the reverse) is a
semantic task that the lexical tier cannot perform — it depends on the
embedding model's multilingual coverage. Configure an embedding provider
(see the Orama and LanceDB embedding sections) for cross-script recall.

Remnic plans for this explicitly (issue #2197):

1. **Write time.** Every memory is stamped with a dominant-script hint in
   frontmatter `language`, using ISO 15924 codes (`latn`, `jpan`, `kore`,
   `hani`, `cyrl`, `grek`, `arab`, `hebr`, `thai`, `deva`). Detection is a
   codepoint scan, not a language model: kana anywhere means `jpan`, Hangul
   means `kore`, and otherwise the most frequent script wins. Memories written
   before this shipped have no `language` field; they are simply ignored when
   the corpus script is sampled.
2. **Recall time.** The planner compares the query's dominant script against
   the corpus's (sampled from those hints, memoized per corpus generation).
   When they differ, the lexical page is supplemented with vector-tier hits
   from the embedding fallback — regardless of how full the lexical page is,
   because token overlap across scripts is near zero.
3. **Degradation signal.** When the scripts differ and embedding fallback
   is disabled, recall records a
   `vector_tier_unavailable` degradation on the recall snapshot instead of
   silently returning nothing. Read it with `remnic recall explain` or the
   `memory_last_recall` tool: an empty cross-lingual recall then reads as
   "vectors missing", not "no such memory".

A monolingual deployment never triggers any of this — the query and corpus
scripts match, so the lexical path is unchanged.

## Global Search


All backends support `searchGlobal()`, which searches across all collections (not just the default one). This is used by Remnic's cross-collection recall when hot/cold tiering or conversation indexing is enabled.

- **QMD**: Searches all configured QMD collections
- **Orama**: Scans all `.msp` files in the database directory
- **LanceDB**: Queries all tables in the database
- **Meilisearch**: Uses `multiSearch` across all server indexes

## See Also

- [Writing a Search Backend](writing-a-search-backend.md) — Implement your own adapter
- [Config Reference](config-reference.md) — All search-related settings
- [Architecture Overview](architecture/overview.md) — How search fits into the recall pipeline
