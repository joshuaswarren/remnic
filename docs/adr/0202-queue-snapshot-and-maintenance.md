# Extraction Queue Coordination, Snapshot Sharing, and Ledger Maintenance

Status: accepted

## Context
Background extraction work runs through a bounded queue, and maintenance
rewrites large ledgers. Three forces shaped this family: tasks sharing a
buffer/session key must never run concurrently, and a backlog scheduler's
claim decision must reserve its key synchronously; queued snapshots of the
same buffer would otherwise retain a quadratic number of turn objects; and
compaction rewrites very large files that may be encrypted at rest with
path-bound (AAD) ciphertext, so a naive copy orphans the backup and a naive
rebuild can downgrade encryption. Shutdown drains need honest budgets, and a
provider breaker must be shared across coordinators, not per drain.

## Decision
Rules:

- Queue keys: tasks sharing a buffer/session key never run concurrently. A
  claim decision in flight takes a synchronous key reservation; if the
  processor is parked with only reserved entries, restart it. Settling a
  reservation hands key authority to the enqueued work.
- Snapshot sharing: a snapshot with an identical window reuses the existing
  node (holder-counted until the LAST sharer releases) instead of chaining a
  new tail=[] node that grows reachable depth under continuous unchanged
  ingress. Claim-backed backlog tasks and fail-closed front flushes never
  share. Retention accounting walks each chain reachably (a released
  ancestor can stay reachable through a descendant's base), and when every
  task exits the registry returns to exactly zero.
- Drain: the post-timeout tail gets its own budget and the drained flag must
  be honest; a key-scoped force-flush aborts only armed slots matching that
  key. Accepted scope groups use only their own pins and their own routing —
  no fallback to the triggering observe's scope.
- Live accessors: schedulers and coordinators observe runtime swaps through
  getter callbacks (getQmd, dependency accessors) rather than
  construction-time captures, so a backend swapped at startup does not keep
  running against a disposed instance.
- Ledger compaction: singleflight guards the compaction (both callers must
  pass the guard through the probe await); the min-interval throttle arms
  only on genuine no-op passes — a DEFERRED target (locked secure store) or
  a failed run must not arm it, and the pending-spill drain runs before a
  throttle return. The backup is re-encrypted AT the archive path (a byte
  copy carries the source AAD and orphans itself); a rebuild through a
  plaintext StorageManager must REFUSE an encrypted ledger rather than
  downgrade it, while a namespace-aware resolver (decoding the on-disk token
  to the canonical namespace) lets an encrypted over-cap ledger compact.
  Rebuild reconstructs from frontmatter and preserves append-only rows that
  frontmatter cannot reconstruct. Encryption probes occur under the ledger
  lock (TOCTOU), the safe lister maintains the claimed-orphan invariant, and
  scheduled full-corpus work under heap pressure is postponed with existing
  failure backoff rather than run.
- Orchestration code imports from real modules, never the index.js barrel —
  a barrel edge re-orders module initialization and leaves registries in
  TDZ. Generic recall excludes derived compounding reports, activity digests,
  location day-files, and per-directory sidecars; qmd:// collection prefixes
  are stripped authoritatively (collection authority, then caller-requested
  collection) and never twice.

## Consequences
Merged families: the file-size-cap extractions (queueing module, lifecycle
drain), the recall-exclusion and qmd-prefix rules, and the test-infrastructure
rationales (fixture casts, seam casts, suite provenance) were folded here
because none had enough records to stand alone; each is a self-contained
decision visible in its origin comments. Holder-counted sharing costs a
visit-set walk for accurate stats. Refusing to rebuild an encrypted ledger
without a resolver can defer an over-cap ledger indefinitely until the
namespace resolver is wired.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:24` — "/** * Controlled real-queue workload for the unbounded-retention flaw (#3324 * follow-up). While the drain is blocked "
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:229` — "// Each scope group is its own queued task with its own window; no cross-scope"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:230` — "// turn objects may be shared."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:315` — "// A claim-lease owner waiting on this exit must not be held by an unrelated"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:316` — "// running extraction: nothing of this task ever ran."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:331` — "// Documents what un-shared retention would be for the same workload: the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:332` — "// sum over full prefix snapshots (1+2+...+N), the quadratic term main pays."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:371` — "// The representation check is strictly stronger than bufferTurnsEqual."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:377` — "// Codex P2 reproduction attempt: under continuous single-key"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:378` — "// enqueue/dequeue, completed (\"released\") ancestors stay reachable via"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:379` — "// `base` while any descendant is queued. Their content is the descendant's"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:380` — "// own window prefix (verified element-wise at admit), so retention is the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:381` — "// union of the still-owed windows — and when every task has exited, the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:382` — "// registry must return to exactly zero with no historical remainder."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:411` — "// Exact Codex P2 shape: 10,000 cycles of one-unchanged-turn admissions"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:412` — "// with exactly one outstanding node (admit, then release the previous)."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:413` — "// Every admission against an equivalent base creates a tail=[] node"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:414` — "// chained onto the previous one: reachable depth grew to 10,000 while"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:415` — "// stats reported nodes=1 / tailRefs=0."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:431` — "// The final release may or may not remove the shared node depending on"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:432` — "// which sharer exited last; either way at most one bounded node remains."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:440` — "// Main follow-up to the Codex P2 fix: node reuse must keep registry"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:441` — "// accounting truthful while ANY sharer is still outstanding — the first"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:442` — "// completion may not drop the only bucket entry, and later identical"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:443` — "// admissions must keep aliasing onto the shared node."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:452` — "// RED on current code: the first release must not empty the registry while"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:453` — "// b and c still hold the node."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:483` — "// The refusal branch releases the node before any closure existed; the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:484` — "// accounting must be back to zero with no phantom holder, or the next"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:485` — "// admission cycle would drift."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:520` — "// Main stats-defect shape: admit [a], admit [a,b], release the first node."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:521` — "// The first node is out of the bucket but still reachable through the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:522` — "// second node's base, so both turn references are retained while only one"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:523` — "// direct tail remains — bucket-node sums under-reported this (tailRefs=1)."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:535` — "// Sibling nodes sharing a base chain: shared ancestors count once in the"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:536` — "// reachable tail set but once per node in the per-task window basis."
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:551` — "// One shared array grown in place mirrors the real pump: every trigger"
- `packages/remnic-core/src/orchestration/extraction-queue-bounded-retention.test.ts:552` — "// hands out a full prefix snapshot of the same buffer."
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:1` — "/** * Extraction queue coordinator — extracted from the orchestrator (issue #1526). * * Owns the background bounded-pa"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:51` — "/** Buffer/session key. Tasks sharing a key never run concurrently. */"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:82` — "/** * Buffer keys with a claim DECISION in flight (daemon backlog scheduler). * A reservation is taken synchronously B"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:138` — "// slot is free; wake it so the new task starts instead of waiting"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:139` — "// behind work it could overlap with."
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:145` — "/** * Synchronously reserve `key` so no task for it starts until the key's * owner (the backlog scheduler's claim deci"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:155` — "// The processor may be parked with ONLY reserved entries left: restart"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:156` — "// it so selection is re-evaluated (it will skip the reserved key)."
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:167` — "/** Settle a reservation: the key's decision is made and enqueued work (if * any) now carries the key authority itself"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:221` — "/** * Stop new producers and wait for all accepted work to finish. `timeoutMs` * is the nominal budget; `tailBudgetMs`"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:272` — "// Park until a task settles OR a new task is enqueued. A queued task"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:273` — "// whose key is still held always implies an in-flight task holding"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:274` — "// it, so inFlight is non-empty here whenever the loop must wait. A"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:275` — "// queued task behind a RESERVATION (no in-flight holder) leaves the"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:276` — "// loop instead; releaseKeyReservation and enqueue restart the"
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:277` — "// processor when it is not running."
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:327` — "/** Force-flush-scoped preemption: abort EVERY armed slot whose key matches * `key` and abort nothing when none does. "
- `packages/remnic-core/src/orchestration/extraction-queue-coordinator.ts:354` — "/** * Classify + log a failure from either the per-task catch inside * `runEntry` or the outer `processQueue().catch(."
- `packages/remnic-core/src/orchestration/extraction-queue-drain-budget.test.ts:10` — "// pauseAndDrain's first budget is nominal today: the post-timeout wait is"
- `packages/remnic-core/src/orchestration/extraction-queue-drain-budget.test.ts:11` — "// unbounded, so a drain can stall shutdown arbitrarily long with nothing"
- `packages/remnic-core/src/orchestration/extraction-queue-drain-budget.test.ts:12` — "// logged about what is still in flight or how long the tail ran (issue"
- `packages/remnic-core/src/orchestration/extraction-queue-drain-budget.test.ts:13` — "// #3517). The tail gets its own budget and the drained flag must be honest."
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:1` — "/** * Bounded-queue retention for automatic extraction snapshots (#3324 * follow-up). * * The coordinator's queue keep"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:45` — "/** Claim-backed backlog tasks own a different buffer view: never share. */"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:51` — "/** Fail-closed front flush: never share. */"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:124` — "/** Iterative root-first walk: recursive `yield*` delegation costs O(depth) * per item and hangs production-scale chai"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:133` — "/** * Element-wise consumer-equivalence of the chain's turns against a snapshot * prefix. Cost is O(chain.total) compa"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:164` — "/** * Admit one automatic snapshot for `bufferKey`: chain it onto the newest * queued same-scope snapshot when that is"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:175` — "// Identical window: reuse the existing node. Creating a tail=[] node"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:176` — "// here would chain onto the base and grow reachable depth (and admit"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:177` — "// cost) by one per admission under continuous unchanged ingress, while"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:178` — "// stats showed only the newest node. Sharing is exact: the element-wise"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:179` — "// equivalence above proved this window equals the base's. The holder"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:180` — "// count keeps the node registered until the LAST sharer releases."
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:209` — "/** Release one holder of a node when its task exits (or on enqueue * refusal). CONTRACT: called EXACTLY ONCE per admi"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:229` — "// Reachability-accurate accounting: a released ancestor can remain"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:230` — "// reachable through a queued descendant's `base`, so bucket-node sums"
- `packages/remnic-core/src/orchestration/extraction-queue-snapshot-sharing.ts:231` — "// under-report. Walk each chain once with a visited set of nodes."
- `packages/remnic-core/src/orchestration/extraction-task-queueing.ts:1` — "Extraction task queueing — split out to keep that module inside the house source-size cap (issue #1995)."
- `packages/remnic-core/src/orchestration/extraction-task-queueing.ts:58` — "// Native groups keep their own routing; skipped accepted prefixes require identity clearing."
- `packages/remnic-core/src/orchestration/extraction-task-queueing.ts:66` — "// Accepted groups use ONLY their own pins — no fallback to the"
- `packages/remnic-core/src/orchestration/extraction-task-queueing.ts:67` — "// triggering observe's scope."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:3` — "Import from the real modules, NOT the ../index.js barrel: a barrel edge ... TDZ (#3354)."
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:4` — "from orchestration code that explicit-capture.ts imports re-orders module initialization"
- `packages/remnic-core/src/orchestration/fact-dedup-window.ts:5` — "initialization and leaves access-boundary's registry in TDZ (#3354)."
- `packages/remnic-core/src/orchestration/full-corpus-heap-guard.ts:1` — "Heap guard for scheduled full-corpus work... Callers postpone the job and arm their existing failure backoff."
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:124` — "A QMD transport hands back collection-qualified paths (qmd://<collection>/activity/<date>.md, or <collection>/activity/…), and the collection is not always one this policy knows … Both spellings are therefore tested. Widening is safe in this direction and only here"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:152` — "Derived compounding reports sit at <root>/compounding/ and namespaces/<namespace>/compounding/. Generic recall must not return them: a root report can quote another namespace"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:177` — "The activity check, applied against the NAMESPACE root a hit came from. isActivityDigestPath is root-aware … a namespaced search rewrites hits to absolute paths beneath …/namespaces/<ns>/"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:196` — "The location day-file check, applied against the NAMESPACE root a hit came from — same rationale as isNamespacedActivityDigestPath"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:227` — "A qmd://<collection>/<path> URI states its collection UNAMBIGUOUSLY in the authority, so the leading segment of its normalized form is never a memory category — strip it outright"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:242` — "If the AUTHORITATIVE strip already fired — the prefix matched a configured collection — stop. Removing a second segment would take a real directory with it"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:251` — "The CALLER's own collection is authoritative: a request for collection: \"facts\" means that segment is the collection, whatever it is also the name of"
- `packages/remnic-core/src/orchestration/generic-recall-paths.ts:275` — "Derived per-directory sidecars (#2977): recall-excluded like OKF index files, still searchable. Basename-only, the same accepted tradeoff."
- `packages/remnic-core/src/orchestration/graph-recall-coordinator.ts:1` — "Graph-recall coordinator (#1526) ... getter callbacks so post-construction reassignment of live fields is honored; mirrors RecallRerank/ContradictionLinking accessor pattern"
- `packages/remnic-core/src/orchestration/lifecycle-pending-fallback-drain.ts:1` — "Fallback lifecycle pending-append drain... Moved verbatim out of maintenance.ts (issue #2033) so that file stays under the structural size ceiling"
- `packages/remnic-core/src/orchestration/lifecycle-pending-fallback-drain.ts:33` — "safe lister / claimed-orphan invariant (#2033)"
- `packages/remnic-core/src/orchestration/lifecycle-pending-fallback-drain.ts:56` — "encryption probe must occur under the ledger lock (TOCTOU) (#2033)"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1` — "/** * Colocated suite for MaintenanceScheduler (issue #1526 PR1). * * These tests were ported from orchestrator-flush"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:63` — "/** Build a fixture PluginConfig. Cast bridges a partial fixture to the full * contract — only the fields the schedul"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:67` — "// Arm the debounced QMD maintenance gate the way the orchestrator does."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:69` — "// Keep the debounce timer from firing during the synchronous test pass;"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:70` — "// dispose() clears it in finally."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:76` — "/** Minimal QMD stub — runQmdMaintenance's namespaces branch never touches qmd * directly; only isAvailable() is chec"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:221` — "// Re-arm pending for the second budget rotation (the debounce timer is"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:222` — "// already armed from the first call, so this just re-sets the flag)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:706` — "// Regression for issue #1526 PR1: when MaintenanceSchedulerDeps.qmd was a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:707` — "// fixed reference captured at construction, the orchestrator's runtime swap"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:708` — "// `this.qmd = new NoopSearchBackend()` (initialize / startupSearchSync,"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:709` — "// invoked when the collection is missing) left the scheduler running"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:710` — "// debounced maintenance against the disposed/stale backend. The live"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:711` — "// `getQmd: () => this.qmd` accessor must observe the swap so maintenance"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:712` — "// short-circuits once the backend reports unavailable."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:753` — "// The orchestrator swaps to a Noop backend at runtime when the collection"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:754` — "// is missing — the scheduler must observe the new reference, not the one"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:755` — "// captured at construction."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:773` — "/** Access the private size-gated compaction trigger for focused testing. The * `lifecycleLedgerMaxBytes` seam lets a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:780` — "// Arming this to `Date.now()` puts a focused test inside the min-interval"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:781` — "// window so it can prove the throttle path (#2033)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:810` — "// Oversized legacy ledger: many junk rows the rebuild will discard (it"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:811` — "// reconstructs from frontmatter), so the compacted output is far smaller."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:822` — "// The compaction path never touches the router/catalog."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:896` — "// Oversized: junk pad rows the rebuild discards + one valid append-only"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:897` — "// event frontmatter cannot reconstruct and MUST survive compaction."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:923` — "// Frontmatter-derived rows are reconstructed AND the append-only capture row"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:924` — "// is carried over (a bare rebuild dropped it silently before this fix)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:975` — "// Re-grow the ledger past the threshold; a second immediate call is"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:976` — "// inside the min-interval window and must be throttled (no recompaction)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1031` — "// Inside the min-interval window so the awaited over-cap probe — the ONLY"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1032` — "// await between the singleflight guard and claiming it — is exercised."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1035` — "// Deterministically open the race window the reviewer flagged: gate the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1036` — "// over-cap probe so BOTH callers pass the early `lifecycleCompactionInFlight`"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1037` — "// guard and park inside the same await, then release them together. An"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1038` — "// over-cap encrypted ledger (probe => true) bypasses the throttle, so both"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1039` — "// fall through toward claiming the guard."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1041` — "// Resolves the instant the SECOND caller enters the probe, so the test"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1042` — "// releases the gate on a real signal rather than a timed poll."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1053` — "// Count real compaction attempts. Each one rewrites the ledger and writes"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1054` — "// a verbatim (400MB-class in production) backup, so a second call here is"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1055` — "// exactly the duplicate expensive work singleflight must prevent."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1065` — "// Both callers must reach the gated probe before either can claim the guard."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1089` — "/** Scheduler wired with a live secure-store-configured root storage (issue * #1910, Cursor Medium / Codex P2). */"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1111` — "// A required-but-locked secure store makes the rewrite throw"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1112` — "// SecureStoreLockedError, so the first compaction fails."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1125` — "// Failed run must NOT shrink the ledger and must NOT arm the throttle."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1128` — "// Unlock the store, then call again INSIDE the min-interval window. If the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1129` — "// failed run had armed the throttle this second call would be skipped and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1130` — "// the ledger would stay oversized. Because it did not, the ledger compacts."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1173` — "// The existing ledger here is PLAINTEXT (only the rewrite encrypts), so its"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1174` — "// backup is a directly-readable verbatim copy — the source-AAD re-encrypt only"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1175` — "// applies when the EXISTING ledger is itself encrypted (#2033)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1206` — "// An oversized ENCRYPTED existing ledger of valid legacy events. Its bytes"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1207` — "// are path-bound to the SOURCE via AAD, so a byte copy to the archive path"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1208` — "// would not decrypt there — the exact orphaning the fix prevents."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1244` — "// Decrypts AT THE BACKUP PATH — a directly readable recovery ledger."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1255` — "// A byte-for-byte copy would carry the SOURCE path's AAD and fail here."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1284` — "// Namespace: encrypted-at-rest oversized ledger whose secure store is LOCKED"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1285` — "// (required, no key). Compaction must DEFER it (not skip) so this untouched,"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1286` — "// still-oversized ledger keeps its retry eligibility."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1321` — "// Re-grow the root within the min-interval window. Because a target was"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1322` — "// DEFERRED (not a genuine no-op), the throttle must NOT have armed, so this"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1323` — "// second in-window pass still recompacts — the #2033 throttle fix."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1347` — "// An encrypted pending spill, exactly as a lock-timed-out append leaves it."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1356` — "// Compaction disabled (threshold 0): the unconditional root drain must still"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1357` — "// fold the spill back into the ledger so no lifecycle row is lost."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1399` — "// Namespace: a keyed (unlocked) secure store, no oversized ledger — so the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1400` — "// first pass SKIPS it (skip never blocks arming the throttle)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1429` — "// AFTER the throttle armed, a namespace impression spills (exactly as a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1430` — "// lock-timed-out append leaves it) — encrypted for the namespace store."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1439` — "// Pass 2 is inside the min-interval window: it WILL return on the throttle,"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1440` — "// but it must first drain the namespace pending spill. Before the #2033"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1441` — "// fix the throttle return preceded namespace draining and the spill was"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1442` — "// stranded for the whole interval."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1518` — "// Namespaces enabled but the catalog is inactive, so only the filesystem"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1519` — "// fallback finds this per-namespace ledger. It is encrypted at rest and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1520` — "// oversized, but the fallback has no secure StorageManager for a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1521` — "// catalog-disabled namespace. The rebuild-chokepoint guard must REFUSE to"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1522` — "// rebuild it through a plaintext StorageManager — leaving it untouched and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1523` — "// still encrypted — rather than downgrade it to plaintext."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1563` — "// Catalog disabled but namespaces + secure-store enabled: only the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1564` — "// filesystem fallback finds this per-namespace ledger. With a namespace"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1565` — "// storage resolver wired (the production orchestrator wiring), the fallback"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1566` — "// must resolve the namespace's root-keyed secure StorageManager so the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1567` — "// encrypted, over-cap ledger COMPACTS — instead of deferring forever behind"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1568` — "// a keyless plaintext target (the pre-fix behavior asserted by the sibling"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1569` — "// \"never downgrades\" test, which wires no resolver)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1595` — "// The resolver is consulted with the DECODED namespace (the on-disk token is"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1596` — "// decoded back to its canonical namespace) and returns the namespace's"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1597` — "// root-keyed, unlocked secure storage rooted AT the fallback dir — exactly"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1598` — "// what the live router's storageFor(namespace) yields."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1601` — "// unlocked + encrypt-on-write ⇒ rewrite stays encrypted."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1620` — "// Named seam cast (reason: assert the resolved target and its compaction"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1621` — "// outcome directly), mirroring the extended casts used by the singleflight"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1622` — "// and request-wiring tests above."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1656` — "// On disk: rewritten, still encrypted at rest (no plaintext downgrade), and"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1657` — "// decrypts back to the reconstructed events via the same key."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1678` — "// A VALID namespace (passes isSafeRouteNamespace) that is long enough that"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1679` — "// its identity token — the on-disk dir name — exceeds the router's 64-char"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1680` — "// route-namespace limit. Passing that raw token back to the resolver (the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1681` — "// pre-fix behavior) makes the router reject it, dropping the fallback to a"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1682` — "// keyless target that defers the encrypted over-cap ledger forever. The fix"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1683` — "// decodes the token to the canonical namespace before resolving."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1727` — "// Mirror the production router: reject anything that is not a safe route"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1728` — "// namespace, exactly how getWritableStorageForNamespace throws. With the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1729` — "// pre-fix behavior the fallback passed the over-64 token and this resolver"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:1730` — "// would throw, stranding the ledger on a keyless deferred target."
