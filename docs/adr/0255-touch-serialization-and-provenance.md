# Touches merge field-by-field under serialization; provenance is creation-only with a single config-to-write upgrade

Status: accepted

Catalog touches are fire-and-forget and arrive concurrently: hot-path
reads/writes race router resolve hooks, multiple processes append full
snapshots, and compaction folds the log. Last-record-wins would silently
erase concurrent fields, and a clobbered `discoveredBy` breaks
`listNamespaces({discoveredBy:"write"})`.

## Decision

- Every touch's read -> merge -> append runs as ONE serialized critical
  section, so concurrent touches for the same namespace always read the
  latest state and merge rather than overwrite; compaction preserves the
  MAX of each touch field across processes (field-level merge, never plain
  last-record-wins).
- `discoveredBy` and `createdAt` are CREATION-ONLY: once a record exists,
  no read/register/resolve touch relabels them. The single exception: a
  real WRITE upgrades `discoveredBy` from `config` to `write` (never a
  downgrade, never relabeling read), so genuinely written namespaces are
  visible to the write filter even though the config register hook fired
  first.
- A chunked extraction path that writes parent memory then continues past
  the non-chunked write must record its OWN write touch, exactly like the
  non-chunked path.
- The router's once-per-namespace resolve-hook dedup accounts for IN-FLIGHT
  async registrations: a burst of cache hits for the same namespace
  collapses to one hook invocation via an in-flight marker set
  synchronously; a DROPPED registration (hook returned false, e.g. rebuild
  lock timeout) clears the marker so a later storageFor() retries it.
  The dedup key is (namespace, storageDir), not namespace alone, so a
  changed storageDir still gets its own registration.
- A rejecting async onResolve hook is swallowed (best-effort) and never
  crashes storage resolution.
- Internal touch validation runs up front, outside the chain, so caller
  facing rejections surface deterministically rather than interleaved with
  serialized I/O.

## Consequences

