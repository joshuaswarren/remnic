# The WeClone proxy routes by normalized pathname and forwards payload bytes faithfully; training export stays deterministic and privacy-first

Status: accepted

## Context
The WeClone connector runs an OpenAI-compatible local proxy in front of a
self-hosted WeClone API and a training-export pipeline over the same conversation data.
Three forces shaped it: OpenAI-compatible SDK clients vary in ways the proxy must absorb
(query strings like Azure's `api-version`, trailing slashes, configured base paths,
binary/multipart bodies on the transparent path); malformed client payloads must fail as
structured 400s, not 500s; and CodeQL-class complexity bugs (polynomial ReDoS from regex
quantifier backtracking) are a real risk in a long-running proxy. The export side has its
own constraints: PII redaction ordering changes what survives, and synthesized training
records must be reproducible.

## Decision
The proxy preserves client payload fidelity and fails structurally; export derives
everything deterministically from the record:

- Route matching uses the request PATHNAME — query string stripped, trailing slash
  normalized for matching only — so clients appending `?api-version=...` or trailing
  slashes still hit the chat route instead of falling through to the transparent proxy.
  Query strings are preserved on forwarding.
- When the configured `wecloneApiUrl` carries a path prefix (e.g. `/v1`,
  `/weclone/v1`), that prefix is the upstream mount point: `/v1/<rest>` rewrites to
  `<basePath>/<rest>`; with no prefix the standard OpenAI `/v1/chat/completions` is used.
- The transparent proxy path forwards raw bytes — read from the IncomingMessage as bytes
  and copied into a plain ArrayBuffer for BodyInit compatibility — so binary and
  multipart uploads are never corrupted by re-encoding.
- Chat bodies are validated before use: `messages` must be an array of plain objects
  (malformed payloads return a structured 400, never a 500), content-parts arrays stay
  untyped with validation at each use site, and non-object entries are dropped rather
  than crashing `.map()`. Only the FIRST system message is rewritten with injected
  memory (or prepended when none exists); subsequent system messages forward verbatim.
- Upstream error responses pass through as-is without forced SSE headers, and
  response headers are filtered (e.g. `content-encoding` is never forwarded to the
  client).
- Side observations (recall, memory writes) are fire-and-forget: errors are caught and
  discarded so observation latency or failure never affects the proxied request.
- All URL/text normalization avoids ReDoS-prone regex: trailing-slash stripping uses a
  linear loop, tokenizer edge-punctuation stripping uses linear scans instead of regex
  chains, and the topic regex excludes nested parens to prevent quadratic backtracking.
- CLI config resolution parses `--config` first so an explicit path wins over env-var
  resolution; test servers listen on port 0; adapter registration is idempotent and
  import-safe (side-effect registration wrapped so a failure cannot break unrelated CLI
  startup).
- PII redaction applies an ORDERED pattern list — more specific patterns (SSN, credit
  card) before broader ones, and longest candidate-first so valid long card numbers
  survive while shorter cards next to numeric metadata are still reconsidered.
- Style markers match on word boundaries (so `tho` never matches inside `those`),
  require at least two markers before declaring a style, count each marker once per
  sample, and sort by count descending then alphabetically for stability. Template
  selection for synthesized records is deterministic; category comes from the record's
  own category field — never parsed out of natural-language instruction text, which
  always fell back to a placeholder topic.

## Consequences
The proxy behaves identically across OpenAI-compatible client quirks, never corrupts
non-JSON bodies, and turns malformed input into diagnosable 400s; exported training data
is reproducible and PII redaction is order-stable. The costs: the pathname matcher must be
updated for new route shapes rather than pattern-matching full URLs, base-path rewriting
assumes the configured prefix IS the mount point, and regex-free scanners are more code
than the one-line regexes they replace — accepted deliberately to close the ReDoS
class.

Theme coverage: Records under the WeClone proxy, export, style, synthesizer, and redos topics.

