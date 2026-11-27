# All namespace identity comparisons use the normalized (trimmed) form

Status: accepted

Catalog records key namespaces by their normalized identity
(`normalizeNamespaceIdentity`, a trim), but several checks compared against
RAW config strings. A configured default name with surrounding whitespace
(`"default "`) then gets misclassified, dropped at read, given the wrong
storage root, or seeded at a spaced-name path live traffic never touches.

## Decision

Every comparison against a configured or configured-default namespace —
default exemptions, memoryDir-ownership checks, rebuild seeding, config
classification, default-root resolution — uses the NORMALIZED (trimmed)
identity, matching `storageFor()` and `isSafeRouteNamespace`, which both trim
before resolving/validating. Rebuild normalizes configured names FIRST, so it
seeds exactly the identity and router-resolved root the live router uses. A
raw scan-root dir name whose spelling trims to another namespace is not a
routeable live root and must not be catalogued from disk.

## Consequences

Whitespace-padded config values behave identically to their clean spelling.
Raw spaced names never appear as catalog rows or storage roots. Nothing else
changes for correctly spelled names.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog.test.ts:1530` — "// NH-FH (cursor Medium): when the configured default name carries surrounding"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1531` — "// whitespace, catalog records key it by its NORMALIZED (trimmed) identity, but"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1532` — "// default-namespace exemptions and memoryDir-ownership checks must compare against"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1533` — "// the SAME normalized form — otherwise the default row is misclassified, dropped"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1534` — "// at read, or given the wrong storage root."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1559` — "// NIabe (codex P2): when `defaultNamespace` carries surrounding whitespace,"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1560` — "// `resolveDefaultNamespaceRoot` must build the LEGACY default root from the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1561` — "// NORMALIZED name so it still finds a live `namespaces/default` root. Building it"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1562` — "// from the raw spaced name would look for `namespaces/<spaced>`, miss the real"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1563` — "// root, and fall back to memoryDir/tokenized — pointing reads/writes/rebuild at"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1564` — "// an empty root even though the router classifies the trimmed value as default."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2214` — "// ── NGnek (codex P2): a configured namespace with harmless surrounding whitespace"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2215` — "// (e.g. `sharedNamespace: "shared "`) must be NORMALIZED before seeding, so the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2216` — "// catalog records the same identity + router-resolved root the live router uses."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2217` — "// Pre-fix, rebuild seeded a row for the RAW `"shared "` resolving to a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2218` — "// `namespaces/shared ` root that live reads/writes never touch — pointing"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2219` — "// maintenance/QMD at the wrong directory."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2396` — "// ── Round 7 (codex P2 — NBsFz): a token-SHAPED raw namespace name must be"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2397` — "// preserved by a catalog write touch, not decoded into a different identity. We"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2398` — "// drive the orchestrator-side derivation indirectly: a markWrite with an explicit"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2399` — "// storageDir under a legacy raw-name dir whose name merely looks like a token"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2400` — "// keeps the literal name. (Covered end-to-end via the orchestrator; here we"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2401` — "// assert the catalog preserves whatever namespace it is given verbatim.)"
- `packages/remnic-core/src/namespaces/catalog.ts:413` — "// Compare against NORMALIZED config names (NGnek, codex P2): the catalog seeds"
- `packages/remnic-core/src/namespaces/catalog.ts:414` — "// normalized namespace identities, so a configured name with surrounding"
- `packages/remnic-core/src/namespaces/catalog.ts:415` — "// whitespace (e.g. `sharedNamespace: "shared "`) must still classify the"
- `packages/remnic-core/src/namespaces/catalog.ts:416` — "// normalized `"shared"` as `shared`, not fall through to `explicit`."
- `packages/remnic-core/src/namespaces/catalog.ts:500` — "// Normalized (trimmed) default namespace identity (NH-FH, cursor Medium)."
- `packages/remnic-core/src/namespaces/catalog.ts:501` — "// Catalog records key namespaces by their NORMALIZED identity"
- `packages/remnic-core/src/namespaces/catalog.ts:502` — "// (`normalizeNamespaceIdentity`), but several default-namespace exemptions and"
- `packages/remnic-core/src/namespaces/catalog.ts:503` — "// memoryDir-ownership checks compared against the RAW `config.defaultNamespace`."
- `packages/remnic-core/src/namespaces/catalog.ts:504` — "// If the configured default name carries surrounding whitespace the record key"
- `packages/remnic-core/src/namespaces/catalog.ts:505` — "// is trimmed while the comparison string is not, so the default row is"
- `packages/remnic-core/src/namespaces/catalog.ts:506` — "// misclassified, dropped at read time, or given the wrong storage root. Compare"
- `packages/remnic-core/src/namespaces/catalog.ts:507` — "// against this normalized form everywhere instead."
- `packages/remnic-core/src/namespaces/catalog.ts:1540` — "// NORMALIZE FIRST (NGnek, codex P2): the live router normalizes every namespace"
- `packages/remnic-core/src/namespaces/catalog.ts:1541` — "// via `normalizeNamespaceIdentity` (a trim) in `storageFor()` before resolving"
- `packages/remnic-core/src/namespaces/catalog.ts:1542` — "// storage, and `isSafeRouteNamespace` also trims before validating. So a"
- `packages/remnic-core/src/namespaces/catalog.ts:1543` — "// configured name with harmless surrounding whitespace (e.g."
- `packages/remnic-core/src/namespaces/catalog.ts:1544` — "// `sharedNamespace: "shared "` or a policy name copied with a trailing space)"
- `packages/remnic-core/src/namespaces/catalog.ts:1545` — "// would otherwise seed a catalog row for the RAW string and resolve a"
- `packages/remnic-core/src/namespaces/catalog.ts:1546` — "// `namespaces/shared ` root the live reads/writes never use — pointing"
- `packages/remnic-core/src/namespaces/catalog.ts:1547` — "// maintenance/QMD at the wrong directory after `rebuild --apply`. We normalize"
- `packages/remnic-core/src/namespaces/catalog.ts:1548` — "// configured names here so the catalog seeds the SAME identity the router uses"
- `packages/remnic-core/src/namespaces/catalog.ts:1549` — "// (rule #42: read/write resolve through the same normalization). The default"
- `packages/remnic-core/src/namespaces/catalog.ts:1550` — "// namespace is normalized too and compared via its normalized form (`defaultNs`)"
- `packages/remnic-core/src/namespaces/catalog.ts:1551` — "// wherever a configured/scanned name is matched against it below."
- `packages/remnic-core/src/namespaces/catalog.ts:1764` — "// Match `storageFor()`'s canonical namespace identity. A raw root whose"
- `packages/remnic-core/src/namespaces/catalog.ts:1765` — "// spelling trims to another namespace (for example `namespaces/shared `)"
- `packages/remnic-core/src/namespaces/catalog.ts:1766` — "// is not a routeable live root and must not be catalogued from disk."
