# Corpus scan cost

The daemon's corpus maintenance scans are pure, read-only filesystem work whose
volume scales with the corpus: on a deployment with hundreds of thousands of
memory files they dominate the main event loop, where every awaited syscall is
a main-thread continuation. Observe, recall and the serial extraction queue
then starve behind them — the daemon sits at 100% CPU while clients see
timeouts.

## The scans

| Work | Cost driver | Where it runs |
| --- | --- | --- |
| Recall-corpus path walk (`collectActiveMemoryPaths`, `collectColdMemoryPaths`) | one `readdir` + one `lstat` per directory, and (before this change) one `realpath` per directory and per markdown file | main thread |
| Entity-entry fingerprint (canonical-id migration input) | one `lstat` per entity file, read on every entity unlock | main thread |
| Watermark freshness stat (newest hot partition) | one `stat` per file in the newest partition | main thread |
| Frontmatter parse of a corpus read | CPU per file | main thread |

## What this change does

The walk stops resolving every directory and every markdown file with a
separate `realpath`. Containment is established once:

- the memory root is resolved with a single `realpath` (a missing root is an
  empty corpus, an unreadable root is a backend failure the strict census
  surfaces);
- every directory the walk enters is `lstat`ed, so a symlinked or non-directory
  entry is never followed;
- the entry TYPE comes from `readdir(withFileTypes)`, so a symlinked entry —
  file or directory — is skipped without a per-entry syscall.

Reads still refuse symlinked files at open time (`O_NOFOLLOW`), so a path
swapped to a symlink mid-scan is refused rather than followed. The collected
path set is unchanged; `tests/corpus-walk-cost.test.ts` pins it over a corpus
with nested partitions, Finder junk and symlinked-out entries, and the
existing symlink-containment tests are unchanged.

## The scans run in a worker

The corpus-sized scans — the recall-corpus path walk, the entity-entry
fingerprint the canonical-id migration reads on every entity unlock, and the
watermark freshness stat — run in one `worker_threads` worker
(`src/corpus-scan-worker-host.ts`), so a scan no longer holds the main event
loop.

- **One implementation, two sites.** The scans are plain functions
  (`src/corpus-scan.ts`). The worker runs them; when no worker can start (entry
  missing, unsupported runtime) the host runs the same functions inline, so the
  result is identical and the scan still happens.
- **Plain-JavaScript worker entry.** A worker thread does not inherit the
  TypeScript loader the source tree runs under, so the worker loads
  `src/corpus-scan-worker.entry.mjs`, generated from
  `src/corpus-scan-worker.entry.ts` by `npm run sync:corpus-scan-worker`
  (esbuild bundle, no runtime loader hooks). The generated file is committed;
  `npm run check:corpus-scan-worker-sync` (part of `npm run build`) fails when it
  drifts from its source. The package build copies it next to the bundled host.
- **Cancellation.** An aborted scan rejects on the main thread immediately with
  an `AbortError`, and the worker abandons the walk at its next
  directory/entry boundary; a late reply is discarded and a cancelled read never
  publishes a partial corpus.
- **Errors.** A scan error keeps its errno code across the thread boundary, so
  the strict census still tells `EACCES` (unreadable corpus, namespace omitted)
  from `ENOENT` (absent path).
- **No lingering handles.** The worker is `unref()`ed and its `message` listener
  is attached only while a job is in flight (a worker with a `message` listener
  keeps the parent's event loop alive), so an idle worker never stops the
  process from exiting. `close()` terminates the worker, rejects in-flight jobs,
  and the next request spawns a fresh one; events from a worker that is no longer
  current never touch its successor's jobs.
- **Census yields.** Building the watermark census over 128k collected paths is
  main-thread CPU that a worker cannot take without cloning every path back and
  forth, so the census loop yields to the event loop every 4096 paths instead.

The entity-migration completion check still re-reads every entity entry's
identity (a cheap-signature cache would miss an in-place entity edit, which is
pinned by "an external in-place entity edit reopens a completed migration");
the read now happens in the worker.

## Measuring it

`scripts/bench-corpus-scans.ts` builds a synthetic corpus and reports, per
job, the wall time, the main thread's active time
(`performance.eventLoopUtilization`) and the event-loop delay percentiles:

```bash
node_modules/.bin/tsx scripts/bench-corpus-scans.ts --scale quick
node_modules/.bin/tsx scripts/bench-corpus-scans.ts --scale deployment
```

Measured on a synthetic 134k-file corpus (120k hot across day partitions, 8k
cold, 6k entity files), same machine, in three states (wall / main-thread
active; the watermark row also gives the longest single event-loop block):

| job | per-file `realpath` (before #3301) | containment once (#3301) | + worker (this change) |
| --- | --- | --- | --- |
| corpus path walk | 5894 / 2326 ms | 340 / 210 ms | 437 / **15 ms** |
| entity migration ensure cycle | 708 / 267 ms | 298 / 129 ms | 398 / **3 ms** |
| corpus watermark | 8822 / 4452 ms; longest block 660 ms | 664 / 562 ms; longest block 420 ms | 870 / 566 ms; longest block **81 ms** |
| corpus read (`readAllMemories`: walk + parse) | 20591 / 16893 ms | 10330 / 10236 ms | 10693 / 10394 ms |

The corpus read keeps its frontmatter parse on the main thread (it needs the
store's schemas and is not a scan), so its main-thread time is unchanged by
the worker. Wall time of a scan rises slightly with the worker (the path list
crosses a thread boundary); the point is that the main thread is free for that
time.
