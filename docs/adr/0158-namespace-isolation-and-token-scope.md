# Namespace authorization follows the authenticated principal and enforced allow-lists on every read and mutation

Status: accepted

## Context
Namespace-enabled deployments serve multiple principals from one store. Identity derived by parsing session keys collapsed unknowns to a default principal, producing false denials or wrong-scope serving even when a surface pre-check had passed. Record-targeted tools received no namespace parameter, so the request-level gate never ran for them. Search fanout silently excluded the namespace holding the bulk corpus (every query returned zero) or could include namespaces the caller cannot read. Zero-budget and invalid-input variants could turn an access error into a successful empty page, and a missing preferred-namespace file could fall through to another namespace's same-named file.

## Decision
- Identity is the authenticated principal, threaded through the dedicated override channel — the SAME principal the surface pre-check authorized — never re-derived from the sessionKey, whose resolver only maps configured raw keys and otherwise collapses to default.
- When namespaces are enabled, a request with no identity is rejected rather than scanned against the global namespace (least-privileged default).
- Token namespace allow-lists are enforced even when the target namespace comes from a stored record instead of a request parameter (review resolution selects by pair id): load the record, resolve its namespace, enforce via the SAME effective-namespace chokepoint the HTTP route uses (undefined maps to default so a scoped token whose allow-list includes default can resolve a legacy pair), and fail closed BEFORE dispatching the mutation. A missing record falls through to the normal not-found result; unrestricted/legacy tokens are unaffected.
- Sessionless memory search ADDS the default namespace to the fanout — the bulk corpus lives there — only when the principal can read it; it never replaces the profile-derived stack, and for explicit-namespace queries the fallback (and its storage probe) does not run at all, and never before authorization rejects an unauthorized principal.
- A zero limit is a runtime compatibility guarantee: an empty result with no backend call, never silently raised to a default — and never a way to skip the namespace gate, the mode validation (a zero cap must not smuggle an unknown ranking mode past the check), or authorization. Changing only the requested result count can never make an invalid request succeed; a negative/fractional/non-finite budget is rejected rather than short-circuited into a successful empty page.
- Recall file reads: when a preferred namespace was supplied and its file is missing or stale, a relative path does NOT fall through to the default store — the preferred store was the only correct lead (absolute paths self-identify above). Fanout degradation is observable via the threaded degradation observer.
- X-ray: disclosure is validated before the recall executes, before the queue mutex, and before namespace resolution (re-validation inside the queue would be dead code); capture runs through the orchestrator-owned critical section and the returned clone belongs to the caller; after capture, a STRICT namespace re-check drops any snapshot served from a different — or undefined — namespace rather than leaking cross-tenant data.

## Consequences
Least privilege by default; no global-scan or cross-store fallthrough conveniences; one extra load-and-check step on record-targeted mutations; tests may assert fanout shapes by field subset since degradation plumbing adds fields.

