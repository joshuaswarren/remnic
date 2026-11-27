# Trust boundaries validate or refuse before I/O; long scans yield and cache invalidates; smallest themes merged here per the ten-file limit

Status: accepted

## Context
This chunk's remaining records describe many small, defensible boundary decisions across admin surfaces, ambient-capture provenance, artifact search, briefing reads, binary-lifecycle redirects, CLI safety, parsing, and adapters — each too small for its own ADR. They share one premise: data crossing a trust boundary (user input, filesystem, external tool output) is validated, sanitized, or refused before it can do damage, and long work must not starve the event loop or serve stale bytes. MERGED THEME: per the ten-file limit these smallest themes are merged into this nearest-neighbour file rather than dropped.

## Decision
Boundary and scan rules, by family. (1) ADMIN SURFACES are pure delegation — the admin surface never applies destructive migration (dry-run audit only; the CLI owns apply); dashboards display a frozen verbatim copy of the ScopePlan including the plan field verbatim (the same-plan-as-runtime acceptance contract); the 16-hex identity token survives redaction (routing token, not credential) while diagnostic keys colliding with the sensitive-key regex but not credentials are exempted; raw error messages are never echoed to dashboards or promotion results; readable-but-not-writable overrides still become the effective write namespace (surfaced as a warning); unknown QMD collection states are classified defensively — rendered honestly as distinct from missing/unavailable (skipped means intentionally disabled, neither degraded nor blank) while the degraded bit keeps the original formula (unrecognized state NOT degraded) so aggregate alerting stays byte-for-byte consistent with the router health path; no-active-profile is distinguished from profile-lacks-target; the inspect pre-read flag is honored when supplied, falling back to config for direct callers. (2) AMBIENT-CAPTURE PROVENANCE gates health-adjacent content on every path: prompt sections carry the rule so the tier itself carries it, backed by a deterministic shape-based backstop — a claim ABOUT A PERSON is high-impact whatever it names, and injury/contagion SHAPE is matched directly because no condition vocabulary can be complete; the vocabulary is deliberately broad (a false negative puts a fabricated medical claim into recall); proactive passes get the media warning too; confidence boosts are capped at review because the auto-approve comparison is inclusive; the ambientCapture flag is never dropped in copies (a dropped flag skips extraction while the turn buffers). (3) ARTIFACT SEARCH: reading a tier is a lazy thunk — a query that cannot match anything must not pay a cold recursive scan; scans yield/abort every 256 documents (and between scoring) so deadlines and signals are observed even without real I/O, with a last-chance signal check after the tier read; ties keep corpus order so repeated scans produce the same top-N. (4) BINARY-LIFECYCLE REDIRECTS: redirect rewrites use a write-boundary journal; memory-tier records are whole-record-rewritten from the CURRENT journal at write time with repair afterwards — never writing back as-read bytes that could revert a peer migration's rewrite; non-corpus Markdown keeps its bytes plus the redirect; original bytes are snapshotted so a failed repair restores the pre-redirect state; the corpus sentinel is bumped per write so warm caches never serve pre-redirect content; failed verification does not read as a completed redirect and clears stale stamps; only redirected assets are cleaned (mirrored-only assets still have live markdown refs); paths normalize to POSIX separators for Windows; verification matches both file-relative and memory-root-relative link forms. (5) MANIFESTS AND SERIALIZATION: manifests write atomically (temp file + rename, never delete before write) with temp cleanup on rename failure and sorted keys for deterministic output; user-derived regex parts are always escaped and lastIndex reset after test(); local minimal interfaces avoid depending on whole modules. (6) BRIEFING READS: the briefing budget is a server-side deadline, not client cancellation; the default deadline is distinct from cancellation (raceAbort normalizes but the deadline reason is retained); caller cancellation rethrows so the briefing rejects rather than degrading to an empty corpus; reads use the windowed readMemoriesWindow path with a bounded full-read fallback for legacy doubles; cancellation support requires an affirmative explicit marker (never Function.length); the signal IS the deadline via direct await (no Promise.race) and a double resolving partial rows on abort must not have them served as complete; adapter-controlled Error.name is sanitized against an allow-list before structured logs; read logs are content-free discriminators (mode/durationMs/counts). (7) CLI SAFETY: input validation is strict and early — explicit values validated at the boundary, unrecognized --format rejected before I/O, --as-of validated, contradictory flags rejected rather than silently picked, --confirm must be literally "yes", mutations default to dry-run unless --apply/--apply-parity given, inert rebuild payloads carry applied:false with exit-code and failure-signal parity with the enabled path, and the cross-process rebuild lock gates --apply; memory walks reject symlinked/non-directory roots and never follow symlinked entries (a poisoned entry is skipped, the walk continues; optional-dir ENOENT is silent, containment errors log); capsule paths resolve via the documented 3-step precedence, encrypted archives are rejected before gunzip, inspection prefers the sidecar manifest, explicit --dir errors are surfaced while default-dir ENOENT means not-created; bulk-import anchors on the orchestrator's EXACT namespace, guards library callers, and never calls processBatch in dryRun; registry names are trimmed on write AND lookup; transcript day reads use half-open [day, next-day 00:00Z) windows; retention durations normalize calendar units (1Y=365D, 1M=30D); the HTTP server starts before orchestrator init so the port is available; `~` is expanded before fs calls; connectors route through shared closures; the weclone import is a computed optional dynamic import; wearables fuse subcommands register on the host CLI; Codex CLI fallback registration keeps core free of child_process. (8) PARSING AND ADAPTERS: chunking splits only at sentence boundaries using a linear, non-backtracking scan (CJK-safe), and overlap reassembly uses the simple full-first-chunk-then-non-overlapping heuristic (acknowledged imperfect); citation entries split on the LAST colon before the range pattern because file paths contain colons; adapters match MCP clientInfo names (e.g. "codex") for forward compatibility where names are undocumented. (9) TEST REALISM for these paths: host-CLI registration tests use deterministic orchestrator stubs reading primitive config; the mock res keeps all tracking fields on one object (no spread-copy freezing primitives).

