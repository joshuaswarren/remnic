# No cataloged namespace name or storage root may escape memoryDir — containment is enforced on write, on read, and in the scan

Status: accepted

Namespace names and storage dirs enter the catalog from untrusted sources:
config values, caller-supplied `metadata.storageDir`, and pre-fix or tampered
`namespaces.jsonl` rows. Lexical path containment alone is insufficient:
symlinked roots and symlinked ancestors escape memoryDir at filesystem level,
and a contained-but-foreign dir misdirects maintenance fanout at another
namespace's data.

## Decision

- A persisted or surfaced `storageDir` must be contained in memoryDir by
  lexical path AND realpath, must be (or resolve under) a real directory,
  and must not pass through or sit beneath any symlinked ancestor. A
  not-yet-existing leaf is validated against its nearest existing ancestor's
  realpath and directory-ness. A candidate that exists as a regular file is
  rejected.
- An explicit caller-provided storageDir is accepted only when it is
  contained AND belongs to THIS namespace (its token dir, its legacy
  raw-name dir, or memoryDir for the default namespace only). Anything else
  falls back to the namespace's own router-resolved, containment-enforcing
  root — never memoryDir for a non-default namespace.
- The default (legacy `memoryDir`) root is trusted as-is; everything else
  goes through the containment contract.
- The read boundary applies the same defenses in reverse: a namespace name
  that is unsafe (e.g. `../evil`) is dropped entirely, not merely given a
  safe dir — an ownership helper can build a tokenized root for an
  unsafe name, so the dir check alone passes. Records are keyed/compared
  against the NORMALIZED default identity (names are trimmed), so a
  whitespace-padded config default is never misclassified. Duplicate alias
  rows pointing at one physical root are collapsed so maintenance/QMD see
  exactly one owner per root while preserving touch recency from every
  alias.
- Unsafe configured names (`sharedNamespace`, policy names) are SKIPPED at
  registration instead of throwing, so one bad name never aborts the batch;
  the default namespace is exempt from the route-safety gate but its
  storageDir still resolves through the contained helper.
- Config string opt-outs (`"false"`/`"0"` from CLI/env/JSON) must leave the
  catalog inert exactly like a boolean opt-out; the config parser's coerced
  boolean is honored end to end.

## Consequences

