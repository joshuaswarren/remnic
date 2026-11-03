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

## Measuring it

`scripts/bench-corpus-scans.ts` builds a synthetic corpus and reports, per
job, the wall time, the main thread's active time
(`performance.eventLoopUtilization`) and the event-loop delay percentiles:

```bash
node_modules/.bin/tsx scripts/bench-corpus-scans.ts --scale quick
node_modules/.bin/tsx scripts/bench-corpus-scans.ts --scale deployment
```

Measured on a synthetic 134k-file corpus (120k hot across day partitions,
8k cold, 6k entity files), same machine, minutes apart:

| job | before: wall / main-thread active | after: wall / main-thread active |
| --- | --- | --- |
| corpus path walk | 5894 ms / 2326 ms | 340 ms / 210 ms |
| corpus read (`readAllMemories`: walk + parse) | 20591 ms / 16893 ms | 10330 ms / 10236 ms |
| corpus watermark (hot+cold walk + freshness stat) | 8822 ms / 4452 ms | 664 ms / 562 ms |
| entity migration ensure cycle | 708 ms / 267 ms | 298 ms / 129 ms (same code path; run variance) |

The per-file `realpath` was the walk's dominant cost: each one resolves the
full ancestor chain (~7 path components per memory file), so removing 120k of
them removes seconds of main-thread time per scan. The corpus read and the
watermark improve by the same amount because each one performs the walk; the
frontmatter parse and the census bookkeeping stay on the main thread.

## Next step: the scans belong off the main thread

The walk, the entity-entry fingerprint and the watermark stat are pure,
read-only, self-contained jobs — the shape a `worker_threads` worker exists
for. A prototype that moved them off the main thread was measured on this
same corpus and harness: the walk's main-thread active time fell from
2326 ms to 8 ms, the watermark's from 4452 ms to 386 ms, and the per-entity-
unlock migration fingerprint read from 267 ms to 2 ms, with the worker and
the inline walk producing identical path lists, fingerprints and stat sweeps.

It does not ship here because the worker's entry has to load in a worker
thread, and a worker does not inherit the TypeScript loader the source tree
runs under: the entry must be plain JavaScript, and the CI Node runtime
cannot load the TypeScript scan sources it needs. Shipping it means moving
the scan implementations into a plain-JavaScript worker entry (built from the
same sources) and proving parity between the worker and the inline path.