## Consequences
Strict early validation turns typos into immediate errors instead of surprise behavior at I/O time. Refusing symlinked roots and encrypted archives blocks whole classes of operations some users legitimately wanted. Lazy tier reads and yield checkpoints make cancellation observable but add scan-boundary complexity. The verbatim plan display couples the dashboard to the runtime resolver's field shape. Because these small decisions are merged here, this file's Decision is a family of rules, not one rule — readers should consult the Origin comments for the authoritative per-topic evidence.

## Origin comments
### adapter-detection-forward-compat
- `packages/remnic-core/src/adapters/codex.ts:30` — "// Also match on clientInfo name containing "codex" for forward compat"
- `packages/remnic-core/src/adapters/replit.ts:31` — "// MCP clientInfo (Replit's MCP client name is not publicly documented,"
- `packages/remnic-core/src/adapters/replit.ts:32` — "// but check for it in case it becomes available)"

### redaction-token-classification
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:92` — "// The 16-hex identity token must survive (it's a routing token, not a credential)."

### admin-plan-field-contract
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:137` — "// The plan field MUST be present so the "same plan as runtime resolver""
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:138` — "// acceptance test holds — the dashboard displays this verbatim."

### qmd-degraded-classification
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:507` — "// "unknown" is still counted degraded (matches the router health path) so"
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:508` — "// aggregate alerting is unchanged, but it is now RENDERED honestly as a"
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:509` — "// distinct state rather than collapsed into "missing"."
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:717` — "// The original degraded formula was: !available || "missing" || "unknown"."
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:718` — "// An available backend with any OTHER collectionState (present/skipped/and any"
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:719` — "// unrecognized value) was NOT degraded. The classified qmdState surfaces the"
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:720` — "// unrecognized value honestly, but the degraded bit must stay false so the"
- `packages/remnic-core/src/admin/admin-surfaces.test.ts:721` — "// aggregate alerting invariant is byte-for-byte unchanged."

