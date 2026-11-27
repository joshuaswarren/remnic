# Cross-namespace search degrades per leg and reports skips explicitly

Status: accepted

## Context

A cross-namespace search fans out to many backends. One stalled backend leg once held the entire search (#3139); an aborted leg's second rejection once killed the daemon with an unhandled AbortError; unavailable backends were indistinguishable from true no-matches; and health polls paid a full ~1.5s QMD re-probe. Meanwhile the flat-root default namespace's base collection had to exist or recall silently returned 0 results (#1929), and QMD collection names can collide with memory category directories.

## Decision

Each cross-namespace leg gets its own timeout budget: the backend receives the deadline signal, the await races the budget, a leg that outlives it degrades only its own namespace, and real errors and caller aborts still propagate; when a leg was started with an already-aborted signal, a handler absorbs its self-rejection so nothing is left unhandled. An unavailable or collection-less backend reports an explicit skip like any other QMD skip (#1536) rather than an empty contribution. Health answers are cached briefly (short TTL) but only when healthy AND carrying backlog data; degraded or incomplete answers re-probe immediately so readiness polls see recovery on the next call. Forced refreshes bypass the throttled all-collections update: their success must prove current writes are indexed. Backends without strict update semantics (Orama, LanceDB, Meilisearch, remote) fail open but report `updateCompleted()` so strict callers get a real failure instead of fake success. The flat-root default namespace targets the BASE collection on both index and search sides, is auto-created (idempotent `ensureCollection`) with nested `namespaces/` results stripped from default recall so index and search stay symmetric, and QMD collection prefixes are stripped only when genuinely a collection prefix, never when the name collides with a memory category dir. Search results resolve to absolute paths so (namespace, path) identity is globally unique; display surfaces relativize for portability.

## Consequences

A single slow backend cannot stall or kill search; skip semantics are observable; fresh flat-root installs get working recall. Cost: per-leg timeouts add budget bookkeeping, and health caching must distinguish degraded from healthy answers.

## Origin comments
- `packages/remnic-core/src/namespaces/search.test.ts:429` — "// Same-relative-path hits from distinct namespaces resolve to distinct"
- `packages/remnic-core/src/namespaces/search.test.ts:430` — "// absolute paths (globally-unique identity); display surfaces relativize."
- `packages/remnic-core/src/namespaces/search.test.ts:511` — "// The backend leg gets the aborted signal and rejects after the router has"
- `packages/remnic-core/src/namespaces/search.test.ts:512` — "// already returned its own rejection. Nothing may be left holding that"
- `packages/remnic-core/src/namespaces/search.test.ts:513` — "// second rejection: on the daemon it is an unhandled AbortError and the"
- `packages/remnic-core/src/namespaces/search.test.ts:514` — "// process exits (<internal-host>, 12 Nov 2026)."
- `packages/remnic-core/src/namespaces/search.test.ts:720` — "// The default namespace at the flat root targets the BASE collection (not a"
- `packages/remnic-core/src/namespaces/search.test.ts:721` — "// tokenized name) on both index and search sides, and that collection is now"
- `packages/remnic-core/src/namespaces/search.test.ts:722` — "// auto-created so recall has something to read. Skipping creation left a"
- `packages/remnic-core/src/namespaces/search.test.ts:723` — "// configured default namespace with maintenance "ran" but 0 results (#1929)."
- `packages/remnic-core/src/namespaces/search.test.ts:739` — "// A missing base collection is no longer left missing (the old fail-open path);"
- `packages/remnic-core/src/namespaces/search.test.ts:740` — "// it is created so a fresh install with a flat-root default namespace gets a"
- `packages/remnic-core/src/namespaces/search.test.ts:741` — "// working QMD collection instead of silently returning 0 results."
- `packages/remnic-core/src/namespaces/search.test.ts:747` — "// Reporter's config: defaultNamespace "geek", data at the flat root. The"
- `packages/remnic-core/src/namespaces/search.test.ts:748` — "// default record must search the SAME base collection the index side creates,"
- `packages/remnic-core/src/namespaces/search.test.ts:749` — "// so recall returns results instead of 0."
- `packages/remnic-core/src/namespaces/search.test.ts:783` — "// The broad-root base collection also indexes nested `namespaces/` files; the"
- `packages/remnic-core/src/namespaces/search.test.ts:784` — "// default namespace search must strip them so auto-creation does not leak"
- `packages/remnic-core/src/namespaces/search.test.ts:785` — "// cross-namespace data into the default recall path."
- `packages/remnic-core/src/namespaces/search.test.ts:1492` — "// Plain relative hit is left untouched when its leading segment is a memory"
- `packages/remnic-core/src/namespaces/search.test.ts:1493` — "// category dir that happens to equal the collection name (qmdCollection =="
- `packages/remnic-core/src/namespaces/search.test.ts:1494` — "// "facts"): stripping would corrupt "facts/a.md" -> "a.md" and break reads."
- `packages/remnic-core/src/namespaces/search.test.ts:1500` — "/** Orama, LanceDB, Meilisearch and remote backends have no updateStrict or"
- `packages/remnic-core/src/namespaces/search.test.ts:1510` — "// Instance properties shadow the QMD-only strict methods FakeBackend defines."
- `packages/remnic-core/src/namespaces/search.ts:18` — "// Short TTL so repeated health polls skip a full QMD re-probe (~1.5s)."
- `packages/remnic-core/src/namespaces/search.ts:21` — "// Each cross-namespace search leg gets this budget; a stalled backend leg"
- `packages/remnic-core/src/namespaces/search.ts:22` — "// degrades its own namespace instead of holding the whole search (#3139)."
- `packages/remnic-core/src/namespaces/search.ts:166` — "// A per-namespace backend that is unavailable (or missing its"
- `packages/remnic-core/src/namespaces/search.ts:167` — "// collection) must report like any other QMD skip (#1536): its"
- `packages/remnic-core/src/namespaces/search.ts:168` — "// empty contribution is otherwise indistinguishable from a true"
- `packages/remnic-core/src/namespaces/search.ts:169` — "// no-matches for that namespace (codex round-5 review on #1544)."
- `packages/remnic-core/src/namespaces/search.ts:185` — "// One stalled backend leg must not hold the whole cross-namespace"
- `packages/remnic-core/src/namespaces/search.ts:186` — "// search (#3139). The backend gets the deadline signal so it cancels"
- `packages/remnic-core/src/namespaces/search.ts:187` — "// its own work, and the await is raced against the same budget. A leg"
- `packages/remnic-core/src/namespaces/search.ts:188` — "// that outlives its budget degrades only its own namespace; real"
- `packages/remnic-core/src/namespaces/search.ts:189` — "// backend errors and caller aborts propagate as before."
- `packages/remnic-core/src/namespaces/search.ts:250` — "// Resolve to an absolute path so the (namespace, path) identity is"
- `packages/remnic-core/src/namespaces/search.ts:251` — "// globally unique — same-relative-path hits from different namespaces"
- `packages/remnic-core/src/namespaces/search.ts:252` — "// stay distinct across every downstream consumer with no special"
- `packages/remnic-core/src/namespaces/search.ts:253` — "// handling. Display/citation surfaces relativize for portability (#2020)."
- `packages/remnic-core/src/namespaces/search.ts:394` — "// Cache only a healthy answer that carries backlog data when the backend"
- `packages/remnic-core/src/namespaces/search.ts:395` — "// reports status. A degraded or incomplete answer must re-probe so a"
- `packages/remnic-core/src/namespaces/search.ts:396` — "// readiness poll sees recovery on the next call, not one TTL late."
- `packages/remnic-core/src/namespaces/search.ts:552` — "// The legacy default namespace at the flat root (`filtersNestedNamespaces`)"
- `packages/remnic-core/src/namespaces/search.ts:553` — "// shares its `memoryDir` with the `namespaces/` container, so its base"
- `packages/remnic-core/src/namespaces/search.ts:554` — "// collection is a "broad root" that also indexes nested-namespace files."
- `packages/remnic-core/src/namespaces/search.ts:555` — "// We STILL auto-create it (issue #1929): the search side already targets"
- `packages/remnic-core/src/namespaces/search.ts:556` — "// this exact base collection and `filterNamespaceSubtreeResults` strips"
- `packages/remnic-core/src/namespaces/search.ts:557` — "// the nested `namespaces/` subtree out of its results, so index and"
- `packages/remnic-core/src/namespaces/search.ts:558` — "// search stay symmetric. Skipping creation left a configured default"
- `packages/remnic-core/src/namespaces/search.ts:559` — "// namespace (e.g. `geek`) with maintenance "ran" but no collection and 0"
- `packages/remnic-core/src/namespaces/search.ts:560` — "// recall results. `ensureCollection` is a no-op when the collection is"
- `packages/remnic-core/src/namespaces/search.ts:561` — "// already present, so legacy installs that pre-created the broad root are"
- `packages/remnic-core/src/namespaces/search.ts:626` — "// The operation was started with this same aborted signal and will reject"
- `packages/remnic-core/src/namespaces/search.ts:627` — "// on its own. Without a handler that second rejection is unhandled and"
- `packages/remnic-core/src/namespaces/search.ts:628` — "// ends the process."
- `packages/remnic-core/src/namespaces/search.ts:674` — "// Forced refreshes must skip the throttled all-collections update: its"
- `packages/remnic-core/src/namespaces/search.ts:675` — "// success has to prove the current writes are indexed, which a throttle"
- `packages/remnic-core/src/namespaces/search.ts:676` — "// skip cannot."
- `packages/remnic-core/src/namespaces/search.ts:688` — "// Backends with no strict variant (Orama, LanceDB, Meilisearch, remote) have a fail-open"
- `packages/remnic-core/src/namespaces/search.ts:689` — "// update(): it resolves when it returned early or failed. Their updateCompleted() says"
- `packages/remnic-core/src/namespaces/search.ts:690` — "// whether the refresh ran, so strict callers get a failure instead of a fake success."
- `packages/remnic-core/src/namespaces/search.ts:794` — "// Only strip a genuine QMD collection prefix — never when the collection name"
- `packages/remnic-core/src/namespaces/search.ts:795` — "// collides with a memory category dir (e.g. qmdCollection == "facts"), or a"
- `packages/remnic-core/src/namespaces/search.ts:796` — "// bare "facts/<id>.md" hit would be corrupted to "<id>.md" and fail namespace"
- `packages/remnic-core/src/namespaces/search.ts:797` — "// reads/access tracking (#2020)."
