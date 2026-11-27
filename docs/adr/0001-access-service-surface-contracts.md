# Access-service surfaces delegate through chokepoints and keep their contracts uniform

Status: accepted

## Context
The access service accumulated per-surface divergence: config flags read outside capabilities.ts; namespace resolution and catalog writes duplicated inline; peer SecretRef tokens and peer deletion had ad hoc handling; the admin console re-derived scope; wearables/meetings ops needed identical behavior behind CLI/HTTP/MCP; observe retries needed idempotency that cannot silently cross identities; and the extraction census could be seeded by a restricted caller's filtered view or report a different array than the response shipped.

## Decision
- Namespace/principal resolution and catalog writes live at their chokepoints (scope-module resolver, storage chokepoint); call sites delegate instead of re-resolving. Config flags are read only in capabilities.ts through the shared capability projection.
- Wearables/meetings ops delegate to the orchestrator-owned service instance (renderer-sharing rule): CLI, HTTP, and MCP callers observe identical behavior and validation. Admin surfaces delegate to the pure admin-surfaces functions so the dashboard never re-resolves scope, re-derives promotion targets, or re-lists namespaces; the wearables/meetings ops receive a structural host bound per call.
- Peer SecretRef tokens resolve at poll time through the host resolver (same indirection as agent auth tokens); without a resolver, string ${ENV} tokens still work and a SecretRef degrades to a per-peer `unreachable`, never a throw. Configs built without parseConfig may omit the block; the parsed default (enabled) is the contract. Peer deletion routes through peers.deletePeer so the escape/symlink/inode guards shared with read/write apply; a manual path.join + unlink is forbidden.
- Observe idempotency: a retried POST with the same idempotencyKey replays the cached response with no side effects; divergent payload or principal is a conflict (the fingerprint folds in the authenticated principal and the EFFECTIVE coding context, computed read-only the same way the scope plan derives it, skipped for namespace-pinned or non-keyed observes). Write quota runs inside the lock on a real miss only, so a response-lost retry never 429s. Fingerprints use the canonical (alias-mapped) category and a shared builder with asserted byte parity.
- The extraction census comes from ONE call — the corpus array and its flag never come from two independently cached scans; the flag describes THIS response's array; the instance-wide cached poll is capability-independent and never seeded by a restricted caller's filtered census.
- Whitespace-only rootPath is rejected like whitespace-only projectId; the hourly summarizer never reports success on empty work (stats interpretation lives with the stats).

## Consequences
Surfaces stay thin, which forces shared chokepoint APIs to expose everything a surface needs; a new flag or resolution rule has exactly one home. Idempotency folds make fingerprint computation slightly wider but replay-safe.

## Origin comments

Merged here: smaller surface-specific rules (peer SecretRef, wearables sharing, rootPath, hourly summarizer, census consistency) were folded into the nearest neighbour, the surface-contract chokepoint decision.