### admin-delegation-invariant
- `packages/remnic-core/src/admin/admin-surfaces.ts:1` — "Admin console surfaces (issue #1502). Pure delegation functions..."

### admin-redaction-exemptions
- `packages/remnic-core/src/admin/admin-surfaces.ts:50` — "Diagnostic keys whose name collides with the sensitive-key regex but are NOT credentials."

### admin-plan-verbatim
- `packages/remnic-core/src/admin/admin-surfaces.ts:155` — "Frozen copy of the ScopePlan; dashboard MUST display verbatim (issue #1502)."

### inspect-scope-flag-threading
- `packages/remnic-core/src/admin/admin-surfaces.ts:192` — "Honour the pre-read flag when the caller supplied one (avoids a scattered read here)."
- `packages/remnic-core/src/admin/admin-surfaces.ts:193` — "fall back to the config flag for direct callers (tests/CLI)."

### admin-override-write-warning
- `packages/remnic-core/src/admin/admin-surfaces.ts:217` — "Issue #1658 thread 6: readable-but-not-writable override still becomes effective write namespace."

### qmd-state-classification
- `packages/remnic-core/src/admin/admin-surfaces.ts:416` — "Honest, distinguishable QMD/search health classification (issue #1658 thread 1)."
- `packages/remnic-core/src/admin/admin-surfaces.ts:458` — "qmdDegraded matches router health path so degradedMode stays consistent with alerting."
- `packages/remnic-core/src/admin/admin-surfaces.ts:464` — "Honest QMD state; render unknown separately from missing/unavailable."
- `packages/remnic-core/src/admin/admin-surfaces.ts:505` — "Classify QMD snapshot into honest state bucket (issue #1658 thread 1)."
- `packages/remnic-core/src/admin/admin-surfaces.ts:524` — "collectionState is the router's string; classify defensively."
- `packages/remnic-core/src/admin/admin-surfaces.ts:531` — "skipped means QMD intentionally disabled; neither degraded nor blank."
- `packages/remnic-core/src/admin/admin-surfaces.ts:551` — "Preserve ORIGINAL qmdDegraded invariant: unrecognized collectionState not degraded."
- `packages/remnic-core/src/admin/admin-surfaces.ts:588` — "Classify collection state; degraded bit from same inputs as router health path."

### admin-error-sanitization
- `packages/remnic-core/src/admin/admin-surfaces.ts:600` — "Sanitize: never echo raw error messages to the dashboard."
- `packages/remnic-core/src/admin/admin-surfaces.ts:914` — "Sanitize: never echo raw error messages in the promotion result."

### admin-dry-run-only
- `packages/remnic-core/src/admin/admin-surfaces.ts:649` — "Dry-run transcript audit; admin surface never applies destructive migration; CLI owns apply."

### promotion-no-profile-message
- `packages/remnic-core/src/admin/admin-surfaces.ts:840` — "Issue #1658 thread 2: distinguish no-active-profile from profile-lacks-target."

