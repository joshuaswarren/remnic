# Draining the extraction buffer

`remnic buffer drain` empties the extraction buffer in one command. It runs
out of process — the extraction happens in worker processes, not on the
daemon's event loop — so a busy daemon keeps serving while its backlog
drains.

```
remnic buffer drain
```

Options:

| Flag | Meaning |
| --- | --- |
| `--concurrency <n>` | Worker processes to run (default 2, max 8) |
| `--session <key>` | Only drain this session (repeatable) |
| `--namespace <ns>` | Only drain sessions captured for this namespace |
| `--dry-run` | Report what would be drained; change nothing |
| `--json` | Print the summary as JSON |

Exit codes: `0` buffer drained, `1` finished with sessions still deferred or
failed, `2` usage or configuration error.

## When the buffer is full

The buffer holds turns that have not been extracted yet. A session's window
drains when that session observes again, when the session ends, or when a
host flushes it. During a provider outage, a long-lived batch of sessions, or
a small extraction model, the backlog can outgrow that: the buffer refuses
new sessions at its entry cap (`MAX_BUFFER_ENTRY_COUNT`), and clients see
`internal_error` on observe.

That is the moment to run the drain:

1. `remnic buffer drain --dry-run` — see which sessions hold turns.
2. `remnic buffer drain` — drain them. A live daemon needs no restart and no
   downtime.
3. If the run reports deferred sessions (a provider outage keeps the content
   claimed instead of dropping it), fix the provider and run the command
   again: it resumes where the last run stopped.

## The protocol

Each session is CLAIMED before it is drained. A claim is a durable file under
`<memory-root>/state/buffer/drain/` that holds the turns which are not
extracted yet.

- **Nothing is lost.** A claimed session's turns live in the claim file until
  they are extracted, so killing the command at any instant leaves the
  un-extracted turns in the claim. The next run resumes them.
- **Nothing is extracted twice.** A chunk is removed from the claim only
  after its extraction is durable. A chunk that was in flight when the
  command died is re-extracted, and the durable extraction fingerprints make
  that re-extraction idempotent.
- **A live daemon never resurrects drained turns.** While a session is
  claimed, the daemon hands its copy of that session into the claim instead
  of writing a session file, and its queued extraction for that session is
  skipped. After the drain, the claim stays as a tombstone that records what
  was extracted, so a daemon that still holds a stale copy subtracts exactly
  those turns instead of writing them back.
- **Two drains at once are safe.** A claim carries a lease (owner, pid, host,
  heartbeat). The second drainer skips a session whose lease is alive, and
  takes over a lease whose owner died.
- **Handing in is cheap.** The daemon's hand-in appends one record to an
  append-only inbox next to the claim file (`<claim>.inbox.jsonl`) instead of
  rewriting the claim, so its cost does not grow with the claim's size. A
  reader sees the claim file with every inbox record merged in; the drainer's
  next progress write (and its ack) folds the inbox into the claim file and
  then deletes it. A kill between those two steps replays nothing, and a torn
  last record is skipped because its writer never saw the append succeed.
  Beside each claim file a small `<claim>.count` file caches the turn counts so
  listings never parse a claim; it is rebuilt when missing or stale. While an
  inbox is unfolded, a listing's turn count is an upper bound.

### Rolling back to a build without inboxes

An older build never reads an inbox, so turns still sitting in one would look
lost. Before downgrading, run `remnic buffer drain --fold-inboxes`: it folds
every inbox into its claim file and deletes the inbox. Run it with the daemon
stopped, then start the older build.

## Concurrency and memory

The in-process extraction queue is serial by design, so a single worker
drains one session at a time. Throughput comes from running several workers:
`--concurrency N` starts N worker processes, each with its own orchestrator
(the same pattern as `remnic import`). The default of 2 keeps the memory
footprint at two orchestrators; raise it when the extraction model is the
bottleneck, lower it to 1 on a small host.

## What it reuses

The drain is the daemon's pipeline, not a second implementation: the same
chunking and extraction-window budget, the same retry/backoff and provider
circuit-breaker semantics, the same dropped-chunk side-file recovery, and the
same namespace and principal resolution. A chunk that keeps failing is
dropped with a recovery copy under `<memory-root>/state/dropped/` instead of
blocking the session behind it.
