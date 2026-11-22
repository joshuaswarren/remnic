# Source ingestion fails loud at schema boundaries and records every degradation explicitly

Status: accepted

## Context
Remnic ingests personal data from many external sources (X, Granola, Limitless, Omi,
Bee, Fireflies, Reitti, chat exports) into one memory store. A silent failure here is the
worst outcome: a dropped page looks like a quiet day, and the user's memory permanently
misses data they believe was captured. At the same time, sources genuinely degrade —
rate limits, deleted notes, expired sessions, credit caps, aborted requests — and the
sync must distinguish real outages from expected absences, spend paid-API budget only
where authorized, and never leak credentials or raw error text. Each connector also owns
provider quirks: keyset pagination that skips rows if advanced by filtered counts,
newest-first pages that can stop early, hosts that keep tokens exported for other tools.

## Decision
Ingestion sources obey one contract: validate the schema at the boundary, fail loud
on backend violations, classify expected degradation explicitly, and report everything:

- A response that violates the source's schema (missing required id, `hasMore: true` with
  no cursor) rejects the whole page — rows are never silently dropped while the cursor
  advances over an incomplete day. Boundary data stays `unknown` until each field is
  narrowed and re-checked by the normalizer; unresolvable starts drop the record rather
  than emitting a silently-broken value, and invalid timing keeps a segment's usable text.
- Expected, documented degradations are explicit: a 404'd Granola note is gone (skip; any
  other failure rethrows as a source failure, not a quiet day); a Reitti empty timeline is
  an explicit empty result distinct from failure; Omi's normalizer honors a never-throw
  zone contract (unknown timezone resolves to a UTC day instead of core's fail-fast
  RangeError); a caller-driven abort is cancellation, not provider unavailability; X
  source-level degradation lands in the sync report and exit status — never a throw.
- Pagination is correctness-preserving: Bee stops once an entire newest-first page
  predates the requested day; Fireflies advances the keyset by the RAW page size so
  dropped rows never truncate the day; X stops on a page of entirely-known posts; Limitless
  retries the same cursor with a lighter payload on timeout, keeping the learned size;
  Granola fetches per-note detail sequentially to respect the rate limit.
- Retry discipline: only read-only POST endpoints are retryable (state-mutating writes
  never retry, preventing duplicate side effects); `Retry-After` is honored only in the
  RFC seconds form so a malformed prefix cannot become a long sleep, with a backoff cap so
  a hostile header cannot stall a sync for minutes.
- Credentials and surface hygiene: API keys resolve lazily at call time (status works
  without credentials; env changes apply without restart); the local Bee proxy is
  unauthenticated by design and never attaches a Bearer header (a user's exported direct
  token must not 401 proxy requests); Omi error messages are scrubbed to name + code so
  raw network/Node text never reaches operators, with mode-specific auth hints; the X
  token store refreshes under a file lock, re-reads state after waiting (another owner may
  have rotated), steals only stale locks, and writes atomically preserving unknown fields.
- X-specific discipline: config parsing is strict (invalid values rejected, never
  reinterpreted); payload fields stay `unknown` after narrowing; dedupe fingerprints are
  computed over recursively key-sorted JSON so source key order never changes identity;
  sync ordering falls back to id for stable output; a corrupt state file is quarantined
  and replaced (it only costs dedupe history) rather than failing the sync; corpus
  symlinks may not escape the corpus root; zero-credit sources never consume the paid
  budget; MCP sessions re-initialize once on session-id rejection; records map to memories
  through the documented tag/category mapping behind a trust-gated file-sink layout;
  speaker identity keys are stable across provider lifelogs (person_id, then speaker_id,
  then diarization label; the wearer is always "user", keyed by provider name for other
  speakers).
- Chat-import parsers (ChatGPT) follow the same boundary rules: missing payloads are
  user-facing errors, never silent zero-memory successes; strict mode rejects objects with
  no recognized sections instead of returning empty structs; export arrays are classified
  by scanning the full array for the first recognized shape (a leading tombstone must not
  defeat the classifier and drop every later entry); user turns follow the
  current_node-to-parent conversation chain, falling back to a timestamp-sorted traversal
  of all nodes only when the chain is broken — abandoned branches are excluded, never
  silently included.