### ambient-capture-provenance
- `packages/remnic-core/src/ambient-provenance.test.ts:23` — "Ambient-capture contamination scenario (issue #2294); both fix halves exercised on every path."
- `packages/remnic-core/src/ambient-provenance.test.ts:200` — "Proactive pass makes extra LLM calls; without flag those prompts had no media warning."
- `packages/remnic-core/src/ambient-provenance.test.ts:301` — "No condition vocabulary can be complete, so injury/contagion SHAPE matched directly."
- `packages/remnic-core/src/ambient-provenance.test.ts:302` — "a harm verb pointed at a person's possession."
- `packages/remnic-core/src/ambient-provenance.ts:1` — "Ambient-capture provenance (issue #2294); prompt sections + deterministic backstop."
- `packages/remnic-core/src/ambient-provenance.ts:40` — "Appended to speculative tier definition so the tier itself carries the rule."
- `packages/remnic-core/src/ambient-provenance.ts:86` — "Vocabulary deliberately broad: false negative puts fabricated medical claim into recall."
- `packages/remnic-core/src/ambient-provenance.ts:157` — "Strongest non-lexical signal: a claim ABOUT A PERSON is high-impact whatever it names."
- `packages/remnic-core/src/ambient-provenance.ts:158` — "whatever condition, relationship, or milestone the sentence names."
- `packages/remnic-core/src/ambient-provenance.ts:159` — "This is what covers wording no list anticipates."

### ambient-confidence-cap
- `packages/remnic-core/src/ambient-provenance.test.ts:410` — "Clamping alone insufficient: boosts reach 0.712 past 0.7 auto-approve; cap at review."
- `packages/remnic-core/src/ambient-provenance.test.ts:428` — "Auto-approve comparison is inclusive, so the threshold itself must cap."

### buffer-turn-ambient-flag
- `packages/remnic-core/src/ambient-provenance.test.ts:467` — "Dropped ambientCapture flag in copy would skip extraction for as long as turn buffered."

### artifact-scan-thunk
- `packages/remnic-core/src/artifact-search.test.ts:38` — "Reading the tier is a full recursive filesystem scan on a cold cache (issue #2291)."
- `packages/remnic-core/src/artifact-search.test.ts:39` — "a query that cannot match anything must not pay for it (issue #2291)."

### artifact-scan-interruptible
- `packages/remnic-core/src/artifact-search.test.ts:75` — "Yield/abort checkpoints land every 256 documents (issue #2291)."
- `packages/remnic-core/src/artifact-search.test.ts:76` — "corpus must cross that boundary for cancellation to be observable mid-scan."
- `packages/remnic-core/src/artifact-search.ts:1` — "Scan extracted from storage.ts (issue #2291); long scan starves event loop without yields."
- `packages/remnic-core/src/artifact-search.ts:89` — "Scan never awaits real I/O; last chance to observe a fired signal."
- `packages/remnic-core/src/artifact-search.ts:90` — "signal that fired while the tier was being read."

### artifact-scan-yield-interval
- `packages/remnic-core/src/artifact-search.ts:45` — "Artifacts scored between two yields: deadline observes sub-ms delay at low cost."

### artifact-scan-deterministic-order
- `packages/remnic-core/src/artifact-search.ts:111` — "Ties keep corpus order; comparator returns 0 for equal scores."
- `packages/remnic-core/src/artifact-search.ts:112` — "so repeated scans produce the same top-N."

### bridge-prompt-json-shape
- `packages/remnic-core/src/background-generation.test.ts:119` — "Bridge prompt must spell out required JSON shape or schema rejects summary-only reply."
- `packages/remnic-core/src/background-generation.test.ts:120` — "literal host model returns summary-only object and the schema rejects it."

### binary-delete-enoent-tolerance
- `packages/remnic-core/src/binary-lifecycle/backend.ts:227` — "// Ignore ENOENT (already deleted); rethrow everything else."

### manifest-atomic-write
- `packages/remnic-core/src/binary-lifecycle/manifest.ts:60` — "/** * Write the manifest atomically: write to a temp file, then rename. * CLAUDE.md #54: never delete before write. Writ"
- `packages/remnic-core/src/binary-lifecycle/manifest.ts:79` — "// Clean up temp on rename failure (cross-device edge case)."

### deterministic-serialization
- `packages/remnic-core/src/binary-lifecycle/manifest.ts:73` — "// Sort keys for deterministic output (CLAUDE.md #38)."

