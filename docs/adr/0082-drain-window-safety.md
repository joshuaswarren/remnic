# Extraction Drain Window Safety and Clearing

Status: accepted

## Context
Extraction drains consume a window of buffered turns in chunks, and the
chunks are judged and persisted independently. Three forces shaped this
design: a window that qualified as durable must not be silently re-judged or
partially cleared; an oversized turn whose content exceeds the model window
must still be extracted without double-counting or losing its tail; and a
single failed chunk must neither stall the drain nor destroy buffered content
that has no recovery copy. A pinned capture can legitimately sit in front of a
native group, so clearing must key on turn identity rather than position, and
a provider outage or bad key is an environment fault, not a chunk failure to
be counted against retry budgets.

## Decision
Rules for draining an extraction window:

- Each representative chunk expands to a PARTITION slice of the original
  window; eligibility is decided for the window as a whole, and qualified
  chunks are never re-judged one by one.
- A native group clears its buffered turns by identity, so a pinned capture
  in front of the group does not block clearing.
- A successfully dropped thrown chunk does not end the drain; later chunks
  still run.
- When every part of an oversized turn is extracted, the part slices match no
  buffered turn: their drop set is the parent turn's, and no drain may clear
  a parent through a part's slice. If emitted parts covered only the head,
  the tail stays out of the model rather than being fabricated.
- Each chunk runs under a chunk-local abort controller so a fail-closed flush
  can preempt only the next chunk; an abort error is rethrown without
  touching the outer signal.
- A provider outage or bad key is not the chunk's fault: keep the chunk and
  do not count it against the failure budget.
- Never destroy the only buffered copy of a chunk without a recovery file.

## Consequences
Callers must track parent/part slice relationships to clear buffers
correctly, and the recovery-file requirement means a drop without one is
always a bug, not an optimization. The no-re-judge rule costs flexibility:
changing eligibility mid-drain cannot retroactively unqualify chunks.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-drain.ts:280` — "Each representative chunk expands to a PARTITION slice of the original window..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:317` — "A native group clears its turns by identity (a pinned capture can sit in front)..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:334` — "The window qualified as a whole; its chunks must not be re-judged one by one..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:366` — "A successfully dropped thrown chunk does not end the drain: later chunks still run..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:382` — "Every part extracted: the slice copies match no buffered turn..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:434` — "A chunk-local abort controller so a fail-closed flush can abort the next chunk..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:442` — "An abort error is rethrown (the chunk-local abort leaves the outer signal untouched..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:499` — "An outage or a bad key is not the chunk's fault: keep the chunk and do not count..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:569` — "Part copies match nothing buffered: their drop set is the parents..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:604` — "Never destroy the only buffered copy without a recovery file."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:629` — "A part's slice never equals its parent's buffered content, so no drain clears a parent..."
- `packages/remnic-core/src/orchestration/extraction-drain.ts:646` — "The emitted parts covered only the head: the tail stays out of the model..."