- `packages/remnic-core/src/access-service.ts:1383` — "// Peer SecretRef tokens resolve at poll time through the host resolver, the"
- `packages/remnic-core/src/access-service.ts:1384` — "// same indirection as agentAccessHttp.authToken (review round 1). Absent a"
- `packages/remnic-core/src/access-service.ts:1385` — "// resolver, string/${ENV} tokens still work and a SecretRef degrades to a"
- `packages/remnic-core/src/access-service.ts:1386` — "// per-peer `unreachable` (never a throw)."
- `packages/remnic-core/src/access-service.ts:1390` — "// Configs built without parseConfig (test stubs, older host shapes) may"
- `packages/remnic-core/src/access-service.ts:1391` — "// omit the block; the parsed default (enabled: true) is the contract."
- `packages/remnic-core/src/access-service.ts:1478` — "// #1521: delegates to the scope-module resolver. The inline"
- `packages/remnic-core/src/access-service.ts:1479` — "// namespace/principal resolution + writability check is retired so the"
- `packages/remnic-core/src/access-service.ts:1480` — "// adHocNamespaceResolutions ratchet no longer counts this site."
- `packages/remnic-core/src/access-service.ts:2368` — "// ONE call: the corpus array and the flag describing it must not come from"
- `packages/remnic-core/src/access-service.ts:2369` — "// two independently-cached scans (round 8, codex P1)."
- `packages/remnic-core/src/access-service.ts:2394` — "// #3444: process-local buffer add-path counters, TOP LEVEL (not inside `extraction`)."
- `packages/remnic-core/src/access-service.ts:2406` — "// Describes THIS response's array (round 8): a separate scan could report"
- `packages/remnic-core/src/access-service.ts:2407` — "// complete while the shipped corpus was partial, and peers trust it."
- `packages/remnic-core/src/access-service.ts:2411` — "// Capability-INDEPENDENT: this poll is cached instance-wide, so a"
- `packages/remnic-core/src/access-service.ts:2412` — "// restricted caller's filtered census must never seed it (round 9)."
- `packages/remnic-core/src/access-service.ts:2555` — "// Whitespace-only rootPath must be rejected just like whitespace-only"
- `packages/remnic-core/src/access-service.ts:2556` — "// projectId — otherwise a payload like `{ rootPath: \" \" }` slips past"
- `packages/remnic-core/src/access-service.ts:2557` — "// validation and produces a session whose rootPath is meaningless for"
- `packages/remnic-core/src/access-service.ts:2558` — "// `remnic doctor` output and for downstream namespace decisions."
- `packages/remnic-core/src/access-service.ts:2667` — "// Single-flight gate resolved through the shared access-setup capability"
- `packages/remnic-core/src/access-service.ts:2668` — "// projection so the config flag is read only in capabilities.ts (#1523)."
- `packages/remnic-core/src/access-service.ts:3001` — "// #2780/#2829: fingerprint the canonical category (schema transform already mapped aliases)."
- `packages/remnic-core/src/access-service.ts:3011` — "// Shared builder (issue #1989 PR3): byte-parity with the historical"
- `packages/remnic-core/src/access-service.ts:3012` — "// inline literal is asserted by access-fingerprint-parity.test.ts."
- `packages/remnic-core/src/access-service.ts:3133` — "// Project resolution chokepoint lives in codegraph-runtime.ts so every"
- `packages/remnic-core/src/access-service.ts:3134` — "// store-backed tool derives the same id and the tagged error flows back"
- `packages/remnic-core/src/access-service.ts:3135` — "// as a structured response (issue #1554 threads 7/9/11). Thin wiring."
- `packages/remnic-core/src/access-service.ts:3890` — "// Issue #2783: the summarizer must not report success on empty work."
- `packages/remnic-core/src/access-service.ts:3891` — "// Stats interpretation lives with the stats (summarizeHourlyStatus)."
- `packages/remnic-core/src/access-service.ts:4117` — "// Issue #1649: dedup retried observe POSTs server-side. A retry with the"
- `packages/remnic-core/src/access-service.ts:4118` — "// same `idempotencyKey` replays the cached response and skips every side"
- `packages/remnic-core/src/access-service.ts:4119` — "// effect (LCM/extraction/objective-state); divergent payload OR principal"
- `packages/remnic-core/src/access-service.ts:4120` — "// reuse is a conflict (fingerprint folds in authenticatedPrincipal, so a"
- `packages/remnic-core/src/access-service.ts:4121` — "// cross-identity replay can never be silent). `enforceWriteQuota` runs as"
- `packages/remnic-core/src/access-service.ts:4122` — "// `beforeExecute` inside the lock — only on a real miss — so a response-lost"
- `packages/remnic-core/src/access-service.ts:4123` — "// retry never 429s even when the first attempt filled the window (#1434)."
- `packages/remnic-core/src/access-service.ts:4125` — "// The fingerprint folds in the EFFECTIVE coding context (#1649 codex P2):"
- `packages/remnic-core/src/access-service.ts:4126` — "// runObserve's scope can be derived from the session's ATTACHED coding"
- `packages/remnic-core/src/access-service.ts:4127` — "// context (which takes PRECEDENCE over per-call cwd/projectTag per"
- `packages/remnic-core/src/access-service.ts:4128` — "// resolveMemoryScopePlan), so neither cwd/projectTag NOR the raw ambient"
- `packages/remnic-core/src/access-service.ts:4129` — "// context alone fully captures the effective scope. The effective context"
- `packages/remnic-core/src/access-service.ts:4130` — "// is computed the SAME way resolveMemoryScopePlan does — session-attached"
- `packages/remnic-core/src/access-service.ts:4131` — "// first, per-call cwd/projectTag fallback — but READ-ONLY: it does NOT seed"
- `packages/remnic-core/src/access-service.ts:4132` — "// the session, so a conflict/quota-rejection path leaves no orphaned binding."
- `packages/remnic-core/src/access-service.ts:4133` — "// The value is stable across replays because resolveMemoryScopePlan's"
- `packages/remnic-core/src/access-service.ts:4134` — "// seeding writes the IDENTICAL context that resolveCodingContextFromOptions"
- `packages/remnic-core/src/access-service.ts:4135` — "// derives — so getCodingContextForSession returns the same object on the"
- `packages/remnic-core/src/access-service.ts:4136` — "// replay as resolveCodingContextFromOptions returned on the first call."
- `packages/remnic-core/src/access-service.ts:4137` — "// Only computed when a key is present; non-keyed observes skip the work."
- `packages/remnic-core/src/access-service.ts:4141` — "// Explicit namespace pins the scope (resolveMemoryScopePlan returns early),"
- `packages/remnic-core/src/access-service.ts:4142` — "// so the coding context is irrelevant — skip it to avoid false conflicts"
- `packages/remnic-core/src/access-service.ts:4143` — "// when the session context changes under a namespace-pinned observe."
- `packages/remnic-core/src/access-service.ts:4144` — "// Reuse the write resolver's namespace/projectScope gates so context"
- `packages/remnic-core/src/access-service.ts:4145` — "// ignored by runObserve cannot change the retry fingerprint."
- `packages/remnic-core/src/access-service.ts:5114` — "// Pass a thin proxy that overrides config.memoryDir with the namespace-"
- `packages/remnic-core/src/access-service.ts:5115` — "// scoped storage dir while delegating everything else to the real"
- `packages/remnic-core/src/access-service.ts:5116` — "// orchestrator (buffer, qmd, extraction queue, etc. are process-global"
- `packages/remnic-core/src/access-service.ts:5117` — "// and don't require further namespace scoping for a read-only snapshot)."
- `packages/remnic-core/src/access-service.ts:5236` — "// Cursor M (PR #756 review): route through `peers.deletePeer` so"
- `packages/remnic-core/src/access-service.ts:5237` — "// the unlink runs `assertPeerDirNotEscaped`, the peers-root"
- `packages/remnic-core/src/access-service.ts:5238` — "// symlink check, and the parent-inode-stable / O_NOFOLLOW guards"
- `packages/remnic-core/src/access-service.ts:5239` — "// shared with `readPeer`/`writePeer`. A manual `path.join` +"
- `packages/remnic-core/src/access-service.ts:5240` — "// raw `fs.unlink` would let a symlinked `peers/<id>/` redirect"
- `packages/remnic-core/src/access-service.ts:5241` — "// the delete to an arbitrary `identity.md` outside `memoryDir`."
- `packages/remnic-core/src/access-service.ts:5354` — "// #1522: recordCatalogWrite removed — catalog touch handled at the storage chokepoint."
- `packages/remnic-core/src/access-service.ts:5720` — "// Thin delegations to the orchestrator-owned WearablesService — the"
- `packages/remnic-core/src/access-service.ts:5721` — "// same instance behind the CLI, so HTTP/MCP callers observe identical"
- `packages/remnic-core/src/access-service.ts:5722` — "// behavior and validation (renderer-sharing rule)."
- `packages/remnic-core/src/access-service.ts:5725` — "/** * Structural host bound per call so the wearables + meetings ops (issue * #2123) delegate to the pure surface modu"
- `packages/remnic-core/src/access-service.ts:5782` — "// Thin delegators. Every method threads `this.orchestrator` references"
- `packages/remnic-core/src/access-service.ts:5783` — "// into the pure `admin/admin-surfaces.ts` functions so the dashboard"
- `packages/remnic-core/src/access-service.ts:5784` — "// never re-resolves scope, re-derives promotion targets, or re-lists"
- `packages/remnic-core/src/access-service.ts:5785` — "// namespaces."
- `packages/remnic-core/src/access-service.ts:5799` — "// Fetch the coding context when a session is supplied; the pure"
- `packages/remnic-core/src/access-service.ts:5800` — "// inspectScope helper (admin-surfaces.ts) owns the single namespace-flag"
- `packages/remnic-core/src/access-service.ts:5801` — "// read for this surface and threads it through resolveScopePlan."
- `packages/remnic-core/src/access-service.ts:5813` — "// Redact operator free-text inputs that may carry credentials. The plan"
- `packages/remnic-core/src/access-service.ts:5814` — "// itself is derived from config + storage layout, not user input, so its"
- `packages/remnic-core/src/access-service.ts:5815` — "// fields stay intact for diagnostics."
- `packages/remnic-core/src/access-service.ts:5854` — "// The report marks the namespace degraded and records the reason;"
- `packages/remnic-core/src/access-service.ts:5855` — "// a probe failure must not abort the whole report."
- `packages/remnic-core/src/access-trust-principal-header.test.ts:70` — "// The same expression the http-serve action builds when the CLI flag is absent."