### redirect-write-boundary-journal
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:32` — "// Write-boundary journal cache for redirect rewrites (issue #2213)."

### corpus-sentinel-bump
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:35` — "/** * True when `mdPath` is an active recall-corpus memory file under `memoryDir` * (a top-level RECALL_FALLBACK_DIRS ca"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:391` — "// The redirect rewrote an on-disk memory file out-of-band (not through a"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:392` — "// StorageManager mutation). Bump the corpus sentinel per write so a warm"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:393` — "// hot-memories cache rescans — mid-batch too, never serving pre-redirect"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:394` — "// content (#1902). Only recall-corpus files affect that cache."

### minimal-local-interfaces
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:48` — "/** Minimal logger interface so we don't depend on the full logger module. */"

### escape-user-derived-regex
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:91` — "/** * Escape special regex characters in a string. * CLAUDE.md #46: always escapeRegex on user-derived parts. */"

### clean-stage-error-safety
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:214` — "// Redirect mirrored assets and retry prior redirect errors. Clean-stage errors"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:215` — "// remain safe because the redirect path validation below will keep rejecting"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:216` — "// invalid manifest records."

### regex-lastindex-reset
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:245` — "// Reset lastIndex after test()."

### redirect-whole-record-rewrite
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:347` — "// Whole-record rewrite of bytes read earlier (issue #2213): for"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:348` — "// memory-tier records, resolve the frontmatter entityRef through the"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:349` — "// CURRENT journal at the write and REPAIR afterwards — writing back"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:350` — "// the as-read bytes could revert a rewrite a peer migration performed"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:351` — "// since the read. findMarkdownFiles also surfaces transcripts,"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:352` — "// profiles, and other Markdown outside the migration's scope: those"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:353` — "// keep their bytes (plus the redirect) untouched, and entities/ pages"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:354` — "// get the bounded reconcile marker instead — their migrated surface"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:355` — "// is relationship targets, not an entityRef frontmatter field."

### redirect-snapshot-repair
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:362` — "// Snapshot the ORIGINAL bytes: if repair fails after the write, the"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:363` — "// catch below reports a failed redirect, so the file must return to"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:364` — "// its pre-redirect state — a retry needs the original reference,"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:365` — "// and the skipped corpus bump means a warm cache would otherwise"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:366` — "// keep serving bytes that no longer match disk (AGENTS.md §14)."

### redirect-verify-failure
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:426` — "// Failed verify must not read as a completed redirect (#2471); this also"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:427` — "// clears stale stamps written by manifests from before that fix."

### markdown-ref-path-forms
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:491` — "// Markdown links may be file-relative to the note or memory-root-relative in"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:492` — "// Remnic notes. Match both forms so verification cannot miss a live local ref."

### clean-only-redirected
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:523` — "// Clean only assets that have been redirected (markdown refs already rewritten)."
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:524` — "// Mirrored-only assets must NOT be cleaned — their markdown refs still point"
- `packages/remnic-core/src/binary-lifecycle/pipeline.ts:525` — "// to the local file, so deletion would break links."

### posix-path-normalization
- `packages/remnic-core/src/binary-lifecycle/scanner.ts:56` — "// Normalize to POSIX separators so redirect matching works on Windows"
- `packages/remnic-core/src/binary-lifecycle/scanner.ts:57` — "// (markdown links always use forward slashes)."

### day-dir-name-filter
- `packages/remnic-core/src/boxes.ts:550` — "// Filter day directories by name (YYYY-MM-DD) — skip dirs older than cutoff"
- `packages/remnic-core/src/boxes.ts:551` — "// without reading a single file from them."

### briefing-abort-test-design
- `packages/remnic-core/src/briefing-abort.test.ts:62` — "// The fallback releases broken signal plumbing too, so the regression cannot hang."
- `packages/remnic-core/src/briefing-abort.test.ts:156` — "// Object.create yields untyped values, so no assertion is needed: briefing() reads only these members."

