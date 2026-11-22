# Text, diff, and subprocess boundaries parse defensively and fail loudly or fail open — never silently

Status: accepted

## Context
Reviews and CLI flows consume untrusted text and external processes: git diffs with C-quoted paths, advisory payloads, console recordings, Commander option objects displaced by stray positionals, and operator-configured binaries. Regex backtracking (CodeQL ReDoS findings), escaped quotes, and silent defaults each caused real bugs — dropped path halves, undiscoverable imports, publishing with defaults.

## Decision
(Smaller related decisions are stated together; each origin record below supports its rule.)
- Diff path parsing: strip C-quotes BEFORE checking `a/`/`b/` prefixes (otherwise `"a/path with spaces.ts"` never matches), then normalize Windows backslashes AFTER quote stripping so escape pairs decode first; parse the two paths with an explicit whitespace-aware tokenizer instead of `\S+` (quoted paths with spaces are not split at the first internal space); trailing space/tab is trimmed linearly, not with a polynomial-backtracking anchored regex. The review-context packer is diff-aware (#569) with case-insensitive whole-word keyword matching and tuned additive per-file boosts (a single exact match floats a score=0 candidate); when structural context is unavailable it falls back to identical file-path-only ranking with the degradation surfaced — never silent (rule 34). SymbolsForDiff errors are coerced into degradation records for recall snapshots/xray in one central helper. Tests for the structural-context path prove failure-first.
- Subprocess/provider boundaries: expand a leading `~` in operator-configured binary paths (rule 17) so home-relative commands resolve instead of degrading; check file existence at probe time (rule 24) — a missing/renamed binary is a DISTINCT `provider_unavailable` code, never a silent empty result; pass the diff as a JSON argv argument (rule 10) so the binary never sees a shell or re-interpolates paths.
- CLI guardrails: `publish` rejects any string positional outright (Commander passes declared positionals before the options object; `publish` declares none, so a stray positional silently published with defaults, issue #2917). `--confirm` is validated to exist and equal "yes" before destructive work (gotcha #14). CLI peer set/delete route through EngramAccessService (PR #756 review) — one policy path. Console replay mirrors the live TUI's SIGINT handling; the recorder always closes on shutdown and flush errors are surfaced, not swallowed. Recall-operation gates are resolved ONCE per command — the CLI-search path shares recall's mixed-op gate resolution for harmonicRetrieval (#1566 Cluster C). Direct skill imports refresh the search index explicitly or imported procedures stay undiscoverable. Catalog writes from contradiction merges register as catalog write touches.
- Action gate: failure advisories are fail-open by measured design (the H6 study, #1963/#2382) — observation never blocks the action; a single advisory payload is bounded above the primitive citation bound; zero-limit semantics are a compatibility contract (`0` stays `0`); exact trajectory fingerprint matches rank above lexical matches; telemetry must never break the action it observes (fail-open).

## Consequences
- Fail-open advisories and best-effort telemetry prefer degraded enrichment over blocking user actions; loud rejection of stray positionals trades convenience for not publishing with defaults.

## Origin comments
- `packages/remnic-core/src/cli.ts:8556` — "// Catalog write touch (issue #1499 sweep): a contradiction merge can"
- `packages/remnic-core/src/cli.ts:9030` — "// Cursor L (PR #756 review): route through EngramAccessService.peerSet"
- `packages/remnic-core/src/cli.ts:9065` — "// Cursor M (PR #756 review): route through EngramAccessService.peerDelete"
- `packages/remnic-core/src/cli.ts:9105` — "// Gotcha #14 — validate --confirm argument exists and equals "yes""
- `packages/remnic-core/src/cli.ts:9299` — "// Codex P2: mirror the live TUI's SIGINT handling so"
- `packages/remnic-core/src/cli.ts:9346` — "// Codex P1 (PR #732 follow-up): `recorder.close()`"
- `packages/remnic-core/src/cli.ts:9367` — "// Codex P2 (PR #732 round 5): surface flush errors at"
- `packages/remnic-core/src/cli/research-status-commands.ts:47` — "// Resolve recall-operation gates once (#1566 Cluster C — harmonicRetrieval is a"
- `packages/remnic-core/src/cli/research-status-commands.ts:48` — "// mixed-op flag read here on the CLI-search path as well as in recall)."
- `packages/remnic-core/src/cli/skills-commands.ts:131` — "// Direct writes bypass extraction, so the search index needs an explicit"
- `packages/remnic-core/src/cli/skills-commands.ts:132` — "// refresh or imported procedures stay undiscoverable (§31)."
- `packages/remnic-core/src/cli/timeline-publish-commands.ts:26` — "// Commander passes declared positional args before the options"
- `packages/remnic-core/src/cli/timeline-publish-commands.ts:27` — "// object; `publish` declares none, so a stray positional would"
- `packages/remnic-core/src/cli/timeline-publish-commands.ts:28` — "// displace the options object and silently publish with defaults"
- `packages/remnic-core/src/cli/timeline-publish-commands.ts:29` — "// (issue #2917). Reject any string arg outright."
- `packages/remnic-core/src/coding/action-gate.ts:1` — "/** * Action-site failure gate (issue #2382, slice 1 — core contract). * * The H6 study (#1963) measured that a failure "
- `packages/remnic-core/src/coding/action-gate.ts:26` — "/** Bound on a single advisory payload, above the primitive's citation bound. */"
- `packages/remnic-core/src/coding/action-gate.ts:80` — "// Zero-limit semantics are a compatibility contract: `0` stays `0`."
- `packages/remnic-core/src/coding/action-gate.ts:298` — "// Trajectory matches are exact fingerprint hits: rank above lexical ones."
- `packages/remnic-core/src/coding/action-gate.ts:518` — "// Telemetry must never break the action it observes."
- `packages/remnic-core/src/coding/review-context-structural.test.ts:1` — "/** * Tests for the structural-context-aware review-context path * (issue #1548 Track A PR 5). * * This file is the prov"
- `packages/remnic-core/src/coding/review-context.test.ts:172` — "// Regression: `stripDiffPathPrefix` checked `a/` / `b/` BEFORE stripping"
- `packages/remnic-core/src/coding/review-context.test.ts:173` — "// quotes, so `"a/path with spaces.ts"` never matched the prefix, leaving"
- `packages/remnic-core/src/coding/review-context.test.ts:174` — "// a bogus `"a/path` entry. Quote-stripping must happen first so the"
- `packages/remnic-core/src/coding/review-context.test.ts:175` — "// prefix check sees the unquoted `a/path with spaces.ts`."
- `packages/remnic-core/src/coding/review-context.ts:1` — "/** * Diff-aware review-context packer (issue #569 PR 4). * * When an agent is asked "review this PR" / "what changed in"
- `packages/remnic-core/src/coding/review-context.ts:84` — "/** * Keyword list from the #569 design doc, plus obvious paraphrases. All * matching is case-insensitive and whole-word"
- `packages/remnic-core/src/coding/review-context.ts:133` — "// The two paths are always separated by whitespace at the top level, but"
- `packages/remnic-core/src/coding/review-context.ts:134` — "// whitespace INSIDE quoted paths must NOT split the tokens. Parse the"
- `packages/remnic-core/src/coding/review-context.ts:135` — "// two paths with an explicit tokenizer instead of a `\S+`-based regex"
- `packages/remnic-core/src/coding/review-context.ts:136` — "// (which would shatter `"a/my file.ts"` into `"a/my` / `file.ts"`)."
- `packages/remnic-core/src/coding/review-context.ts:149` — "// `--- a/foo/bar.ts` or `+++ b/foo/bar.ts` — or quoted:"
- `packages/remnic-core/src/coding/review-context.ts:150` — "// `--- "a/foo bar.ts"` / `+++ "b/foo bar.ts"` when git emits C-quoted"
- `packages/remnic-core/src/coding/review-context.ts:151` — "// paths for whitespace or non-ASCII filenames."
- `packages/remnic-core/src/coding/review-context.ts:152` — "//"
- `packages/remnic-core/src/coding/review-context.ts:153` — "// Matched with an anchored prefix and an explicit tokenizer for the"
- `packages/remnic-core/src/coding/review-context.ts:154` — "// tail so quoted paths containing whitespace are not split on the"
- `packages/remnic-core/src/coding/review-context.ts:155` — "// first internal space. The previous `\S+` form silently dropped"
- `packages/remnic-core/src/coding/review-context.ts:156` — "// everything after the first whitespace in a quoted path."
- `packages/remnic-core/src/coding/review-context.ts:159` — "// Linear trailing space/tab trim instead of /[ \t]+$/, whose anchored"
- `packages/remnic-core/src/coding/review-context.ts:160` — "// quantifier backtracks polynomially on a long diff line (CodeQL"
- `packages/remnic-core/src/coding/review-context.ts:161` — "// js/polynomial-redos)."
- `packages/remnic-core/src/coding/review-context.ts:247` — "// Git conventionally prefixes paths with `a/` or `b/` in diffs, and"
- `packages/remnic-core/src/coding/review-context.ts:248` — "// quotes the whole path (including the prefix) when it contains spaces or"
- `packages/remnic-core/src/coding/review-context.ts:249` — "// non-ASCII bytes. Quote-stripping must therefore happen BEFORE the"
- `packages/remnic-core/src/coding/review-context.ts:250` — "// prefix check — otherwise `"a/path with spaces.ts"` still starts with"
- `packages/remnic-core/src/coding/review-context.ts:251` — "// `"a` and the prefix is never recognized."
- `packages/remnic-core/src/coding/review-context.ts:260` — "// Normalize Windows-style backslashes. Must happen AFTER quote stripping"
- `packages/remnic-core/src/coding/review-context.ts:261` — "// so that C-quote escape pairs are decoded before path separators are"
- `packages/remnic-core/src/coding/review-context.ts:262` — "// normalized."
- `packages/remnic-core/src/coding/review-context.ts:344` — "/** * Additive boost per matching touched-file. Tuned so that a single exact * match is enough to float a `score=0` cand"
- `packages/remnic-core/src/coding/review-context.ts:493` — "// Fallback: file-path-only ranking, identical to the pure packer. The"
- `packages/remnic-core/src/coding/review-context.ts:494` — "// degradation is surfaced so the failure is never silent (rule 34)."
- `packages/remnic-core/src/coding/structural-context.ts:153` — "Coerce a {@link SymbolsForDiffErr} into the degradation record consumers attach to recall snapshots / xray. Centralis..."
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:81` — "// Rule 17 — expand a leading ~ so a home-relative binary path"
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:82` — "// (e.g. ~/bin/cbm) resolves instead of degrading to unavailable."
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:83` — "// Mirrors the codegraph-runtime.ts precedent for operator paths."
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:99` — "// Rule 24 — file existence check at probe time. An operator pointing at"
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:100` — "// a missing/renamed binary gets a DISTINCT `provider_unavailable` code,"
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:101` — "// never a silent empty result."
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:142` — "// Rule 10 — argv array; the diff is carried as a JSON argument so the"
- `packages/remnic-core/src/coding/structural-subprocess-provider.ts:143` — "// binary never sees a shell and never re-interpolates paths."

_Note: the smallest themes (CLI guardrails, action gate, diff parsing, subprocess providers) were merged into this boundary-guardrails ADR to stay within the ten-file limit; the Decision section states each rule separately._
