# Persist-Path Gate Ordering: Routing, Judge, Redaction, Faithfulness, Tombstone

Status: accepted

## Context
A fact traverses many gates between extraction and storage, and their order
determines behavior: the judge must evaluate the category that will actually
be persisted, redaction must catch never-store patterns regardless of which
namespace a fact routes to, and gates that quarantine a fact (faithfulness,
requireSpans, tombstone) must also prevent its side effects — promotion,
supersession, contradiction auto-resolve, graph and index entries — from
acting on the quarantined row. Near-duplicate suppression must not drop
corrections or contradictory updates, and judge telemetry must not couple the
judge to its ledgers.

## Decision
Rules:

- Route BEFORE judging and dedup: compute the routed category in a pre-pass,
  build judge candidates with the routed category, and evaluate routing
  exactly once per fact. Judge durability, dedup fingerprints, and importance
  all see the final persisted category.
- Apply the importance write-gate BEFORE the semantic dedup lookup, so
  low-importance facts never incur an embedding search; score importance
  before the dedup short-circuit so backfill can gate on it.
- Consult the durability judge after importance: active mode drops
  non-durable facts, shadow mode logs only, and deferred verdicts neither
  persist now nor cache the outcome — the fact is re-evaluated on a later
  pass, and the defer count is returned per-run (no shared side-channel
  state concurrent extractions can read). The whole judge pipeline failing is
  fail-open: proceed without filtering. Telemetry and training-pair writers
  are fire-and-forget behind one optional callback; both disabled means zero
  overhead. The procedure gate (two or more steps + trigger phrasing) is
  independent of the durability judge and its shadow flag.
- Redaction rules are checked pre-judge (so never-store content never becomes
  judge training data) and again at the write gate, consulting source AND
  routed-target namespace rules per fact; the write-time gate fails open on
  read error. Cache redaction rules per dir for the persist pass. Hoist the
  namespaces-enabled config read once per pass instead of scattering new
  flag reads.
- A pending_review fact (faithfulness enforce mode, requireSpans without a
  located quote, tombstone-blocked) persists into the review queue — never
  silently dropped — and bypasses the semantic-skip, must not trigger
  contradiction auto-resolve or supersession, must not promote to
  shared/profile, and must not enter the embedding-fallback index or thread
  episode ids (no resurrection through chunks).
- Contradiction detection runs BEFORE the chunking branch so chunked facts
  cannot bypass the deferred semantic-skip guard. The semantic-skip applies
  only when NO contradiction was detected (use contradictionDetected, not
  supersedes, so facts survive with auto-resolve off); correction-category
  writes are never suppressed by the semantic skip, using writeCategory
  (post-routing), not the raw category.
- Faithfulness gate placement: after parse + provenance validation, before
  persist/index; off = byte-identical pipeline, shadow = record only,
  enforce = pending_review. The orchestrator stays a thin read-through; the
  logic lives in the pure module.
- The subject guard is the ONE gate shared by every extraction-side promotion
  path so behavior matches the spaces surface.

## Consequences
The ordering is load-bearing: reordering any two gates changes which facts
are persisted or dropped. Pending_review rows pay storage without index
visibility until review resolves. Fail-open judge and redaction read errors
favor persistence over protection in those specific failure cases, by
design; redaction at the write gate is the backstop.