### briefing-deadline-budget
- `packages/remnic-core/src/briefing-deadline.test.ts:1` — "/** * Issue #3139 — the briefing's default deadline. * * The budget is a server-side limit, not a client cancellation: e"
- `packages/remnic-core/src/briefing-deadline.ts:27` — "// raceAbort normalizes cancellation; retain the distinct deadline reason."

### real-abort-timer-protocol
- `packages/remnic-core/src/briefing-window.test.ts:56` — "/** * The slow-double test below deliberately exercises the REAL abort-timer * protocol (AbortController armed by produc"

### briefing-full-read-fallback-budget
- `packages/remnic-core/src/briefing-window.ts:18` — "/** * Deadline for the legacy full-read fallback (issue #2779). Storage doubles * that predate `readMemoriesWindow()` "

### briefing-error-name-sanitization
- `packages/remnic-core/src/briefing-window.ts:79` — "/** * Sanitize adapter-controlled Error.name before structured discriminator logs * (issue #2827). Allow-lists known s"

### briefing-content-free-read-logging
- `packages/remnic-core/src/briefing-window.ts:108` — "/** * One structured, content-free discriminator per briefing memory read * (issue #2779): `mode`, `durationMs`, `coun"

### briefing-cancelled-read-rethrow
- `packages/remnic-core/src/briefing-window.ts:149` — "// Caller cancellation is not a read failure: rethrow it so the briefing"
- `packages/remnic-core/src/briefing-window.ts:150` — "// rejects instead of degrading into an empty corpus (issue #3139). The"
- `packages/remnic-core/src/briefing-window.ts:151` — "// own fallback deadline is reported as BriefingReadTimedOut below."

### briefing-windowed-read-fallback
- `packages/remnic-core/src/briefing-window.ts:186` — "// A briefing only needs memories inside its lookback window. Avoid parsing"
- `packages/remnic-core/src/briefing-window.ts:187` — "// the full corpus on cache misses; keep the full-read fallback for custom"
- `packages/remnic-core/src/briefing-window.ts:188` — "// StorageManager-compatible callers that predate readMemoriesWindow()."

### legacy-adapter-cancellation-detection
- `packages/remnic-core/src/briefing-window.ts:195` — "// Refuse legacy adapters that do not explicitly declare cancellation support (#2827)."
- `packages/remnic-core/src/briefing-window.ts:196` — "// Require affirmative cancellation support (`true` on one explicit marker) before fallback."
- `packages/remnic-core/src/briefing-window.ts:197` — "// Do not rely on Function.length, which is zero for default/rest/bound functions."

### signal-as-deadline-direct-await
- `packages/remnic-core/src/briefing-window.ts:215` — "// Direct await, no Promise.race: the signal IS the deadline. A"
- `packages/remnic-core/src/briefing-window.ts:216` — "// signal-aware read settles on abort (AbortError at its next scan"
- `packages/remnic-core/src/briefing-window.ts:217` — "// boundary, #2307), so nothing is left scanning in the background once"
- `packages/remnic-core/src/briefing-window.ts:218` — "// this function returns."

### briefing-abort-partial-rows-guard
- `packages/remnic-core/src/briefing-window.ts:221` — "// A double that resolves partial rows instead of rejecting on abort"
- `packages/remnic-core/src/briefing-window.ts:222` — "// must not have them served as a complete corpus."

### empty-corpus-maximal-surprise
- `packages/remnic-core/src/buffer-surprise.ts:117` — "// Empty corpus → maximally surprising. Document decision: we prefer"
- `packages/remnic-core/src/buffer-surprise.ts:118` — "// "novelty by default" over "silence" because the surprise score is meant"
- `packages/remnic-core/src/buffer-surprise.ts:119` — "// to *promote* flushing, and an empty buffer of recent memories is the"
- `packages/remnic-core/src/buffer-surprise.ts:120` — "// clearest case of "we have no basis to call this redundant"."