## Origin comments
- `packages/remnic-core/src/access-operations-batch.ts:432` — "// Per-token namespace enforcement (issue #1850 round 9): review_resolve"
- `packages/remnic-core/src/access-operations-batch.ts:433` — "// selects its target BY pairId, so the affected namespace comes from the"
- `packages/remnic-core/src/access-operations-batch.ts:434` — "// record — NOT a request param that the MCP-over-HTTP tools/call gate"
- `packages/remnic-core/src/access-operations-batch.ts:435` — "// (toolAcceptsNamespace) already enforces (this tool's schema carries no"
- `packages/remnic-core/src/access-operations-batch.ts:436` — "// `namespace` property). A namespace-scoped bearer must not mutate a"
- `packages/remnic-core/src/access-operations-batch.ts:437` — "// contradiction pair in a namespace outside its allow-list. Load the pair"
- `packages/remnic-core/src/access-operations-batch.ts:438` — "// to learn its namespace, enforce the token's scope via the SAME"
- `packages/remnic-core/src/access-operations-batch.ts:439` — "// effective-namespace chokepoint the HTTP review/resolve route uses"
- `packages/remnic-core/src/access-operations-batch.ts:440` — "// (enforceNamespaceAllowList maps undefined → default, so a scoped token"
- `packages/remnic-core/src/access-operations-batch.ts:441` — "// whose allow-list INCLUDES the default can resolve a legacy pair), and"
- `packages/remnic-core/src/access-operations-batch.ts:442` — "// fail closed BEFORE dispatching the (mutating) resolution. A missing pair"
- `packages/remnic-core/src/access-operations-batch.ts:443` — "// falls through to executeResolution's existing not-found result. No-op for"
- `packages/remnic-core/src/access-operations-batch.ts:444` — "// unrestricted/legacy tokens. Mirrors access-http.ts review/resolve exactly."
- `packages/remnic-core/src/access-recall-surface.ts:479` — "A preferred namespace was supplied but its file is missing/stale. For a relative path the preferred store was the only c"
- `packages/remnic-core/src/access-recall-surface.ts:480` — "relative path the preferred store was the only correct lead, so do not"
- `packages/remnic-core/src/access-recall-surface.ts:481` — "fall through to the default store and surface a same-relative-path file"
- `packages/remnic-core/src/access-recall-surface.ts:482` — "from the wrong namespace (#2020). Absolute paths self-identify above."
- `packages/remnic-core/src/access-recall-surface.ts:1029` — "Namespaces enabled but no identity supplied - reject rather"
- `packages/remnic-core/src/access-recall-surface.ts:1030` — "than scanning the global namespace (CLAUDE.md rule 48:"
- `packages/remnic-core/src/access-recall-surface.ts:1031` — "least-privileged default)."
- `packages/remnic-core/src/access-recall-surface.ts:1085` — "When the caller supplies an authenticated principal, forward"
- `packages/remnic-core/src/access-recall-surface.ts:1086` — "it via the dedicated override channel so orchestrator-side"
- `packages/remnic-core/src/access-recall-surface.ts:1087` — "ACL decisions use the SAME principal the access-surface"
- `packages/remnic-core/src/access-recall-surface.ts:1088` — "pre-check above authorized. Threading an"
- `packages/remnic-core/src/access-recall-surface.ts:1089` — "authenticatedPrincipal through sessionKey would be wrong:"
- `packages/remnic-core/src/access-recall-surface.ts:1090` — "resolvePrincipal(sessionKey) only maps configured raw"
- `packages/remnic-core/src/access-recall-surface.ts:1091` — "session keys and otherwise collapses to default, which"
- `packages/remnic-core/src/access-recall-surface.ts:1092` — "in namespace-enabled deployments produces false denials /"
- `packages/remnic-core/src/access-recall-surface.ts:1093` — "wrong-scope serving despite the pre-check passing"
- `packages/remnic-core/src/access-recall-surface.ts:1094` — "(CLAUDE.md rule 42)."
- `packages/remnic-core/src/access-recall-surface.ts:1110` — "Re-check namespace after capture: the recall may have served"
- `packages/remnic-core/src/access-recall-surface.ts:1111` — "from a different namespace than the caller requested. Drop"
- `packages/remnic-core/src/access-recall-surface.ts:1112` — "the snapshot rather than leak cross-tenant data (CLAUDE.md"
- `packages/remnic-core/src/access-recall-surface.ts:1113` — "rules 42 + 47). The comparison is strict so a snapshot whose"
- `packages/remnic-core/src/access-recall-surface.ts:1114` — "namespace is undefined cannot bypass the scope the caller"
- `packages/remnic-core/src/access-recall-surface.ts:1115` — "asked for."
- `packages/remnic-core/src/access-service-namespace.test.ts:106` — "// memory_search now threads an `execution.onDegradation` observer into"
- `packages/remnic-core/src/access-service-namespace.test.ts:107` — "// searchAcrossNamespaces (issue #2018 observability). Tests that assert the"
- `packages/remnic-core/src/access-service-namespace.test.ts:108` — "// fanout shape compare only the fields they care about, not the whole object."
- `packages/remnic-core/src/access-service-namespace.test.ts:1656` — "// ─── Issue #2018: memory_search must reach the base collection ───────────────"
- `packages/remnic-core/src/access-service-namespace.test.ts:1659` — "// bulk corpus lives under the DEFAULT namespace's base QMD collection. recall"
- `packages/remnic-core/src/access-service-namespace.test.ts:1660` — "// reaches it via the coding-overlay fallbacks, but memory_search has no"
- `packages/remnic-core/src/access-service-namespace.test.ts:1661` — "// sessionKey (so no coding context). With scope profiles active and a"
- `packages/remnic-core/src/access-service-namespace.test.ts:1662` — "// non-default principal, the profile read set collapsed to the derived"
- `packages/remnic-core/src/access-service-namespace.test.ts:1663` — "// principal-self + shared namespaces and EXCLUDED the default namespace —"
- `packages/remnic-core/src/access-service-namespace.test.ts:1664` — "// every query silently returned 0."
- `packages/remnic-core/src/access-service-namespace.test.ts:1736` — "// Before the fix the fanout resolved to [\"operator-x\", \"shared\"] and the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1737` — "// base collection (default namespace) was never queried — every search"
- `packages/remnic-core/src/access-service-namespace.test.ts:1738` — "// returned 0 on a flat-root deployment."
- `packages/remnic-core/src/access-service-namespace.test.ts:1750` — "// The derived self namespace (\"operator-x\") and shared must still be present;"
- `packages/remnic-core/src/access-service-namespace.test.ts:1751` — "// the fix ADDS the default, it does not replace the profile stack."
- `packages/remnic-core/src/access-service-namespace.test.ts:1758` — "// If the principal cannot read the default namespace, the fallback must NOT"
- `packages/remnic-core/src/access-service-namespace.test.ts:1759` — "// add it. Configure a protected default via a namespace policy that excludes"
- `packages/remnic-core/src/access-service-namespace.test.ts:1760` — "// the principal, and confirm \"default\" is absent while the policy name is"
- `packages/remnic-core/src/access-service-namespace.test.ts:1761` — "// still reachable through the profile stack only when readable."
- `packages/remnic-core/src/access-service-namespace.test.ts:1778` — "// defaultRecallNamespaces: [] + no scope profile + no policies ⇒ the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1779` — "// readable recall set is empty, exercising the silent-empty branch."
- `packages/remnic-core/src/access-service-namespace.test.ts:1828` — "// Explicit-namespace queries ignore the default-namespace fallback, so the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1829` — "// flat-root storage probe must not run (and must not run before the auth"
- `packages/remnic-core/src/access-service-namespace.test.ts:1830` — "// check rejects an unauthorized principal)."
- `packages/remnic-core/src/access-service-namespace.test.ts:1843` — "// A zero budget is a valid empty search, never a way to skip the namespace"
- `packages/remnic-core/src/access-service-namespace.test.ts:1844` — "// gate: returning [] for an unreadable namespace would turn an access error"
- `packages/remnic-core/src/access-service-namespace.test.ts:1845` — "// into a successful result."
- `packages/remnic-core/src/access-service-namespace.test.ts:1868` — "// Changing only the requested result count must never make an invalid"
- `packages/remnic-core/src/access-service-namespace.test.ts:1869` — "// request succeed."
- `packages/remnic-core/src/access-service-namespace.test.ts:1890` — "// A zero limit is a runtime compatibility guarantee (AGENTS.md guardrail 4):"
- `packages/remnic-core/src/access-service-namespace.test.ts:1891` — "// it means the same thing as an explicit `maxResults: 0` - an empty result"
- `packages/remnic-core/src/access-service-namespace.test.ts:1892` — "// with no backend call - and must never be silently raised to a default."
- `packages/remnic-core/src/access-service-namespace.test.ts:1907` — "// The scope is still authorized first, so a zero cap cannot bypass the gate."
- `packages/remnic-core/src/access-service-namespace.test.ts:1915` — "// Both namespace backends route an unknown mode through their default"
- `packages/remnic-core/src/access-service-namespace.test.ts:1916` — "// ordinary-search branch, so a typo from an untyped in-process caller would"
- `packages/remnic-core/src/access-service-namespace.test.ts:1917` — "// succeed with different ranking instead of reporting bad input."
- `packages/remnic-core/src/access-service-namespace.test.ts:1938` — "// A zero budget must not be a way to slip an invalid mode past the check."
- `packages/remnic-core/src/access-service-namespace.test.ts:1952` — "// Every accepted mode still reaches the backend (AGENTS.md §40)."
- `packages/remnic-core/src/access-service-namespace.test.ts:1961` — "// A negative would hit the `budget <= 0` short-circuit and answer with a"
- `packages/remnic-core/src/access-service-namespace.test.ts:1962` — "// successful EMPTY page; a fraction or non-finite value would flow into the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1963` — "// backend limit and top-up arithmetic."
- `packages/remnic-core/src/access-service-namespace.test.ts:1980` — "// Zero keeps its documented meaning: an empty result, no backend call."