## Origin comments
- `packages/remnic-core/src/orchestration/extraction-persist.ts:212` — "// This run's judge-deferred count, returned to the caller (issue #562 PR 2)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:213` — "// instead of shared side-channel state, so concurrent extractions cannot"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:214` — "// read each other's retention decision."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:277` — "// #1669: per-namespace redaction-rule cache for this persist pass. A"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:278` — "// `never_store` / redaction_rule correction persists patterns under each"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:279` — "// namespace's state/corrections/redaction-rules/ dir; we consult them"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:280` — "// before a fact reaches the storage write chokepoint so matching content"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:281` — "// is withheld entirely rather than landing as pending_review. Cached per"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:282` — "// dir so a multi-fact batch over one namespace reads the dir once."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:334` — "// #1713: hoist namespaces-enabled once for the scope-routing mirrors"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:335` — "// (pre-judge + write-loop) so no new scattered config.*Enabled read is"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:336` — "// introduced (ratchet scatteredConfigFlagReads; see #1523)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:339` — "// Subject guard (issue #2372): the ONE gate shared by every extraction-side"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:340` — "// promotion path so behavior matches the spaces surface (§27)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1222` — "// Pre-routing pass: compute the routed category for every fact BEFORE"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1223` — "// building judge candidates. Route rules may override f.category (e.g."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1224` — "// via taxonomy remapping), and the judge must evaluate against the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1225` — "// *final* category that will actually be persisted — not the raw"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1226` — "// extraction-time category. The per-fact write loop below reuses"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1227` — "// these pre-computed results so routing is evaluated exactly once per"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1228` — "// fact (no duplicated logic)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1230` — "// #1713 Item 1: collect routed target namespaces so the pre-judge redaction"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1231` — "// filter can consult rules from cross-namespace targets, not just the source."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1232` — "// #1713 P2 (cursor): track per-fact routed namespace for per-fact pre-judge rules"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1264` — "// The verdicts map is keyed by candidate index — we maintain a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1265` — "// candidateIndexToFactIndex mapping so the write loop can look up"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1266` — "// verdicts by original fact index."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1268` — "// Candidates are built using the *routed* category (preRoutedCategories)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1269` — "// so the judge evaluates durability against the same category that will"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1270` — "// be persisted, not the raw extraction-time category."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1274` — "// #1669 P1 + #1713 Item 1: pre-filter redacted facts from judge candidates"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1275` — "// so never-store content is not persisted as judge training data."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1276` — "// Consult source + shared + routed target namespace rules so a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1277` — "// never-store pattern registered under a cross-namespace target is"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1278` — "// caught at the batch pre-filter point, not just at the persist gate."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1281` — "// #1713: base rules are source-only. Per-fact routed target rules"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1282` — "// (including shared when a fact is routed there) are checked in the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1283` — "// fact loop, matching the write-time gate's per-fact scoping exactly."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1300` — "// Use the routed category when available so the judge sees the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1301` — "// final persisted category, not the raw extraction-time value."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1302` — "// Cast to MemoryCategory — routing targets are always valid"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1303` — "// category slugs defined in the taxonomy; the fallback is the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1304` — "// original ExtractedFact.category which is already typed."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1315` — "// Pre-filter: skip facts below importance threshold to avoid"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1316` — "// wasting LLM calls on facts that will be filtered anyway in"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1317` — "// the per-fact write loop (issue #376 review finding)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1326` — "// #1713 P2 (cursor): per-fact rules — load this fact's routed target"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1327` — "// namespace rules FIRST, then check. This catches target-only rules"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1328` — "// even when the base (source+shared) rules are empty (threads acc58c42"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1329` — "// + PBJEe/PBKAj)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1332` — "// #1713: predict the same target namespace the write loop will route"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1333` — "// this global fact to (shared, via shouldPromoteGlobalFactToShared) so"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1334` — "// the pre-judge redaction filter consults that namespace's rules."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1371` — "// Telemetry + training-pair emit (issue #562 PR 3 + PR 4). The"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1372` — "// orchestrator wires two fire-and-forget writers behind a single"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1373` — "// callback so `judgeFactDurability` does not need to know about"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1374` — "// either ledger. Both handlers are skipped when their flags are"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1375` — "// off; the combined callback itself is undefined when both are"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1376` — "// disabled so there is zero overhead in the default configuration."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1457` — "// Expose defer count to the caller (issue #562 PR 2) so it can decide"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1458` — "// whether to retain buffer turns for the next extraction pass."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1461` — "// Fail-open: if the entire judge pipeline errors, proceed without filtering"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1468` — "// Faithfulness gate (issue #1576). Entailment-verification of extracted"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1469` — "// facts against their verified source spans from #1575. Placement: after"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1470` — "// parse + provenance validation, BEFORE persist/index (rule 44). The"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1471` — "// substantive batch logic lives in the pure module; this is thin"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1472` — "// delegation (ground rule 4). off → null map (byte-identical pre-feature"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1473` — "// pipeline, rule 39); shadow → record only; enforce → pending_review."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1548` — "// Routing runs before content-hash dedup and scoring so category overrides"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1549` — "// affect both the dedup fingerprint and importance (issue #519 procedure routing)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1552` — "// #1669 thread #2: pre-routing source ns for redaction gate"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1591` — "// Write-time subject stamp (issue #2372): extractor token over the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1592` — "// category default; absent when classification is disabled (byte-identical)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1596` — "// Scope-based namespace routing: a `global` fact (no explicit routing"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1597` — "// rule) promotes to the shared namespace unless a guard withholds it."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1640` — "// #1669 redaction-rule gate: consult BOTH source and target namespace"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1641` — "// rules before any write. A never-store pattern registered under the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1642` — "// source namespace must survive scope-routing to a different target"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1643` — "// (review thread #2). Fails open on read error."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1799` — "// Importance write-gate (issue #372). Drop facts whose locally-scored"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1800` — "// level falls below the configured minimum BEFORE the semantic dedup"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1801` — "// lookup so that low-importance facts never incur an embedding search."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1802` — "// scoreImportance() already applies category boosts (e.g. corrections"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1803` — "// +0.15) before deriving the level, so a correction at raw ~0.35"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1804` — "// still lands at \"normal\" and passes the default gate. Without this"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1805` — "// gate, trivial turn-level chatter (\"hi\", \"k\", heartbeat pings) gets"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1806` — "// persisted as a fact memory and dilutes the store."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1817` — "// Log-based counter (no dedicated metric bus in remnic-core yet)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1818` — "// Operators can grep for `metric:importance_gated` in gateway.log"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1819` — "// to tune extractionMinImportanceLevel."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1826` — "// Extraction judge gate (issue #376 + #562 PR 2). After the local"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1827` — "// importance gate passes, consult the judge verdict (computed before"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1828` — "// the loop). In active mode, non-durable facts are dropped. In shadow"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1829` — "// mode, verdicts are logged but all facts proceed to write."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1831` — "// Defer verdicts (issue #562): do not persist now, but also do not"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1832` — "// cache the outcome so the candidate is re-evaluated on a later"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1833` — "// extraction pass. The judge module tracks how many times the same"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1834` — "// content has been deferred and converts to reject at the configured"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1835` — "// cap, so the orchestrator only needs to skip the write here."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1860` — "// Procedure extraction gate (issue #519): ≥2 steps + trigger phrasing."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1861` — "// Runs even when extractionJudgeEnabled is false (durability judge is unrelated)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1862` — "// Never tied to extractionJudgeShadow — that flag is only for the LLM durability judge."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1876` — "// Faithfulness gate verdict application (issue #1576). Look up the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1877` — "// pre-computed verdict for this fact and translate it to frontmatter +"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1878` — "// an optional enforce-mode pending_review status. Logic lives in the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1879` — "// pure module; this is thin read-through (ground rule 4)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1889` — "// requireSpans enforcement (issue #1575 PR 2): when an operator opts"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1890` — "// into provenance.requireSpans, a fact whose quote could not be located"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1891` — "// in any source turn (carried as the transient requireSpansPending"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1892` — "// signal from the extraction validator) routes to pending_review — the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1893` — "// same review queue an unsupported faithfulness verdict uses. This is"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1894` — "// the persist-path wiring ProvenanceConfig.requireSpans documents."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1895` — "// Faithfulness takes precedence when it already routed the fact; both"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1896` — "// gates agree on pending_review so the merge is a simple coalesce"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1897` — "// (chatgpt-codex-connector thread 4xB)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1988` — "// NOTE: This block was moved above the chunking branch so that the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1989` — "// pendingSemanticSkip guard (below) can also protect the chunking path."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1990` — "// Previously, contradiction detection only ran on the non-chunked path,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1991` — "// meaning chunked facts could be persisted even when semanticDecision was"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1992` — "// \"skip\" (the deferred guard was bypassed by the chunking `continue`)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1995` — "// True when contradiction detection ran and confirmed a contradiction,"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1996` — "// regardless of whether auto-resolve is enabled. Used by the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1997` — "// semantic-skip guard so that contradictory updates are never silently"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1998` — "// dropped — even when `contradictionAutoResolve=false` (in which case"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:1999` — "// `supersedes` is intentionally left unset to avoid retiring the old"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2000` — "// memory without user confirmation)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2002` — "// #1645: hoist the contradiction result so the deferred auto-resolve"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2003` — "// (post-write, gated on tombstone status) can read its fields."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2013` — "// Faithfulness gate (#1576, chatgpt P2): skip contradiction detection"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2014` — "// for a pending_review fact — an unfaithful extraction in the review queue"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2015` — "// must not trigger auto-resolve and retire an existing active memory."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2035` — "// When auto-resolve is enabled the existing memory has already been"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2036` — "// marked superseded; set `supersedes` so the new write carries the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2037` — "// relationship. When auto-resolve is disabled we still record the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2038` — "// contradiction link (so the memory is annotated for manual review)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2039` — "// but do NOT set `supersedes` on the new write — the old memory"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2040` — "// remains active until a human resolves it."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2057` — "// Apply the deferred semantic-skip now that contradiction detection has"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2058` — "// run. If a contradiction was found (contradictionDetected is true), the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2059` — "// candidate is a contradictory update and must be written — do not skip"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2060` — "// it. Only drop it when there is no detected contradiction (true"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2061` — "// near-duplicate). This check intentionally runs BEFORE the chunking"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2062` — "// branch so that a fact flagged as a semantic near-duplicate cannot be"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2063` — "// persisted (with its hash registered) simply because it was long enough"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2064` — "// to trigger chunking."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2066` — "// NOTE: We use `contradictionDetected` rather than `!!supersedes` here"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2067` — "// so that facts are preserved even when `contradictionAutoResolve=false`."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2068` — "// When auto-resolve is disabled `supersedes` is intentionally unset, but"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2069` — "// the write must still proceed so the user can manually reconcile the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2070` — "// two memories later."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2072` — "// UUI1: correction category writes are NEVER suppressed by the semantic"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2073` — "// skip fallback, regardless of whether supersedes is set. When contradiction"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2074` — "// detection is disabled or QMD is unavailable, supersedes is never set —"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2075` — "// without this exemption a high-similarity correction would be silently"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2076` — "// dropped, leaving a stale fact active. writeCategory (not fact.category)"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2077` — "// is used because routing rules may have overridden the raw category."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2079` — "// Faithfulness gate (#1576, cursor High): a pending_review fact must"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2080` — "// bypass the semantic-dedup skip so it reaches the review queue — the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2081` — "// gate's contract is \"persists with status: pending_review, never"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2082` — "// silently dropped\" (issue #1576)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2195` — "// Faithfulness gate (issue #1576)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2198` — "// Claim-level provenance spans (issue #1575 PR 2)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2216` — "// #1645: surface the tombstone block and gate active post-write paths"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2238` — "// #1645: defer contradiction auto-resolve until tombstone status is // known (see applyDeferredContradictionResolve)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2239` — "// known (see applyDeferredContradictionResolve)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2299` — "// Faithfulness gate (issue #1576): propagate the parent // fact's verdict + enforce status so a pending_review fact //…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2300` — "// fact's verdict + enforce status so a pending_review fact"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2301` — "// is not indexed as active through its chunks (chatgpt P2)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2303` — "// #1645 (OchiE): inherit pending_review + blockedBy so no chunk lands active."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2310` — "// Claim-level provenance (issue #1575 PR 2): mirror the // parent's spans onto each chunk so a chunk surfaced // indep…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2334` — "// #1576 (cursor Medium): keep pending_review ids out of threadEpisodeIdsForGraph — else later active facts build threa…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2342` — "// #1645: same gate as the non-chunked path — a blocked chunked parent // must not enter the embedding-fallback index (…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2343` — "// must not enter the embedding-fallback index (resurrection)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2350` — "// Faithfulness gate (#1576, cursor High): skip supersession for a"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2351` — "// pending_review fact — an unfaithful extraction in the review queue"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2352` — "// must NOT retire older active memories."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2380` — "// Faithfulness gate (#1576, chatgpt P2): do not promote a // pending_review fact to shared/profile — it must enter the…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2381` — "// pending_review fact to shared/profile — it must enter the review"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2382` — "// queue without active copies that bypass the gate."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2441` — "// #1645: chunks inherit pending_review under postWriteGuard — don't"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2442` — "// index them into the embedding fallback (resurrection)."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2604` — "// Claim-level provenance spans (issue #1575 PR 2). Carry verified // sources + the coarse strength tag from the extrac…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2640` — "// #1645: surface the tombstone block; gate active post-write paths like #1576 // so a blocked fact creates no active s…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2641` — "// so a blocked fact creates no active shared copy / supersession / graph entry."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2722` — "// #1645: a tombstone-blocked / pending_review fact must NOT enter the // embedding-fallback index — otherwise embeddin…"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2723` — "// embedding-fallback index — otherwise embedding recall surfaces the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2724` — "// pending_review row (resurrection). Gate on postWriteGuard like the"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2725` — "// surrounding supersession / promotion / graph paths."
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2729` — "// Faithfulness gate (#1576, chatgpt P2): skip promotion for a // pending_review fact so no active shared/profile copy …"
- `packages/remnic-core/src/orchestration/extraction-persist.ts:2730` — "// pending_review fact so no active shared/profile copy bypasses the gate."
- `packages/remnic-core/src/orchestration/extraction-run-helpers.ts:194` — "/** * Applies deferred-judge retention only to live, non-shadow extraction runs. * Replay/import paths must not synthe"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1077` — "// Verbatim source turns for the faithfulness gate (#1576) so it can"
- `packages/remnic-core/src/orchestration/extraction-run.ts:1078` — "// locate a quote per fact when #1575 spans are absent."