### bulk-import-registry-name-trimming
- `packages/remnic-core/src/bulk-import/registry.test.ts:128` — "// Registration trims the name on write; lookup must trim as well,"
- `packages/remnic-core/src/bulk-import/registry.test.ts:129` — "// otherwise `get(' weclone ')` would miss the adapter stored"
- `packages/remnic-core/src/bulk-import/registry.test.ts:130` — "// under the trimmed key `weclone`."
- `packages/remnic-core/src/bulk-import/registry.ts:36` — "// Store adapter with trimmed name so `adapter.name` stays consistent with"
- `packages/remnic-core/src/bulk-import/registry.ts:37` — "// the registry key returned by `listBulkImportSources()`."
- `packages/remnic-core/src/bulk-import/registry.ts:43` — "/** * Retrieve a registered adapter by name. * * Names are trimmed on write (see `registerBulkImportSource`), so we * al"

### chunking-sentence-boundary
- `packages/remnic-core/src/chunking.ts:1` — "Automatic Chunking with Overlap (Phase 2A)... never splitting mid-sentence"

### sentence-splitter-linear-scan
- `packages/remnic-core/src/chunking.ts:42` — "The scan stays linear and does not use a backtracking regular expression... CJK text"

### reassemble-overlap-heuristic
- `packages/remnic-core/src/chunking.ts:277` — "For overlapping chunks, we need to deduplicate... This is imperfect but handles most cases"
- `packages/remnic-core/src/chunking.ts:278` — "Simple approach: use full first chunk, then non-overlapping parts of subsequent chunks"
- `packages/remnic-core/src/chunking.ts:279` — "This is imperfect but handles most cases"

### citation-entry-line-colon-splitting
- `packages/remnic-core/src/citations.ts:100` — "Splits on the LAST `:` before the range pattern, not the first, because file paths can contain colons..."
- `packages/remnic-core/src/citations.ts:109` — "Match the range+note suffix anchored at the end... greedy (.+) consumes everything up to the LAST `:`..."

### codex-cli-fallback-runner-registration-order
- `packages/remnic-core/src/cli-fallback.ts:53` — "True when a process-local Codex CLI transport is registered. Lets a default runner..."
- `packages/remnic-core/src/cli-fallback.ts:67` — "Registers the process-local Codex CLI transport. Core itself stays free of child_process here..."

### wearables-cli-forwarder-registration
- `packages/remnic-core/src/cli-wearables-fuse.test.ts:12` — "Host-CLI registration test for the wearables `fuse`/`fused` subcommands."

### cli-orchestrator-stub-primitive-config
- `packages/remnic-core/src/cli-wearables-fuse.test.ts:65` — "Deterministic orchestrator stub. registerCli only reads `config.*` while building..."

### tier-migration-cli-adapter-shapes
- `packages/remnic-core/src/cli.ts:1810` — "// ---------------------------------------------------------------------------"

### iso-duration-normalization
- `packages/remnic-core/src/cli.ts:2316` — "// Calendar units are normalized for retention policy use: 1Y=365D, 1M=30D."

### weclone-optional-dynamic-import
- `packages/remnic-core/src/cli.ts:3160` — "// weclone — imported via a computed specifier so the TypeScript dts"

### bulk-import-pipeline-invariants
- `packages/remnic-core/src/cli.ts:3202` — "// Guard: library callers that invoke `runBulkImportCliCommand` without an"
- `packages/remnic-core/src/cli.ts:3240` — "// Defensive fallback: the pipeline never calls processBatch in dryRun"

### cli-confirm-validation-ordering
- `packages/remnic-core/src/cli.ts:3997` — "// --confirm guard: must be literally "yes" to execute mutations."

### cli-safe-defaults
- `packages/remnic-core/src/cli.ts:4220` — "// Default to a non-destructive dry run unless --apply is given."
- `packages/remnic-core/src/cli.ts:8367` — "// Rule #51: reject contradictory flags rather than silently picking one."

