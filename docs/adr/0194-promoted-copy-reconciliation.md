# Promoted-Copy Probes, Reconciliation, and Windowed Promotion Writes

Status: accepted

## Context
Promoting a fact to shared/profile namespaces copies data across storages,
and each copy is a chance for races, partial failure, and stale reads: two
writers can probe "no promoted copies" simultaneously, a torn shard write can
land between payload build and promotion, a payload revalidation can pass
while the promotion commits against a record that has since merged, and a
concurrent writer can publish a pre-merge body after the initial scan. A
suppressed or failed promotion must also not leave the shared namespace's
catalog, graph edges, or harmonic queue stale. The commit window (#3288)
defines exactly when a write is durable and what side effects must be
finalized if the batch later throws.

## Decision
Rules:

- One promoted-copy scan per namespace per batch (#2330 finding F); but a
  promotion this batch performed forces the next fact to rescan, and only
  ACTIVE copies count as promoted — scan EVERY resolvable layer, not only
  today's targets, so historically promoted copies are found.
- An unreadable payload is not a no-promotion: treat it as a reconciliation
  trigger. Confirm a cached payload against a fresh fingerprint before use;
  a pending marker whose expected digest matches nothing is recovered lazily.
- The reconciliation guard's outcomes are "keep copies" and "retire" — never
  silently destroy. On the no-promotion path, re-read the committed source
  record to serve as the reconciliation basis. Every exit returns the LAST
  copy id written, profile copies included.
- Promotion writes run inside a windowed recheck: the outer gate ran outside
  the window, so a twin committing meanwhile is suppressed by the in-window
  recheck; contention throws fail-closed. Merge-on-write commits claims into
  an existing target id and enqueues the committed target for the harmonic
  pass; the create path's graph-edge build and behavior-signal ledger must
  observe committed merges too.
- A batch-end finalization boundary runs at most once per persist pass, after
  the write is durable and before any throwing post-write step; failure
  paths finalize committed writes (scheduleQmd) so hash/behavior/harmonic/
  temporal side effects still land on a partial batch.
- Catalog touches: a shared promotion is the only write that namespace
  receives on this path — touch it AFTER the promoted write and the shared
  temporal supersession so the timestamp never precedes a later durable
  mutation; best-effort, never crash the promotion. Fact-less extractions
  that persist durable non-fact output record exactly one base-namespace
  catalog touch using the KNOWN namespace name, not a dir-decoded guess.
- Invalidate the in-process GraphIndex edge cache when a transaction rolls
  back, or a warm cache keeps rolled-back edges.
- If the target namespace's own tombstone blocked the promotion, the row
  lands pending_review; do not supersede active target memories.

## Consequences
Probes and reconciliations add reads on the promotion path; skipping them
is how the P1-A races happened. The keep-vs-destroy guard means reconciliation
can leave redundant copies rather than risk deleting committed data.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist-deps.ts:97` — "#2807 (finding 4): invalidate the in-process GraphIndex edge cache ... warm cache would keep rolled-back edges for full "
- `packages/remnic-core/src/orchestration/extraction-persist-failure.ts:5` — "Fail a persistence pass after a durable write rejected (#3227 ...) rethrown so the run leaves its input retryable"
- `packages/remnic-core/src/orchestration/extraction-persist-failure.ts:23` — "Batch-end finalization for one persistExtraction pass (#3288). bind ... finalizer runs at most once ..."
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:12` — "# #2330 round N+8 (P1-A): a profile-only auto-promotion plan writes the profile copy but skips shared promotio"
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:120` — "Seed a merge target with past timestamps and high importance so the incoming fact never bypasses as unpreservable metada"
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:121` — "incoming fact never bypasses as unpreservable metadata."
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:147` — "Band neighbor for the incoming fact only ([minSimilarity, threshold))."
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:193` — "Interleave at the REAL seam: the promoted-copy probe scans the team namespace through readAllMemories..."
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:281` — "#2330 round N+10 (A): the P1-A race, minus the replacement promotion. A low-confidence incoming fact merges in"
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:382` — "Same interleaving as P1-A: the probe's first team-namespace scan publishes the PRE-merge profile copy right after the re"
- `packages/remnic-core/src/orchestration/extraction-persist-profile-promotion.test.ts:400` — "The downgrade: incoming confidence 0.5 (inferred) against a plan whose promotion minimum is \"implied\" — merged record ke"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:100` — "The copy was promoted while shared writes were allowed; the profile has"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:149` — "The copy was promoted while the layer was listed in autoPromote.targets;"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:210` — "Three judge-approved facts in one batch, each probing the same target:"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:225` — "A promotion this batch performed must force the next fact to rescan."
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:232` — "Race being modeled: the pre-mutation promoted-copy probe reported none,"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:285` — "No-promotion path: the committed source record is re-read to serve as"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:344` — "The namespace received promoted copies while \"userGlobal\" was listed in"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:426` — "Race: writer A built its promotion payload from the committed record,"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:474` — "The residual window: the payload revalidates clean, the promotion"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:538` — "The payload builder's post-commit reread failed TRANSIENTLY (secure"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:552` — "A concurrent writer published the PRE-merge body after the initial"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:669` — "A torn shard write lands between build and promotion: absence became"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.test.ts:932` — "A pending marker whose expected digest matches nothing: lazy recovery"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:1` — "Auto-promotion gating helpers for the extraction-persist pipeline"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:301` — "Round N+12 (B): enumerate EVERY resolvable layer, not only today's"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:358` — "Round N+11 (A): only ACTIVE copies count as promoted (§41 —"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:457` — "#2807 (finding 1): an unreadable payload is not a no-promotion"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:486` — "#2813 (P1 A, P1 B) + #2870: confirm the cached payload against a"
- `packages/remnic-core/src/orchestration/extraction-persist-promotion.ts:592` — "Round N+13 (A): the guard's outcomes are \"keep copies\" and \"retire"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:156` — "// #3288: one batch-end finalization boundary per pass"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:189` — "// #2330 finding F: one promoted-copy scan per namespace per batch"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:357` — "// #1578 — bi-temporal bounds + provenance forwarded to profile-target copies."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:475` — "// Windowed destination write (PRRT_kwDORJXyws6zzdG4): the gate above"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:476` — "// ran outside the window; a twin committing meanwhile is suppressed"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:477` — "// by the in-window recheck. Contention throws fail-closed below."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:496` — "// #1645: if the TARGET namespace's own tombstone blocked this promotion,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:497` — "// the row lands pending_review — do NOT supersede active target memories."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:523` — "// #1645 TV6: tombstone-blocked = pending_review; skip catalog/index/behavior."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:567` — "// #1578 — bi-temporal bounds + ingestion provenance forwarded to the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:568` — "// shared-namespace copy (cursor bugbot)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:588` — "// P1-A (#2330 N+8): every exit returns the LAST copy id written, profile copies included."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:872` — "// Windowed destination write (PRRT_kwDORJXyws6zzdG4): the shared gate"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:874` — "// the in-window recheck; contention throws fail-closed to the outer"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:875` — "// catch. Supersession rides along for the suppressed branch."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:926` — "// Catalog touch (issue #1499, Issue B + ordering sweep): a shared-"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:927` — "// namespace promotion is the ONLY write the shared namespace receives on"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:928` — "// this path, so without this the shared record's lastWriteAt stays stale"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:929` — "// and `writtenSince` filters / maintenance fanout skip it. Record AFTER"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:930` — "// the promoted write and the shared temporal-supersession attempt so the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:931` — "// catalog timestamp never precedes a later durable frontmatter mutation in"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:932` — "// the same promotion pass. The hot-path source-namespace touch uses a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:933` — "// different storage dir, so this does not double-count the source."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:934` — "// Best-effort and failure-tolerant — it must never crash the promotion."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:935` — "// #1645 TV6: same guard as the profile-target promotion above."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:955` — "// feeds the merged-target reconciliation (round N+7 B)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:961` — "// P1-A: profile copies written pre-failure still reconcile"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1553` — "// Track the KNOWN target namespace NAME alongside targetStorage (round 6,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1554` — "// codex P2 — NCQI0). Re-deriving it from `targetStorage.dir` mangles a raw"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1555` — "// namespace literally named like a canonical token (e.g. `ns-616c706861`"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1556` — "// served from its legacy raw dir decodes to `alpha`). We seed it from the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1557` — "// EXPLICIT base namespace the caller used to obtain `storage` (NHIdx, codex"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1558` — "// P2) — `selfNamespace`/`writeNamespaceOverride` — so the catalog write touch"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1559` — "// records the real namespace, not a guess decoded from the directory. We only"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1560` — "// fall back to decoding the dir when no base namespace was passed (legacy"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1561` — "// callers). The EXPLICIT routed name (below) still overrides this verbatim."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2201` — "// PR #2016: never defer here — fallible chunk/artifact writes follow this // durable parent .md; flush the hash now so…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2202` — "// durable parent .md; flush the hash now so a throw can't strand it (dup)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2220` — "// #3288: the parent is durable now. Track it before any post-write step // that can throw (non-chunked rule, #3231); a…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2221` — "// that can throw (non-chunked rule, #3231); a retry exact-dedupes it."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2537` — "// Normal write (no chunking). Cite once so memory and artifact copies share one timestamp; hash the RAW pre-citation t…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2546` — "if (semanticMerge.action === \"created\" && semanticMerge.reason === \"backend_unavailable\") batchBackendUnavailable = tru…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2550` — "// D + final round (A/B) + N+7 (A/B) + N+18 (B): with no promoted copies the create path's promotion must still run — f…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2552` — "// Round N+10 (A) + #2807 (finding 1): promotion AND reconciliation — including the no-promotion path, where a below-th…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2554` — "// Round N+7 (D): the merged body joins the INTERNAL temporal/tag index refresh (id-keyed, incremental); the PUBLIC per…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2557` — "// Finding B (round N+3): enqueue the surviving target so the end-of-batch harmonic pass covers the committed merged cl…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2561` — "// Round N+5 (A+B): create-path parity — the create path's graph-edge build and // behavior-signal ledger entry must al…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2562` — "// behavior-signal ledger entry must also observe a committed merge."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2569` — "// Round N+17 (B): artifact write LAST; the helper isolates its own failure."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2609` — "// PR #2016: never defer inside the commit window (chunked-path // rule): a peer loading an authoritative index after t…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2644` — "// #3231: the fact is durable now. Track it before any post-write step // that can throw, so the batch-end finalization…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2645` — "// that can throw, so the batch-end finalization on a failure path still"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2646` — "// covers it (a retry exact-dedupes the fact and would not re-queue it)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2825` — "// PR #2016 / #3231: finalize deferred side effects for facts already // durable before propagating so hash/behavior/ha…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2826` — "// durable before propagating so hash/behavior/harmonic/temporal/QMD"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2827` — "// still land on a partial batch."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2835` — "// Tracks whether THIS extraction persisted any durable, non-fact output // (entity / relationship / profile / question…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2836` — "// (entity / relationship / profile / question) to the BASE namespace."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2837` — "// A fact-less extraction still records exactly one base-namespace catalog"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2838` — "// touch after all writes complete (NHZEZ, codex P2)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2960` — "// Catalog touch for durable NON-FACT outputs (NHZEZ / NIIly, codex P2). The // per-fact catalog touch (storage chokepo…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2961` — "// per-fact catalog touch (storage chokepoint #1522) above only fires inside the fact write loop, so"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2962` — "// an extraction that persists ONLY entities, relationships, profile updates,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2963` — "// questions, or an identity reflection (no facts) would record durable data to"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2964` — "// the BASE namespace's storage without ever touching the catalog — leaving that"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2965` — "// namespace's `lastWriteAt` stale so `listNamespaces({writtenSince})` /"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2966` — "// write-recency QMD maintenance miss the write. All of these are written to the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2967` — "// BASE `storage` (not the per-fact routed `targetStorage`), so we record ONE"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2968` — "// base-namespace touch here, AFTER every non-fact write completes. Use the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2969` — "// KNOWN base namespace name, not a dir-decoded guess (NCQI0). One touch per"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2970` — "// namespace per extraction — `markWrite` is idempotent, so if the fact path"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2971` — "// already touched the base namespace this only refreshes `lastWriteAt`."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2972` — "// Best-effort and failure-tolerant (storage chokepoint #1522 swallows errors)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2977` — "// Shared batch-end finalization (hash, behavior, harmonic, temporal). // Failure paths call it with scheduleQmd=true (…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2978` — "// Failure paths call it with scheduleQmd=true (#3231); it runs once per pass (#3288)."
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:53` — "// End-to-end contract: the derived episode holds exactly one body per"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:54` — "// target (the final committed one) and anchors from BOTH merges survive."
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:77` — "// The parity gate lets an incoming fact with NO entityRef merge into a"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:78` — "// target that HAS one (only a differing non-undefined incoming entity"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:79` — "// refuses), and incoming tags are a subset of the target's. The enqueue"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:80` — "// used to stamp the incoming fact's fields onto the merged entry, so the"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:81` — "// episode held the cumulative body while missing the target's committed"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:82` — "// entity association and extra tags — and deriveHarmonicRecords skipped"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:83` — "// the deterministic entity cue/topic linkage for the merged claims."
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:152` — "// Control: a reread that no longer matches the merged body (the record"
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.test.ts:153` — "// advanced mid-flight) falls back to the incoming fact's own fields."
- `packages/remnic-core/src/orchestration/harmonic-construction-persist.ts:40` — "Finding B (round N+3, PR #2771): merge-on-write commits claims into an EXISTING target id; enqueue committed target"