No concurrent touch field can be lost, but every touch pays a lock/queue
wait. Dropped registrations are retried later, so a lock-contended burst may
register slightly late rather than never.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog.test.ts:659` — "// Return the registration promise so the router tracks it as in-flight and"
- `packages/remnic-core/src/namespaces/catalog.test.ts:660` — "// `whenResolveHooksSettled()` can await it deterministically (no timer race)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:675` — "// ── Issue 1 (cursor[bot]): the register/resolve hook must NOT clobber prior"
- `packages/remnic-core/src/namespaces/catalog.test.ts:676` — "// provenance on an existing record. A namespace first discovered via a `write`"
- `packages/remnic-core/src/namespaces/catalog.test.ts:677` — "// touch must keep discoveredBy:"write" even after later routing resolves fire"
- `packages/remnic-core/src/namespaces/catalog.test.ts:678` — "// the `config` register hook (including on router cache hits)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:709` — "// A record first PRE-REGISTERED via the router's onResolve hook (config) is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:710` — "// UPGRADED to "write" by a later real write touch (round 6, codex P2 — NBPmT):"
- `packages/remnic-core/src/namespaces/catalog.test.ts:711` — "// `storageFor()` fires registerResolved (config) before the storage chokepoint runs,"
- `packages/remnic-core/src/namespaces/catalog.test.ts:712` — "// so without the upgrade `listNamespaces({ discoveredBy: "write" })` would miss a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:713` — "// genuinely-written namespace. A non-write touch (read/register) still preserves"
- `packages/remnic-core/src/namespaces/catalog.test.ts:714` — "// provenance."
- `packages/remnic-core/src/namespaces/catalog.test.ts:753` — "// ── Issue 4 (codex P2): concurrent fire-and-forget touches for the same"
- `packages/remnic-core/src/namespaces/catalog.test.ts:754` — "// namespace must each read the latest record inside the serialized chain and"
- `packages/remnic-core/src/namespaces/catalog.test.ts:755` — "// merge their fields — none may be dropped by a racing append winning"
- `packages/remnic-core/src/namespaces/catalog.test.ts:756` — "// compaction. Fire many touches without awaiting between them, then assert the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:757` — "// final compacted record retains read + write + maintenance + register fields."
- `packages/remnic-core/src/namespaces/catalog.test.ts:792` — "// Tighter race: a register firing concurrently with read+write must not drop"
- `packages/remnic-core/src/namespaces/catalog.test.ts:793` — "// the write's lastWriteAt or the read's lastReadAt (the exact scenario the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:794` — "// codex thread called out — the router hook is fire-and-forget alongside the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:795` — "// hot-path read/write touches). Run several rounds on distinct namespaces so"
- `packages/remnic-core/src/namespaces/catalog.test.ts:796` — "// the assertion does not depend on one lucky scheduling."
- `packages/remnic-core/src/namespaces/catalog.test.ts:849` — "// ── Issue 2 (cursor[bot]): the chunked extraction path writes the parent memory"
- `packages/remnic-core/src/namespaces/catalog.test.ts:850` — "// then `continue`s past the non-chunked write, so it must record its OWN write"
- `packages/remnic-core/src/namespaces/catalog.test.ts:851` — "// touch. This asserts the catalog contract the orchestrator's chunked branch now"
- `packages/remnic-core/src/namespaces/catalog.test.ts:852` — "// relies on: a markWrite (as fired by the chunked path) updates lastWriteAt for"
- `packages/remnic-core/src/namespaces/catalog.test.ts:853` — "// the target namespace exactly like the non-chunked path."
- `packages/remnic-core/src/namespaces/catalog.test.ts:912` — "// Companion: markRead and registerResolved touches racing a rebuild are also"
- `packages/remnic-core/src/namespaces/catalog.test.ts:913` — "// preserved (the lost-touch class covers all touch kinds, not just write)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1047` — "// ── Round 3, Issue #2 (cursor Low): rebuild must preserve creation-only"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1048` — "// provenance. A configured/policy namespace first DISCOVERED via a write touch"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1049` — "// keeps discoveredBy:"write" after rebuild — rebuild must not reset it to"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1050` — "// "config" just because it is listed in policies. Mirrors the touch-path"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1051` — "// creation-only invariant."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1422` — "// ── Round 4, Issue #1 (cursor Medium): a read touch with no explicit storageDir"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1423` — "// must record the SAME on-disk root the router resolves — a legacy raw-name dir"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1424` — "// when that is where the data lives — not the lexical tokenized guess."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2690` — "// ── Round 7 (codex P2 — NDo8C): an ASYNC onResolve hook that REJECTS must not"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2691` — "// crash storage resolution — the rejection must be swallowed (best-effort)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2713` — "// ── NFJV- (codex P2): the once-per-namespace resolve-hook dedup must account for"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2714` — "// IN-FLIGHT async registrations. The catalog's onResolve hook is async (returns"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2715` — "// registerResolved(...)), so the `notifiedResolved` map is only set after the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2716` — "// promise settles. A burst of storageFor() cache hits for the SAME namespace"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2717` — "// before the first append finishes must NOT each fire their own registration —"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2718` — "// otherwise hot recall/extraction grows namespaces.jsonl with duplicate touches."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2754` — "// ── NFJV- inverse: a DROPPED registration (hook returns false — e.g. the touch"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2755` — "// could not acquire the rebuild lock) must clear the in-flight marker so a LATER"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2756` — "// storageFor() RETRIES it. A dropped touch must remain retryable, not be"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2757` — "// permanently suppressed by the in-flight dedup."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2791` — "// ── In-flight dedup under a DROPPED hook (cursor Medium 06f58a7c, codex P2)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2792` — "// The serializer strictly orders queued tasks, but ordering alone does not"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2793` — "// collapse a burst when the hook returns `false` (dropped registration, e.g. a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2794` — "// rebuild-lock timeout): `notifiedResolved` stays unset, so every queued sibling"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2795` — "// task passes its re-check and re-invokes the hook — N serial lock waits. The"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2796` — "// `inFlightResolveHooks` marker (set synchronously before queueing) collapses the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2797` — "// burst to a single hook invocation; the drop stays retryable on a LATER"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2798` — "// storageFor(). This test PROVE-FAILS without the marker (calls === N) and PASSES"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2799` — "// with it (calls === 1)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2804` — "// Gated hook that DROPS (returns false) once released. This is the real"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2805` — "// scenario the reviewers flagged: the catalog's onResolve waits on the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2806` — "// rebuild lock (slow), times out, and returns false. While that hook is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2807` — "// in-flight, a burst of cache hits must collapse to the one in-flight"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2808` — "// registration instead of each queueing its own serial lock wait."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2840` — "// ── Composite-key in-flight dedup (cursor Medium, codex P2): the in-flight"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2841` — "// marker must be keyed by (namespace, storageDir), NOT namespace alone. A"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2842` — "// CHANGED storageDir (migration/realignment) for the same namespace while"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2843` — "// another dir's hook is pending must still get its OWN hook invocation — it is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2844` — "// not collapsed onto the old dir's pending registration. A namespace-only key"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2845` — "// would silently drop the new-dir notification."
- `packages/remnic-core/src/namespaces/catalog.ts:1317` — "// Provenance (discoveredBy) and createdAt are CREATION-ONLY fields. Once a"
- `packages/remnic-core/src/namespaces/catalog.ts:1318` — "// record exists they are preserved, so a routine routing/recall touch (or"
- `packages/remnic-core/src/namespaces/catalog.ts:1319` — "// the router's `config` register hook firing on a cache hit) can never"
- `packages/remnic-core/src/namespaces/catalog.ts:1320` — "// clobber the original discovery source — e.g. a `write`-discovered record"
- `packages/remnic-core/src/namespaces/catalog.ts:1321` — "// is not reset to `config` by a later resolve. Touch fields (lastReadAt /"
- `packages/remnic-core/src/namespaces/catalog.ts:1322` — "// lastWriteAt / lastMaintenanceAt) still update on every touch below."
- `packages/remnic-core/src/namespaces/catalog.ts:1336` — "// Update mutable fields. storageDir and kind may change over a"
- `packages/remnic-core/src/namespaces/catalog.ts:1337` — "// namespace's lifetime, so they upsert."
- `packages/remnic-core/src/namespaces/catalog.ts:1340` — "// PROVENANCE (creation-only, with one upgrade — round 6, codex P2 NBPmT):"
- `packages/remnic-core/src/namespaces/catalog.ts:1341` — "// `discoveredBy` is otherwise preserved for existing records (a routine"
- `packages/remnic-core/src/namespaces/catalog.ts:1342` — "// read/register/resolve never relabels it). The single exception is a real"
- `packages/remnic-core/src/namespaces/catalog.ts:1343` — "// WRITE upgrading a record that was only PRE-REGISTERED by the router's"
- `packages/remnic-core/src/namespaces/catalog.ts:1344` — "// `onResolve` hook (`discoveredBy: "config"`) before any data was written."
- `packages/remnic-core/src/namespaces/catalog.ts:1345` — "// Without this upgrade, `listNamespaces({ discoveredBy: "write" })` misses"
- `packages/remnic-core/src/namespaces/catalog.ts:1346` — "// namespaces that were genuinely written, because `storageFor()` fires"
- `packages/remnic-core/src/namespaces/catalog.ts:1347` — "// `registerResolved()` (config) before `recordCatalogWrite()` runs. We"
- `packages/remnic-core/src/namespaces/catalog.ts:1348` — "// upgrade ONLY config→write — never downgrade write/read, never relabel a"
- `packages/remnic-core/src/namespaces/catalog.ts:1349` — "// read-discovered record — so the authoritative "this namespace has been"
- `packages/remnic-core/src/namespaces/catalog.ts:1350` — "// written" signal is recorded."
- `packages/remnic-core/src/namespaces/catalog.ts:1829` — "// Configured-and-present namespaces keep config provenance; purely"
- `packages/remnic-core/src/namespaces/catalog.ts:1830` — "// discovered ones are scan."