## Consequences
A sync report is a trustworthy account: every skip, degradation, and budget spend is
visible, and a schema violation stops the day instead of corrupting it. Users can keep
tokens exported for other tools without breaking the local proxy, and corrupted auxiliary
state never blocks fresh data. The costs: strict schema rejection can pause ingestion on
backend bugs until fixed (by design), conservative pagination may re-fetch known pages to
guarantee completeness, and each connector carries its own classification logic rather
than sharing one generic retry policy.

Theme coverage: Records under the connector, X-source, hermes-provider, and chat-import topics.

## Origin comments
- `packages/coding-graph/src/lsp/client.test.ts:1` — "/** * The fake server is a checked-in Node script speaking canned JSON-RPC * over stdio (synthetic responses o"
- `packages/connector-bee/src/index.ts:78` — "// The local proxy is unauthenticated by design — never attach a"
- `packages/connector-bee/src/index.ts:79` — "// Bearer header there, even when a direct-mode token sits in the"
- `packages/connector-bee/src/index.ts:80` — "// environment (it would 401 proxy requests for users who keep"
- `packages/connector-bee/src/index.ts:81` — "// BEE_API_TOKEN exported for occasional direct use)."
- `packages/connector-bee/src/index.ts:121` — "// Stop paginating once an entire (newest-first) page predates the"
- `packages/connector-bee/src/index.ts:122` — "// requested day; anything deeper is older still."
- `packages/connector-fireflies/src/index.ts:69` — "// Key resolution happens lazily at call time (not factory time) so"
- `packages/connector-fireflies/src/index.ts:70` — "// `wearables status` works without credentials and env changes take"
- `packages/connector-fireflies/src/index.ts:71` — "// effect without a restart; the client constructor throws the"
- `packages/connector-fireflies/src/index.ts:72` — "// actionable missing-key message."
- `packages/connector-fireflies/src/index.ts:106` — "// Advance the keyset by the raw page size (not the id-filtered count)"
- `packages/connector-fireflies/src/index.ts:107` — "// while full pages keep coming, so dropped rows never truncate the day."
- `packages/connector-granola/src/client.ts:145` — "// `id` is required by the List Notes schema; a row missing it is a"
- `packages/connector-granola/src/client.ts:146` — "// backend/schema failure. Reject the page rather than silently dropping"
- `packages/connector-granola/src/client.ts:147` — "// rows and advancing the cursor over an incomplete day (§22)."
- `packages/connector-granola/src/client.ts:158` — "// A `hasMore: true` page with no usable cursor is a malformed pagination"
- `packages/connector-granola/src/client.ts:159` — "// response; fail loudly rather than silently sync a partial day (§22)."
- `packages/connector-granola/src/client.ts:174` — "// Validated boundary: `id` is confirmed a string above; every other field"
- `packages/connector-granola/src/client.ts:175` — "// is optional and the normalizer re-checks each. Cast through `unknown`"
- `packages/connector-granola/src/client.ts:176` — "// because the external JSON shape can't be proven structurally here."
- `packages/connector-granola/src/index.ts:92` — "// The list returns summaries only; each note's transcript/summary/timing"
- `packages/connector-granola/src/index.ts:93` — "// needs a per-note fetch. Fetch sequentially to respect the 5 req/s rate"
- `packages/connector-granola/src/index.ts:94` — "// limit (the client also backs off on 429)."
- `packages/connector-granola/src/index.ts:101` — "// A note that 404s (deleted / no longer summarized) is gone, not a"
- `packages/connector-granola/src/index.ts:102` — "// backend outage — skip it. Any other failure is real; rethrow so it"
- `packages/connector-granola/src/index.ts:103` — "// reads as a source failure, not a quiet day (AGENTS.md §22)."
- `packages/connector-granola/src/index.ts:108` — "// Drop a record with no resolvable start rather than emit an empty"
- `packages/connector-granola/src/index.ts:109` — "// startIso that fails downstream parsing silently."
- `packages/connector-limitless/src/client.ts:28` — "/** Backoff cap so a hostile retryAfter can't stall a sync for minutes. */"
- `packages/connector-limitless/src/client.ts:139` — "// The markdown rendering duplicates what `contents` carries and"
- `packages/connector-limitless/src/client.ts:140` — "// inflates payloads; segments come from `contents`."
- `packages/connector-limitless/src/client.ts:158` — "// Retry the SAME cursor with a lighter payload; the caller still drains"
- `packages/connector-limitless/src/client.ts:159` — "// every nextCursor. Keep the learned size for subsequent pages."
- `packages/connector-limitless/src/index.ts:54` — "// Key resolution happens lazily at call time (not factory time) so"
- `packages/connector-limitless/src/index.ts:55` — "// `wearables status` works without credentials and env changes take"
- `packages/connector-limitless/src/index.ts:56` — "// effect without a restart; the client constructor throws the"
- `packages/connector-limitless/src/index.ts:57` — "// actionable missing-key message."
- `packages/connector-limitless/src/normalize.ts:57` — "// The wearer's stable key is "user"; other speakers key by the"
- `packages/connector-limitless/src/normalize.ts:58` — "// provider name so saved names survive across lifelogs and the"
- `packages/connector-limitless/src/normalize.ts:59` — "// registry can re-label "Speaker 2" everywhere at once."
- `packages/connector-omi/src/client.ts:278` — "// The auth chain yields distinct, actionable detail strings."
- `packages/connector-omi/src/client.ts:279` — "// Legacy integration mode can also surface app/user capability"
- `packages/connector-omi/src/client.ts:280` — "// failures, so keep those hints mode-specific."
- `packages/connector-omi/src/client.ts:298` — "// OmiApiError messages are our own constructed strings (already"
- `packages/connector-omi/src/client.ts:299` — "// scrubbed — network text is reduced to name + code inside"
- `packages/connector-omi/src/client.ts:300` — "// requestJson); foreign errors reduce to name + errno code so raw"
- `packages/connector-omi/src/client.ts:301` — "// Node text (paths, loader stacks) never reaches operator"
- `packages/connector-omi/src/client.ts:302` — "// surfaces."
- `packages/connector-omi/src/index.ts:79` — "// Construction is lazy so `wearables status` works without"
- `packages/connector-omi/src/index.ts:80` — "// credentials; the client constructor throws the actionable"
- `packages/connector-omi/src/index.ts:81` — "// missing-credential messages at call time."
- `packages/connector-omi/src/normalize.ts:51` — "// Keep this package's documented never-throw zone contract (see"
- `packages/connector-omi/src/normalize.ts:52` — "// `timezoneOffsetIso`): an unknown zone resolves to a UTC day instead of"
- `packages/connector-omi/src/normalize.ts:53` — "// surfacing core's fail-fast RangeError."
- `packages/connector-omi/src/normalize.ts:149` — "// person_id is the most stable key when the user has tagged the"
- `packages/connector-omi/src/normalize.ts:150` — "// speaker as a known person in Omi. The Developer API's"
- `packages/connector-omi/src/normalize.ts:151` — "// speaker_id is the next best stable key, then the diarization"
- `packages/connector-omi/src/normalize.ts:152` — "// label."
- `packages/connector-omi/src/normalize.ts:184` — "// Invalid/out-of-range timing must not discard the segment's usable text."
- `packages/connector-reitti/src/index.ts:130` — "// A caller-driven abort is cancellation, not provider unavailability."
- `packages/connector-reitti/src/index.ts:165` — "// Empty day vs failure (§22): a valid empty timeline is an explicit"
- `packages/connector-reitti/src/index.ts:166` — "// empty result; the visits fallback, when enabled, is a second page."
- `packages/connector-reitti/src/normalize.ts:52` — "/** * `fallbackKey` discriminates places Reitti left without an id: a shared * `unknown` id would let core's segment ..."
- `packages/connector-x/src/cli.ts:118` — "// Skips are expected degradation (credits, caps), not failures."
- `packages/connector-x/src/config.ts:1` — "/** * Strict parser for the `xConnector` config block (issue #2009). * * Invalid values are rejected, never silently rei"
- `packages/connector-x/src/file-sink.ts:1` — "/** * Default on-disk memory sink: `suggest` mode writes review-queue * files under `<stateDir>/suggestions/`, `store` m"
- `packages/connector-x/src/guards.ts:1` — "/** * Canonical unknown-payload guard for @remnic/connector-x. * * Fields stay `unknown` after narrowing; every field re"
- `packages/connector-x/src/mcp-client.test.ts:25` — "/** * Request-driven fake X MCP server: initialize and notifications always * succeed, tools/call pops the next scripted"
- `packages/connector-x/src/mcp-client.ts:141` — "/** * Calls an MCP tool. Re-initializes once when the server rejects the * session id (e.g. expired session), then retri"
- `packages/connector-x/src/mcp-client.ts:193` — "// Session expired server-side: drop it and retry once on a fresh session."
- `packages/connector-x/src/normalize.ts:1` — "/** * Payload normalization for all three X sources plus the shared * dedupe fingerprint and the record → memory mapping"
- `packages/connector-x/src/normalize.ts:16` — "/** Sorts keys recursively so key order never changes the fingerprint. */"
- `packages/connector-x/src/normalize.ts:30` — "/** Identity fingerprint: same post + same content = same memory, regardless of source key order. */"
- `packages/connector-x/src/normalize.ts:218` — "/** * Record → memory mapping (issue #2009 §2): * - bookmarks → tag `x/bookmark`, category `reference` (carries a URL) o"
- `packages/connector-x/src/sources.ts:1` — "/** * Pluggable X sources (issue #2009): official X MCP (paid, budget- * capped), a local corpus directory (zero credits"
- `packages/connector-x/src/sources.ts:84` — "/** Zero-credit sources never consume budget. */"
- `packages/connector-x/src/sources.ts:182` — "// Stop-on-known: a page of entirely known posts means everything"
- `packages/connector-x/src/sources.ts:183` — "// deeper is older state we already ingested."
- `packages/connector-x/src/sources.ts:262` — "// Containment: a symlink may not point outside the corpus root."
- `packages/connector-x/src/sync.ts:1` — "/** * Sync orchestration (issue #2009): run sources in configured priority * order (cheapest first is the recommended ar"
- `packages/connector-x/src/sync.ts:122` — "// A corrupt state file only costs dedupe history (re-fetch, re-dedupe):"
- `packages/connector-x/src/sync.ts:123` — "// quarantine it and start fresh rather than failing the sync."
- `packages/connector-x/src/sync.ts:156` — "// Total comparator: fall back to id so equal keys keep a stable order."
- `packages/connector-x/src/sync.ts:183` — "/** Runs one sync cycle. Source-level degradation lands in the report, never a throw. */"
- `packages/connector-x/src/token-store.ts:125` — "/** * Refreshes the token pair under the file lock. When another owner * holds the lock, waits for it, then adopts the p"
- `packages/connector-x/src/token-store.ts:146` — "// Re-read under the lock: another owner may have rotated while we waited."
- `packages/connector-x/src/token-store.ts:208` — "/** Steals the lock when its mtime is older than lockStaleMs. */"
- `packages/connector-x/src/token-store.ts:214` — "// Lock vanished between open(EEXIST) and stat — retry create."
- `packages/connector-x/src/token-store.ts:291` — "// Files without expiry force one refresh on first use."
- `packages/connector-x/src/token-store.ts:296` — "/** Atomic 0600 write; preserves unknown top-level fields from the prior file. */"
- `packages/hermes-provider/src/index.ts:382` — "// Skip retries for state-mutating writes to prevent duplicate side effects."
- `packages/hermes-provider/src/index.ts:383` — "// Read-only POST endpoints (recall, lcm/search) are safe to retry."
- `packages/hermes-provider/src/index.ts:431` — "// Only use the RFC seconds form when the entire header is digits."
- `packages/hermes-provider/src/index.ts:432` — "// Date-like or malformed values such as "60 seconds" are ignored"
- `packages/hermes-provider/src/index.ts:433` — "// so parseInt() cannot turn a prefix into a long sleep."
- `packages/import-chatgpt/src/parser.test.ts:115` — "// Cursor review on PR #595 — strict mode should reject object payloads"
- `packages/import-chatgpt/src/parser.test.ts:116` — "// that have none of the recognized ChatGPT export sections rather than"
- `packages/import-chatgpt/src/parser.test.ts:117` — "// silently returning an empty struct."
- `packages/import-chatgpt/src/parser.test.ts:131` — "// Cursor review on PR #595 — collectUserTurnsFromConversation should"
- `packages/import-chatgpt/src/parser.test.ts:132` — "// follow the current_node → parent chain rather than flattening every"
- `packages/import-chatgpt/src/parser.test.ts:133` — "// node in the mapping, which would include abandoned branches."
- `packages/import-chatgpt/src/parser.test.ts:297` — "// Codex review on PR #595 — when current_node's parent chain is broken"
- `packages/import-chatgpt/src/parser.test.ts:298` — "// (dangling reference to a node that doesn't exist in mapping),"
- `packages/import-chatgpt/src/parser.test.ts:299` — "// followCurrentNodeChain must return [] rather than a partial tail, so"
- `packages/import-chatgpt/src/parser.test.ts:300` — "// the caller falls back to a timestamp-sorted traversal of ALL nodes."
- `packages/import-chatgpt/src/parser.test.ts:336` — "// Codex review on PR #595 — parseChatGPTExport MUST reject undefined /"
- `packages/import-chatgpt/src/parser.test.ts:337` — "// null input (what runImportCommand passes when --file is omitted) with"
- `packages/import-chatgpt/src/parser.test.ts:338` — "// a user-facing error. Silently returning 0 memories masks bad CLI"
- `packages/import-chatgpt/src/parser.test.ts:339` — "// invocations. Matches the gemini/claude slices."
- `packages/import-chatgpt/src/parser.ts:121` — "// File-backed adapter contract: `runImportCommand` passes `undefined`"
- `packages/import-chatgpt/src/parser.ts:122` — "// when `--file` is omitted. ChatGPT is a file-only importer — a"
- `packages/import-chatgpt/src/parser.ts:123` — "// missing payload MUST surface as a user-facing error rather than"
- `packages/import-chatgpt/src/parser.ts:124` — "// silently succeeding with 0 memories. Codex review on PR #595."
- `packages/import-chatgpt/src/parser.ts:138` — "// Shape 1: a top-level array. ChatGPT's `conversations.json` is literally"
- `packages/import-chatgpt/src/parser.ts:139` — "// an array of conversations. Older memory exports are also arrays (each"
- `packages/import-chatgpt/src/parser.ts:140` — "// entry a ChatGPTSavedMemory). A leading tombstone / malformed element"
- `packages/import-chatgpt/src/parser.ts:141` — "// (null, {}, etc.) would defeat a `raw[0]`-only classifier and cause us"
- `packages/import-chatgpt/src/parser.ts:142` — "// to silently drop every later valid entry. Scan the full array for the"
- `packages/import-chatgpt/src/parser.ts:143` — "// first recognized shape instead. Codex review on PR #595."
- `packages/import-chatgpt/src/parser.ts:219` — "// Strict mode: if the object has none of the recognized sections, bail"
- `packages/import-chatgpt/src/parser.ts:220` — "// rather than silently returning an empty result. Non-strict mode keeps"
- `packages/import-chatgpt/src/parser.ts:221` — "// the lenient "returns empty struct" behavior for future-shape safety."