A caller cannot point a namespace's catalog entry at another namespace's
tree, memoryDir, or anything outside memoryDir, even via symlinks, and a
tampered log row cannot surface an unsafe namespace. Costs: containment
checks run on every touch/seed/read path, and a legitimately symlinked setup
inside memoryDir is rejected as if it escaped.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog-read-boundary.ts:50` — "// Defense 1: drop an unsafe non-default namespace name entirely. Compare"
- `packages/remnic-core/src/namespaces/catalog-read-boundary.ts:51` — "// against the NORMALIZED default identity — record keys are trimmed, so a raw"
- `packages/remnic-core/src/namespaces/catalog-read-boundary.ts:52` — "// whitespace-padded config default would never match the default row (NH-FH)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:818` — "// ── Issue 3 (cursor + codex): a string "false"/"0" opt-out from CLI/env/JSON"
- `packages/remnic-core/src/namespaces/catalog.test.ts:819` — "// must keep the catalog inert (no jsonl writes), matching the boolean opt-out."
- `packages/remnic-core/src/namespaces/catalog.test.ts:820` — "// parseConfig is what coerces these strings; assert the catalog honors the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:821` — "// resulting flag end to end by feeding it a config whose flag is the coerced"
- `packages/remnic-core/src/namespaces/catalog.test.ts:822` — "// boolean."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1086` — "// ── Round 4, Issue #4 (codex P2): an explicit metadata.storageDir from a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1087` — "// markWrite/registerResolved caller must be containment-checked before it is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1088` — "// persisted. An out-of-memoryDir path must NOT end up as the namespace's"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1089` — "// catalog storageDir; the catalog falls back to the trusted resolved dir."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1140` — "// ── Round 5, Issue #1 (cursor Medium): when both a legacy raw-name dir and a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1141` — "// tokenized dir hold data for the same namespace, rebuild must prefer the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1142` — "// TOKENIZED root (matching NamespaceStorageRouter), not let last-readdir-wins"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1143` — "// pick arbitrarily."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1227` — "// ── Round 5, Issue #2 (cursor Medium): reads must not surface an out-of-root"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1228` — "// storageDir. A tampered/pre-fix jsonl record with an absolute path outside"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1229` — "// memoryDir must be sanitized to the resolved safe root on enumeration."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1275` — "// ── NGZqr (codex P2): the READ sanitizer must REJECT an unsafe non-default"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1276` — "// namespace NAME, not only sanitize its storageDir. A pre-fix/tampered jsonl row"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1277` — "// with an unsafe namespace (e.g. `../evil`) was surfaced by listNamespaces/"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1278` — "// getNamespaceRecord because the sanitizer only fixed storageDir — and"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1279` — "// isStorageDirForNamespace can still build a tokenized root for such a name, so"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1280` — "// the storageDir check alone passes. The hot touch + rebuild scan paths reject"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1281` — "// these names with isSafeRouteNamespace; the read boundary must agree, or"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1282` — "// maintenance/QMD could enumerate a namespace those paths reject."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1334` — "// ── Round 5, Issue #3 (codex P2): an explicit storageDir that is lexically"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1335` — "// contained but is a SYMLINK escaping memoryDir must be rejected (the round-4"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1336` — "// containment check was lexical only)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1358` — "// The REALPATH of the persisted storage dir must stay inside memoryDir — a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1359` — "// lexical-only check (the round-4 behavior) would wrongly accept the symlink"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1360` — "// whose realpath escapes to `outside`."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1367` — "// The fallback resolved token dir may not exist on disk; use the lexical"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1368` — "// path, which is by construction inside memoryDir."
- `packages/remnic-core/src/namespaces/catalog.test.ts:1677` — "// ── Round 5, Issue A (cursor/codex Medium/P2): when a NON-default namespace's"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1678` — "// router-resolved root fails containment (the LEGACY raw-name dir the router"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1679` — "// would pick is a symlink escaping memoryDir) but the namespace's own TOKENIZED"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1680` — "// dir is clean, the touch fallback must record that clean token dir — NOT"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1681` — "// memoryDir, which is the DEFAULT namespace's tree. Recording memoryDir would"
- `packages/remnic-core/src/namespaces/catalog.test.ts:1682` — "// misdirect maintenance fanout at the default namespace's data."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2420` — "// ── Round 7 (codex P2 — NCzT4): the configured-namespace seeding step must NOT"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2421` — "// persist an escaping `storageDir` for a configured non-default namespace whose"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2422` — "// token dir is a symlink pointing OUTSIDE memoryDir. It must reject it (skipped:"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2423` — "// escape) just like the scan loop does, BEFORE the record is seeded/rewritten."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2503` — "// ── Round 7 (codex P2 — NDATT): an explicit storageDir that is contained but"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2504` — "// belongs to ANOTHER namespace's tree (or memoryDir for a non-default namespace)"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2505` — "// must be REJECTED — it must not be persisted as this namespace's root. The touch"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2506` — "// falls back to the namespace's own resolved root."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2546` — "// ── Round 7 (codex P2 — NDXHe): the READ sanitizer must also reject a contained"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2547` — "// but CROSS-NAMESPACE root (a pre-fix/tampered jsonl record for `project-a` whose"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2548` — "// storageDir is `project-b`'s token dir or memoryDir). listNamespaces /"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2549` — "// getNamespaceRecord must substitute the namespace's OWN resolved root, keeping"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2550` — "// read and write symmetric (rule 42)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2589` — "// ── Round 7 (codex P2 — NDo79): an explicit storageDir whose LEAF does not exist"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2590` — "// yet but whose existing parent (`namespaces/`) is a SYMLINK escaping memoryDir"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2591` — "// must be rejected. Lexical containment alone would accept it, then a later mkdir"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2592` — "// would follow the symlink outside the memory root. The touch must fall back to a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2593` — "// safe root instead of persisting the escaping path."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2610` — "// The caller's explicit dir resolves (via the symlinked `namespaces/` parent)"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2611` — "// OUTSIDE memoryDir, so it must be REJECTED — the catalog must not persist the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2612` — "// exact escaping path the caller supplied. Pre-fix, `isContainedStorageDir`"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2613` — "// accepted the non-existent leaf and recorded it verbatim."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2625` — "// ── NF21i (codex P2): an explicit storageDir that EXISTS as a regular FILE (not a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2626` — "// directory) must be REJECTED by the containment check. We place the file at the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2627` — "// namespace's OWN canonical token dir path (`namespaces/<token>`) so it passes the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2628` — "// namespace-ownership check (isStorageDirForNamespace) and the ONLY thing that can"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2629` — "// reject it is the directory check inside isContainedStorageDir. A file is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2630` — "// lexically contained and its realpath stays inside memoryDir, so pre-fix it was"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2631` — "// accepted and persisted as a broken root. Post-fix the file root is rejected and"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2632` — "// the touch falls back to a safe contained root (CLAUDE.md rule #24)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2659` — "// ── NHIdt (codex P2): a NOT-YET-EXISTING leaf whose nearest existing ANCESTOR is a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2660` — "// regular FILE must be rejected. `realpath(parent)` succeeds and resolves inside"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2661` — "// memoryDir for a file `<memoryDir>/namespaces`, so a containment-only ancestor"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2662` — "// check would ACCEPT a leaf that can never be created (no child dir under a file)."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2663` — "// We place a FILE at `namespaces` and pass an explicit non-existent leaf under it;"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2664` — "// the touch must not persist that escaping/uncreatable path."
- `packages/remnic-core/src/namespaces/catalog.test.ts:2962` — "// ── Round 7 (codex P2 — NEOFS): the DEFAULT namespace's seeded root must also be"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2963` — "// containment-checked. If `resolveDefaultNamespaceRoot()` returns a"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2964` — "// `namespaces/<default-token>` symlink escaping memoryDir (empty legacy default +"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2965` — "// symlinked tokenized dir with a marker), rebuild must NOT persist that escaping"
- `packages/remnic-core/src/namespaces/catalog.test.ts:2966` — "// path for the default record — it falls back to the trusted memoryDir root."
- `packages/remnic-core/src/namespaces/catalog.ts:245` — "// Reject symlinked markers outright (scan parity — never follow them)."
- `packages/remnic-core/src/namespaces/catalog.ts:253` — "// Category/data markers must be real directories whose realpath stays inside"
- `packages/remnic-core/src/namespaces/catalog.ts:254` — "// the namespace root (no escape via a symlinked ancestor)."
- `packages/remnic-core/src/namespaces/catalog.ts:584` — "// Drop unsafe-namespace rows (sanitizer returned null) at the read boundary."
- `packages/remnic-core/src/namespaces/catalog.ts:585` — "// Then collapse duplicate root aliases so maintenance/QMD see exactly one"
- `packages/remnic-core/src/namespaces/catalog.ts:586` — "// namespace owner for a physical storage root, matching rebuild ownership,"
- `packages/remnic-core/src/namespaces/catalog.ts:587` — "// while preserving touch recency from every alias row."
- `packages/remnic-core/src/namespaces/catalog.ts:788` — "// Skip unsafe configured names (e.g. a `sharedNamespace`/policy name like"
- `packages/remnic-core/src/namespaces/catalog.ts:789` — "// `../evil`) consistently with `rebuildFromDisk` (round 6, cursor Low —"
- `packages/remnic-core/src/namespaces/catalog.ts:790` — "// NBn3w). `register`→`validateNamespace` THROWS on unsafe tokens; without"
- `packages/remnic-core/src/namespaces/catalog.ts:791` — "// this guard one bad name would abort registration of all the rest. The"
- `packages/remnic-core/src/namespaces/catalog.ts:792` — "// default namespace is exempt (it may be a non-route literal). Each call is"
- `packages/remnic-core/src/namespaces/catalog.ts:793` — "// also wrapped so a single failure never blocks the remaining names."
- `packages/remnic-core/src/namespaces/catalog.ts:794` — "// `names` carries RAW config values, so normalize before the default-exempt"
- `packages/remnic-core/src/namespaces/catalog.ts:795` — "// check — a whitespace-padded default must still be recognized (NH-FH)."
- `packages/remnic-core/src/namespaces/catalog.ts:833` — "// The configured default namespace is exempt from isSafeRouteNamespace at"
- `packages/remnic-core/src/namespaces/catalog.ts:834` — "// the routing layer; honor the same exemption here, but everything still"
- `packages/remnic-core/src/namespaces/catalog.ts:835` — "// resolves through the contained storage-dir helper below."
- `packages/remnic-core/src/namespaces/catalog.ts:872` — "/** * Whether a candidate storage dir is LEXICALLY contained: it is either the * legacy default root (`memoryDir`) or"
- `packages/remnic-core/src/namespaces/catalog.ts:889` — "/** * Whether a candidate storage dir satisfies the catalog containment contract, * including SYMLINK-escape rejectio"
- `packages/remnic-core/src/namespaces/catalog.ts:901` — "// The default/legacy memoryDir root is trusted as-is."
- `packages/remnic-core/src/namespaces/catalog.ts:909` — "// Reject a candidate beneath any SYMLINKED ancestor (codex NVuq5): even when"
- `packages/remnic-core/src/namespaces/catalog.ts:910` — "// the symlink currently resolves back inside memoryDir, the disk scanner"
- `packages/remnic-core/src/namespaces/catalog.ts:911` — "// rejects such a root, and a later retarget of the link would let"
- `packages/remnic-core/src/namespaces/catalog.ts:912` — "// maintenance/QMD follow the persisted path outside memoryDir. Mirror the"
- `packages/remnic-core/src/namespaces/catalog.ts:913` — "// scanner so touch/config seeding cannot persist a root under a symlinked"
- `packages/remnic-core/src/namespaces/catalog.ts:914` — "// namespace ancestor (the leaf itself is symlink-checked below)."
- `packages/remnic-core/src/namespaces/catalog.ts:919` — "// Reject an EXISTING non-directory root (NF21i, codex P2; CLAUDE.md rule"
- `packages/remnic-core/src/namespaces/catalog.ts:920` — "// #24). A regular file (or socket/fifo) at `<memoryDir>/namespaces/<token>`"
- `packages/remnic-core/src/namespaces/catalog.ts:921` — "// is lexically contained and its realpath stays inside memoryDir, so the"
- `packages/remnic-core/src/namespaces/catalog.ts:922` — "// realpath check below would ACCEPT it — but a storage root must be a"
- `packages/remnic-core/src/namespaces/catalog.ts:923` — "// directory. Recording a file as a namespace root yields a broken install"
- `packages/remnic-core/src/namespaces/catalog.ts:924` — "// that only fails later when maintenance/QMD/mkdir treat it as a dir. The"
- `packages/remnic-core/src/namespaces/catalog.ts:925` — "// disk scan already skips non-directory entries; mirror that here so every"
- `packages/remnic-core/src/namespaces/catalog.ts:926` — "// containment consumer (resolve/touch/fallback/live-recheck) agrees."
- `packages/remnic-core/src/namespaces/catalog.ts:929` — "// The leaf does not exist yet. Lexical containment is NOT sufficient: an"
- `packages/remnic-core/src/namespaces/catalog.ts:930` — "// EXISTING ancestor (e.g. `<memoryDir>/namespaces`) could be a symlink to"
- `packages/remnic-core/src/namespaces/catalog.ts:931` — "// outside memoryDir, so a future mkdir/maintenance/QMD op would follow the"
- `packages/remnic-core/src/namespaces/catalog.ts:932` — "// persisted root outside the root (round 6, codex P2 — NDo79). Verify the"
- `packages/remnic-core/src/namespaces/catalog.ts:933` — "// nearest EXISTING ancestor's realpath still resolves inside memoryDir."
- `packages/remnic-core/src/namespaces/catalog.ts:944` — "/** * Reject a candidate whose path crosses a SYMLINKED ancestor strictly between * memoryDir and the leaf (codex NVu"
- `packages/remnic-core/src/namespaces/catalog.ts:967` — "/** * Walk up from a not-yet-existing candidate to the nearest ancestor that exists * on disk and verify its realpath"
- `packages/remnic-core/src/namespaces/catalog.ts:999` — "// The nearest EXISTING ancestor must resolve inside the memory root..."
- `packages/remnic-core/src/namespaces/catalog.ts:1001` — "// ...AND be a directory: a non-directory ancestor (e.g. a file occupying"
- `packages/remnic-core/src/namespaces/catalog.ts:1002` — "// `namespaces`) cannot hold the not-yet-created leaf (NHIdt)."
- `packages/remnic-core/src/namespaces/catalog.ts:1007` — "// The ancestor vanished between realpath and lstat — treat as not usable."
- `packages/remnic-core/src/namespaces/catalog.ts:1013` — "/** * Resolve the storage dir to persist for a touch, validating any caller- * provided `metadata.storageDir` against"
- `packages/remnic-core/src/namespaces/catalog.ts:1029` — "// An explicit storageDir is accepted ONLY when it is both contained AND"
- `packages/remnic-core/src/namespaces/catalog.ts:1030` — "// actually belongs to THIS namespace (round 6, codex P2 — NDATT). Containment"
- `packages/remnic-core/src/namespaces/catalog.ts:1031` — "// alone let a caller pass another namespace's tree (e.g."
- `packages/remnic-core/src/namespaces/catalog.ts:1032` — "// `markWrite("project-a", { storageDir: ".../namespaces/<project-b-token>" })`)"
- `packages/remnic-core/src/namespaces/catalog.ts:1033` — "// or `memoryDir` for a non-default namespace; `listNamespaces()` would then"
- `packages/remnic-core/src/namespaces/catalog.ts:1034` — "// tell maintenance/QMD that `project-a` lives in another namespace's (or the"
- `packages/remnic-core/src/namespaces/catalog.ts:1035` — "// default) tree — a cross-namespace root confusion. We reject a mismatched"
- `packages/remnic-core/src/namespaces/catalog.ts:1036` — "// explicit root and fall back to the namespace's own resolved root."
- `packages/remnic-core/src/namespaces/catalog.ts:1044` — "// Don't let a record poisoned by a pre-fix out-of-containment write keep an"
- `packages/remnic-core/src/namespaces/catalog.ts:1045` — "// unsafe dir alive across touches — only preserve a contained existing dir"
- `packages/remnic-core/src/namespaces/catalog.ts:1046` — "// that also belongs to this namespace."
- `packages/remnic-core/src/namespaces/catalog.ts:1057` — "/** * Whether `candidate` is a legitimate storage root FOR `namespace` (round 6, * codex P2 — NDATT). Accepts the nam"
- `packages/remnic-core/src/namespaces/catalog.ts:1089` — "// memoryDir is a valid root ONLY for the default namespace."
- `packages/remnic-core/src/namespaces/catalog.ts:1137` — "/** * The namespace-specific contained fallback root, used when the router-resolved * root fails containment (round 5"
- `packages/remnic-core/src/namespaces/catalog.ts:1173` — "/** * Re-check, NOW, whether a namespace's storage root currently EXISTS on disk * with the SAME safety the directory"
- `packages/remnic-core/src/namespaces/catalog.ts:1205` — "// Use the SAME router-aligned, containment-enforcing resolver the catalog"
- `packages/remnic-core/src/namespaces/catalog.ts:1206` — "// uses everywhere else. It never returns an escaping path (falls back to a"
- `packages/remnic-core/src/namespaces/catalog.ts:1207` — "// namespace-specific contained root on containment failure)."
- `packages/remnic-core/src/namespaces/catalog.ts:1212` — "// NH3Xy (codex P2): for a NON-default namespace, a generic fallback root is"
- `packages/remnic-core/src/namespaces/catalog.ts:1213` — "// NOT proof of liveness. When the namespace's own token root was skipped by"
- `packages/remnic-core/src/namespaces/catalog.ts:1214` — "// the scan as a symlink/escape, `resolveSafeStorageDir` can fall back to the"
- `packages/remnic-core/src/namespaces/catalog.ts:1215` — "// DEFAULT namespace's `memoryDir`; `hasMemoryData()` on that shared default"
- `packages/remnic-core/src/namespaces/catalog.ts:1216` — "// tree then returns true whenever the default namespace has any data, which"
- `packages/remnic-core/src/namespaces/catalog.ts:1217` — "// would wrongly KEEP a stale project row now pointing at the default tree"
- `packages/remnic-core/src/namespaces/catalog.ts:1218` — "// instead of purging the skipped namespace. Only the namespace's OWN root may"
- `packages/remnic-core/src/namespaces/catalog.ts:1219` — "// attest its liveness — so if a non-default namespace resolved to `memoryDir`,"
- `packages/remnic-core/src/namespaces/catalog.ts:1220` — "// it has no independent contained root and must be treated as absent (purge)."
- `packages/remnic-core/src/namespaces/catalog.ts:1234` — "// Reject a symlinked root rather than resurrecting it (scan parity)."
- `packages/remnic-core/src/namespaces/catalog.ts:1237` — "// Realpath must stay inside the memory root (scan parity)."
- `packages/remnic-core/src/namespaces/catalog.ts:1244` — "// Only treat the root as a live namespace when it actually holds memory data,"
- `packages/remnic-core/src/namespaces/catalog.ts:1245` — "// exactly as the scan does (empty shells are not catalogued)."
- `packages/remnic-core/src/namespaces/catalog.ts:1309` — "// Containment-check any explicit storageDir before persisting it (round 4"
- `packages/remnic-core/src/namespaces/catalog.ts:1310` — "// + round 5, codex P2). Never trust a caller-provided path verbatim;"
- `packages/remnic-core/src/namespaces/catalog.ts:1311` — "// reject lexical escapes AND symlinks that escape via realpath."
- `packages/remnic-core/src/namespaces/catalog.ts:1571` — "// CONTAINMENT (round 6, codex P2 — NEOFS): `resolveDefaultNamespaceRoot()` can"
- `packages/remnic-core/src/namespaces/catalog.ts:1572` — "// return a `namespaces/<default-token>` symlink escaping memoryDir when the"
- `packages/remnic-core/src/namespaces/catalog.ts:1573` — "// legacy default root is empty. The default record must never carry an"
- `packages/remnic-core/src/namespaces/catalog.ts:1574` — "// escaping `storageDir`; fall back to the trusted `memoryDir` root when the"
- `packages/remnic-core/src/namespaces/catalog.ts:1575` — "// resolved one fails containment. Computed ONCE so every later use (the"
- `packages/remnic-core/src/namespaces/catalog.ts:1576` — "// configured-seeding step and the scan's default-dir re-apply) stays safe."
- `packages/remnic-core/src/namespaces/catalog.ts:1584` — "// SAFETY (round 6, codex P2 — NBPmO): `parseConfig` intentionally preserves"
- `packages/remnic-core/src/namespaces/catalog.ts:1585` — "// unsafe namespace strings (e.g. a `sharedNamespace`/`namespacePolicies[]`"
- `packages/remnic-core/src/namespaces/catalog.ts:1586` — "// name like `../evil`) so sinks reject them. The hot touch/scan paths"
- `packages/remnic-core/src/namespaces/catalog.ts:1587` — "// already reject via `isSafeRouteNamespace`; rebuild must NOT be the path"
- `packages/remnic-core/src/namespaces/catalog.ts:1588` — "// that admits an unsafe configured namespace into the catalog. The default"
- `packages/remnic-core/src/namespaces/catalog.ts:1589` — "// namespace is exempt (it may be a non-route literal), matching the scan"
- `packages/remnic-core/src/namespaces/catalog.ts:1590` — "// loop's exemption below."
- `packages/remnic-core/src/namespaces/catalog.ts:1619` — "// CONTAINMENT (round 6, codex P2 — NCzT4/NEOFS): verify the seeded path does"
- `packages/remnic-core/src/namespaces/catalog.ts:1620` — "// not ESCAPE memoryDir before recording it. The scan below rejects"
- `packages/remnic-core/src/namespaces/catalog.ts:1621` — "// escaping/symlinked roots, but this seeding runs FIRST, so without this"
- `packages/remnic-core/src/namespaces/catalog.ts:1622` — "// check rebuild would persist an escaping `storageDir`. `isContainedStorageDir`"
- `packages/remnic-core/src/namespaces/catalog.ts:1623` — "// enforces the full lexical + symlink + realpath contract and allows a"
- `packages/remnic-core/src/namespaces/catalog.ts:1624` — "// not-yet-created path (a brand-new configured namespace seeds its canonical"
- `packages/remnic-core/src/namespaces/catalog.ts:1625` — "// root). The DEFAULT namespace is also checked (NEOFS): if"
- `packages/remnic-core/src/namespaces/catalog.ts:1626` — "// `resolveDefaultNamespaceRoot()` returns a `namespaces/<default-token>`"
- `packages/remnic-core/src/namespaces/catalog.ts:1627` — "// symlink escaping memoryDir, we must NOT persist it. The default cannot be"
- `packages/remnic-core/src/namespaces/catalog.ts:1628` — "// "skipped" (it must always exist), so it falls back to the trusted"
- `packages/remnic-core/src/namespaces/catalog.ts:1629` — "// `memoryDir` root; a non-default namespace is skipped (escape)."
- `packages/remnic-core/src/namespaces/catalog.ts:1654` — "// CONTAINMENT (round 8, codex P2 — NE9K_): check the `namespaces` ROOT itself"
- `packages/remnic-core/src/namespaces/catalog.ts:1655` — "// BEFORE `readdir` follows it. If `<memoryDir>/namespaces` is a symlink (or its"
- `packages/remnic-core/src/namespaces/catalog.ts:1656` — "// realpath escapes memoryDir), `readdir()` would enumerate an arbitrary outside"
- `packages/remnic-core/src/namespaces/catalog.ts:1657` — "// tree — leaking names or spending time on a huge directory — even though the"
- `packages/remnic-core/src/namespaces/catalog.ts:1658` — "// catalog rejects symlinked/escaping per-entry roots. The per-entry lstat/realpath"
- `packages/remnic-core/src/namespaces/catalog.ts:1659` — "// checks below run AFTER the readdir, so they cannot prevent following an"
- `packages/remnic-core/src/namespaces/catalog.ts:1660` — "// escaping ROOT. We lstat the root: if it is a symlink, OR its realpath escapes"
- `packages/remnic-core/src/namespaces/catalog.ts:1661` — "// memoryDir, we DO NOT read it and report it as a single unsafe scan root."
- `packages/remnic-core/src/namespaces/catalog.ts:1674` — "// The `namespaces` dir does not exist yet (or lstat failed): nothing to scan,"
- `packages/remnic-core/src/namespaces/catalog.ts:1675` — "// and there is no symlink to follow. Treat as an empty, safe scan."
- `packages/remnic-core/src/namespaces/catalog.ts:1698` — "// Reject symlinks / escaping roots rather than trusting them."
- `packages/remnic-core/src/namespaces/catalog.ts:1711` — "// Containment: realpath must stay inside the memory root."