### rebuild-inert-apply-semantics
- `packages/remnic-core/src/cli.ts:4231` — "// Include `applied: false` so the inert JSON payload carries the SAME"
- `packages/remnic-core/src/cli.ts:4245` — "// Exit-code parity with the enabled path (cursor Medium — NFb5W): an"
- `packages/remnic-core/src/cli.ts:4262` — "// Mirror the non-JSON failure signal (round 6, codex P2 — NEFoa): an"
- `packages/remnic-core/src/cli.ts:4293` — "// An --apply that could not acquire the cross-process rebuild lock"

### capsule-export-includekinds
- `packages/remnic-core/src/cli.ts:4516` — "// Pass `includeKinds` only when the user explicitly provided it."

### capsule-path-resolution
- `packages/remnic-core/src/cli.ts:4612` — "// Resolve archive path — same 3-step precedence as `capsule inspect`"
- `packages/remnic-core/src/cli.ts:4830` — "// Resolve archive path."

### capsule-encrypted-precheck
- `packages/remnic-core/src/cli.ts:4645` — "// Reject encrypted archives before attempting gunzip — mergeCapsule"

### capsule-store-error-handling
- `packages/remnic-core/src/cli.ts:4705` — "// Track whether --dir was explicitly supplied so we can give a clear"
- `packages/remnic-core/src/cli.ts:4721` — "// User explicitly provided --dir <path>: any error (including"
- `packages/remnic-core/src/cli.ts:4728` — "// Default capsulesDir: ENOENT means the directory hasn't been"

### capsule-inspect-sidecar-preference
- `packages/remnic-core/src/cli.ts:4881` — "// Prefer sidecar manifest for cheap inspection."

### bulk-import-namespace-anchor
- `packages/remnic-core/src/cli.ts:5132` — "// Ask the orchestrator for the EXACT namespace bulk-import will"

### cli-strict-input-validation
- `packages/remnic-core/src/cli.ts:5518` — "// Disclosure validation (CLAUDE.md rule 51): explicit values"
- `packages/remnic-core/src/cli.ts:5531` — "// Top-K validation: positive integer or undefined. Reject"
- `packages/remnic-core/src/cli.ts:5557` — "// Strict --format validation: reject unrecognized values"
- `packages/remnic-core/src/cli.ts:5574` — "// Issue #680 — `--as-of` validation at the input boundary"
- `packages/remnic-core/src/cli.ts:6000` — "// Validate --format early so we can error before doing I/O."

### recall-rendering-surfaces
- `packages/remnic-core/src/cli.ts:5646` — "// Plain-text rendering. Keep this terse — the JSON format is"

### cli-pure-helpers-testability
- `packages/remnic-core/src/cli.ts:5743` — "// Commander passes positional args first, then the options"

### cli-engram-access-service-paths
- `packages/remnic-core/src/cli.ts:5754` — "// Delegate through `EngramAccessService` to the orchestrator's atomic"

### connectors-shared-closures
- `packages/remnic-core/src/cli.ts:6013` — "// Route to the matching built-in connector."

### http-server-first-init
- `packages/remnic-core/src/cli.ts:6791` — "// Start the HTTP server FIRST so the port is available immediately,"
- `packages/remnic-core/src/cli.ts:6826` — "// Initialize the orchestrator AFTER the HTTP server is listening."

### rebuild-namespace-routing
- `packages/remnic-core/src/cli.ts:7030` — "// Route BOTH the undefined/default and explicit namespace through the"

### dedupe-corpus-bump
- `packages/remnic-core/src/cli.ts:7498` — "// Per-delete corpus bump (Cursor Medium, #1902): dedupe removes"

### transcript-day-window
- `packages/remnic-core/src/cli.ts:8329` — "// Read specific date. Use a half-open [start, next-day-00:00:00Z)"
- `packages/remnic-core/src/cli.ts:8341` — "// Default: show today's transcript. Same half-open day window as"