## Origin comments
- `packages/connector-weclone/src/cli.ts:61` — "// Parse --config first so an explicit path takes precedence over env-var"
- `packages/connector-weclone/src/cli.ts:62` — "// resolution. Only fall back to defaultConfigPath() when the user has not"
- `packages/connector-weclone/src/cli.ts:63` — "// supplied an explicit --config flag. This lets `remnic-weclone-proxy"
- `packages/connector-weclone/src/cli.ts:64` — "// --config /abs/path` work even in environments where REMNIC_HOME is"
- `packages/connector-weclone/src/cli.ts:65` — "// misconfigured, without defaultConfigPath() (and any env-var validation"
- `packages/connector-weclone/src/cli.ts:66` — "// it contains) running unnecessarily."
- `packages/connector-weclone/src/proxy.test.ts:13` — "/** * Create a mock HTTP server that responds with a fixed body for any request. * Listens on port 0 (OS-assigned) to av"
- `packages/connector-weclone/src/proxy.test.ts:951` — "// Config with trailing slash -- should NOT produce /v1//chat/completions"
- `packages/connector-weclone/src/proxy.test.ts:1347` — "// The proxy must NOT forward content-encoding to the client."
- `packages/connector-weclone/src/proxy.test.ts:1414` — "// Simulate Azure-OpenAI style query string; route matching must not fall"
- `packages/connector-weclone/src/proxy.test.ts:1415` — "// through to the transparent proxy."
- `packages/connector-weclone/src/proxy.test.ts:1556` — "// Trailing slash must not produce `//engram/v1/recall`."
- `packages/connector-weclone/src/proxy.test.ts:1885` — "// Dynamic import to avoid circular dependency issues"
- `packages/connector-weclone/src/proxy.ts:65` — "/** * Read the entire body of an IncomingMessage as raw bytes. * Used for the transparent proxy path to avoid corrupting"
- `packages/connector-weclone/src/proxy.ts:218` — "/** * Fire-and-forget observation to the Remnic daemon. * Errors are caught and silently discarded to avoid adding laten"
- `packages/connector-weclone/src/proxy.ts:307` — "/** * Strip trailing slashes from a URL without using a regex quantifier * on the same character, which CodeQL flags as "
- `packages/connector-weclone/src/proxy.ts:331` — "// Fallback: strip trailing path components without ReDoS-prone regex."
- `packages/connector-weclone/src/proxy.ts:390` — "/** * Forward a request transparently to the WeClone API. * * If the configured WeClone URL has a non-empty base path (e"
- `packages/connector-weclone/src/proxy.ts:415` — "// The proxy exposes an OpenAI-compatible `/v1/...` surface. When the"
- `packages/connector-weclone/src/proxy.ts:416` — "// configured `wecloneApiUrl` itself already ends in `/v1` (or any"
- `packages/connector-weclone/src/proxy.ts:417` — "// path prefix), treat the configured prefix as the upstream mount"
- `packages/connector-weclone/src/proxy.ts:418` — "// point and rewrite `/v1/<rest>` to `<basePath>/<rest>`."
- `packages/connector-weclone/src/proxy.ts:446` — "// Copy into a plain ArrayBuffer so the forwarded request keeps the exact"
- `packages/connector-weclone/src/proxy.ts:447` — "// byte payload while remaining compatible with this package's BodyInit"
- `packages/connector-weclone/src/proxy.ts:448` — "// typing during declaration builds."
- `packages/connector-weclone/src/proxy.ts:486` — "// Normalize upstream URLs: strip trailing slashes to prevent double-slash"
- `packages/connector-weclone/src/proxy.ts:487` — "// when appending path segments. Use a loop (not regex) to avoid the"
- `packages/connector-weclone/src/proxy.ts:488` — "// polynomial-ReDoS class flagged by CodeQL for `/\/+$/`."
- `packages/connector-weclone/src/proxy.ts:491` — "// Pre-split the WeClone URL so transparentProxy and the chat path can"
- `packages/connector-weclone/src/proxy.ts:492` — "// honor a configured base path (e.g. "/weclone/v1")."
- `packages/connector-weclone/src/proxy.ts:516` — "// Parse the request URL into a pathname (stripping query string and"
- `packages/connector-weclone/src/proxy.ts:517` — "// normalizing trailing slash). Using pathname for route matching avoids"
- `packages/connector-weclone/src/proxy.ts:518` — "// silently falling through when clients append query params like"
- `packages/connector-weclone/src/proxy.ts:519` — "// `?api-version=2023-05-15` (common with Azure OpenAI-compatible SDKs)."
- `packages/connector-weclone/src/proxy.ts:523` — "// Normalize trailing slash for route matching only (not for forwarding)."
- `packages/connector-weclone/src/proxy.ts:577` — "// Validate `messages` is an array with object entries before use so"
- `packages/connector-weclone/src/proxy.ts:578` — "// malformed payloads (`messages: "..."`, `messages: {}`, etc.) return"
- `packages/connector-weclone/src/proxy.ts:579` — "// a structured 400 instead of surfacing as a 500 internal error."
- `packages/connector-weclone/src/proxy.ts:590` — "// Messages may contain multimodal content-parts arrays; keep them"
- `packages/connector-weclone/src/proxy.ts:591` — "// untyped and validate strings at each use site. Drop entries that"
- `packages/connector-weclone/src/proxy.ts:592` — "// are not plain objects so downstream `.map()` cannot throw."
- `packages/connector-weclone/src/proxy.ts:605` — "// Recall memories (graceful degradation on failure)"
- `packages/connector-weclone/src/proxy.ts:625` — "// Build the forwarded messages array. Only the *first* system message"
- `packages/connector-weclone/src/proxy.ts:626` — "// is rewritten with injected memory (or, if no system exists, a"
- `packages/connector-weclone/src/proxy.ts:627` — "// synthetic system message is prepended). Subsequent system messages"
- `packages/connector-weclone/src/proxy.ts:628` — "// are forwarded verbatim so distinct system instructions are not"
- `packages/connector-weclone/src/proxy.ts:629` — "// silently overwritten."
- `packages/connector-weclone/src/proxy.ts:666` — "// Forward to WeClone. If `wecloneApiUrl` has a path prefix (the"
- `packages/connector-weclone/src/proxy.ts:667` — "// common `/v1` or custom mounts like `/weclone/v1`), forward to"
- `packages/connector-weclone/src/proxy.ts:668` — "// `${basePath}/chat/completions`. If the configured URL has no"
- `packages/connector-weclone/src/proxy.ts:669` — "// base path at all, default to the standard OpenAI `/v1/chat/completions`."
- `packages/connector-weclone/src/proxy.ts:670` — "// Preserve any query string on the incoming request (e.g. Azure's"
- `packages/connector-weclone/src/proxy.ts:671` — "// `?api-version=...`) so version selectors and tenant hints reach"
- `packages/connector-weclone/src/proxy.ts:672` — "// upstream unchanged."
- `packages/connector-weclone/src/proxy.ts:693` — "// If upstream returned an error, pass through as-is (don't force SSE headers)"
- `packages/connector-weclone/src/proxy.ts:867` — "// Use raw bytes to avoid corrupting binary/multipart uploads."
- `packages/export-weclone/src/index.ts:27` — "/** * Idempotently register the WeClone adapter with the core training-export * registry. Callable multiple times withou"
- `packages/export-weclone/src/index.ts:49` — "// Side-effect registration: importing this module registers the adapter."
- `packages/export-weclone/src/index.ts:50` — "// Callers that need to manage registration manually (e.g. tests that call"
- `packages/export-weclone/src/index.ts:51` — "// `clearTrainingExportAdapters()`) can re-invoke"
- `packages/export-weclone/src/index.ts:52` — "// `ensureWecloneExportAdapterRegistered()` after clearing."
- `packages/export-weclone/src/index.ts:54` — "// The try/catch keeps import-time errors from breaking unrelated callers —"
- `packages/export-weclone/src/index.ts:55` — "// the adapter surfaces `formatRecords` purely, so a failure here would be"
- `packages/export-weclone/src/index.ts:56` — "// surprising, but defensive coding keeps CLI startup resilient."
- `packages/export-weclone/src/privacy.ts:1` — "/** * PII privacy sweep for training export records. * * Belt-and-suspenders check that runs after Remnic's own * privac"
- `packages/export-weclone/src/privacy.ts:59` — "/** * Ordered list of PII patterns. * * Order matters: more specific patterns (SSN, credit card) * come before broader o"
- `packages/export-weclone/src/privacy.ts:77` — "// Try longest candidates first so valid 19-digit cards are preserved while"
- `packages/export-weclone/src/privacy.ts:78` — "// shorter cards next to numeric metadata can still be reconsidered."
- `packages/export-weclone/src/style-extractor.ts:1` — "/** * Communication style marker extraction. * * Analyzes text samples using simple heuristics to produce * a StyleMarke"
- `packages/export-weclone/src/style-extractor.ts:141` — "// Word-boundary matching prevents false positives"
- `packages/export-weclone/src/style-extractor.ts:142` — "// (e.g., "tho" matching inside "those" or "method")"
- `packages/export-weclone/src/style-extractor.ts:151` — "// Threshold: need at least 2 markers to declare a style"
- `packages/export-weclone/src/style-extractor.ts:177` — "/** * Check whether a character is alphanumeric (ASCII a-z, A-Z, 0-9) using * code-point comparison. Pure function — no "
- `packages/export-weclone/src/style-extractor.ts:190` — "/** * Strip leading and trailing non-alphanumeric characters from `word` using * a single linear scan on each side. This"
- `packages/export-weclone/src/style-extractor.ts:208` — "// Tokenize: split on whitespace, strip edge punctuation with a linear"
- `packages/export-weclone/src/style-extractor.ts:209` — "// scan (no regex) to eliminate the polynomial backtracking that the"
- `packages/export-weclone/src/style-extractor.ts:210` — "// previous `replace(/^[^a-zA-Z0-9]+/, "")` chain exposed."
- `packages/export-weclone/src/style-extractor.ts:221` — "// Only count once per sample to avoid inflating from repetition within one sample"
- `packages/export-weclone/src/style-extractor.ts:230` — "// Filter by minimum frequency and sort by count descending, then alphabetical for stability"
- `packages/export-weclone/src/synthesizer.test.ts:485` — "// Regression: /\(([^)]+)\)/ causes O(n^2) backtracking on inputs"
- `packages/export-weclone/src/synthesizer.test.ts:486` — "// with many '((' because [^)] matches '('. Fixed to /\(([^()]+)\)/."
- `packages/export-weclone/src/synthesizer.test.ts:514` — "// Regression test: the old bug had parseCategory(record.instruction) which"
- `packages/export-weclone/src/synthesizer.test.ts:515` — "// always fell back to subTopic="this" because instructions are natural"
- `packages/export-weclone/src/synthesizer.test.ts:516` — "// language, not category paths. Now we use record.category for template"
- `packages/export-weclone/src/synthesizer.test.ts:517` — "// selection and extract tags from instruction for the topic."
- `packages/export-weclone/src/synthesizer.ts:24` — "/** * Question templates keyed by template group. * Each array provides variety; the synthesizer picks * based on rec..."
