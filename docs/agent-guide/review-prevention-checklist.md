# Review Prevention Checklist

Extracted from repo-root `AGENTS.md` (Path B 2026-10-07) so advisor/omp default ingest stays under context caps. **Read before every Remnic PR.**

## Review Prevention Checklist (All Agents — Read Before Every PR)

These patterns were extracted from 60+ PRs across 2026-04-05 to 2026-04-12
(including deep analysis of PRs #343-#408 with 980+ review comments).
Every item below was caught by a reviewer (Cursor Bugbot, Codex, or CodeQL) and
required a follow-up commit to fix. Follow these rules to ship clean on the first push.

Also: this is a **public repo** — issue and PR text must follow the
"PUBLIC REPOSITORY — Privacy Policy" section (no PII or operator-specific
details; describe problems and design fixes for all users, not one deployment).

### 1. Input Validation — Reject Invalid Inputs Explicitly

Reviewers repeatedly caught silent defaulting on invalid inputs. Never silently
accept and reinterpret bad values.

- **CLI flags must validate their argument exists** — `--format json` where
  `--format` has no value must throw, not silently default.
- **Enum/config values must be validated against an explicit allow-list** — when
  adding a new accepted value (e.g., `"low"` for `activeRecallThinking`), add it
  to the validation schema AND the config parser.
- **Numeric inputs must be type-checked** — port values must be finite integers
  in [1, 65535]; reject `"abc"` and `3.7` rather than truncating.
- **Date/timestamp parsing must guard overflow** — reject inputs that would
  overflow `Date` bounds instead of producing `Invalid Date`.

### 2. Rename Completeness — Always Add Legacy Fallbacks

The Engram→Remnic rename touched every surface. Every rename PR required
follow-up fixes for missed references.

- **Search the entire codebase when renaming anything** — `grep -ri oldname`
  across all files including docs, tests, lock files, changesets, hooks, and
  CI configs.
- **Always add a legacy fallback chain** — env vars: `REMNIC_FOO` → `ENGRAM_FOO`;
  config keys: try `remnic` block first, fall back to `engram` block.
- **Update lock files when changing workspace dependencies** — changing
  `workspace:*` specifiers or package names without running `pnpm install`
  breaks the lock file.
- **Changeset files must reference current package names** — stale package IDs
  in `.changeset/` will cause release failures.
- **Hook scripts must use the current plugin name in error messages and paths.**

### 3. Security — Sanitize at System Boundaries

CodeQL and Bugbot repeatedly flagged these patterns.

- **Never interpolate unsanitized values into shell commands** — pass host/port
  via environment variables, never via string interpolation into script strings.
- **Restrict file permissions on auth tokens** — config files containing tokens
  should use `0600` permissions.
- **Block symlink traversal in directory scans** — when scanning `artifacts/` or
  memory directories, reject symlinks that resolve outside the allowed root.
  Reject symlinked root directories entirely.
- **Validate external inputs at system boundaries** — profile values, connector
  IDs, and config paths must be sanitized before filesystem operations.

### 4. Error Handling — Never Let Side Effects Crash the Main Flow

Token store failures, daemon unavailability, and filesystem errors must not
block the primary operation.

- **Wrap token/external-service operations in try-catch** — if `generateToken()`
  fails, the install should still complete with a note to run token generation
  manually later.
- **Write rollback manifests BEFORE migration markers** — if rollback metadata
  write fails, the system must not think migration succeeded.
- **Use AbortController for timeout-able async operations** — timed-out
  `before_reset` flushes must abort the in-flight extraction before buffer
  clearing, so late flushes cannot clear turns buffered after reset proceeds.
- **Guard refcount operations against double-decrement** — track whether
  increment happened before decrementing; use a `didCountStart` flag.

### 5. State Scoping — Don't Share What Shouldn't Be Shared

Multiple plugin instances can coexist; globals must be scoped.

- **Scope singletons per plugin ID** — runtime orchestrator mirrors, CLI dedupe
  guards, and capability caches must be keyed by `serviceId`, not stored as
  bare globals.
- **Scope extraction deduplication by session/buffer key** — `shouldQueueExtraction`
  must fingerprint `bufferKey + normalizedTurnText`, not just turn text, so
  parallel sessions don't suppress each other's extractions.
- **Cache writes and reads must use consistent formats** — if the hook path
  writes `{version, data}` and the section path reads `data` directly, they will
  diverge.

### 6. Test Quality — Tests Must Actually Verify Behavior

Reviewers caught multiple tests that passed vacuously.

- **Never write assertions on empty arrays** — `expect(result).toEqual([])` passes
  trivially; assert on non-empty expected data or assert the function was called.
- **Don't assume filesystem ordering** — `readdir` is not guaranteed to be
  alphabetical; sort explicitly before comparing.
- **Clean up ALL global state in test teardown** — including unkeyed globals
  like `__openclawEngramOrchestrator` mirror keys in `resetGlobals()`.
- **Test error paths** — for every `try/catch` added in production code, add a
  test that forces the error path and asserts recovery behavior.
- **Don't use fragile CWD-relative paths** — use `import.meta.dirname` or
  `path.resolve(__dirname, ...)` instead of assuming CWD.
- **Prove each new test discriminates, mechanically.** "Looks like it tests
  the fix" is not evidence. Before committing, either (a) stash the source
  change and re-run — every new test defending it MUST fail, or (b) mutate
  the specific behavior (flip a comparator's sign, swap an append order)
  and confirm the suite goes red. A test that passes with AND without the
  change proves nothing: delete it rather than keep it green. This is
  cheap — a stash plus one test-file run — and it is the only way to tell a
  regression test from decoration. Three vacuous tests were deleted and two
  suites confirmed via killed mutants in one recent multi-PR run; each of
  those would otherwise have shipped as false coverage.

### 7. Documentation Accuracy — Examples Must Be Copy-Pasteable

Every doc PR required follow-up fixes for stale references.

- **Code examples must reference current variable names** — after a rename,
  search all code blocks in docs for the old name.
- **CLI command examples must use current commands** — `remnic connectors install`,
  not `engram connectors install`.
- **Hook templates must use current env var chains** — match the real hook
  scripts' `REMNIC_* → ENGRAM_*` fallback precedence.
- **Architecture diagrams must use current labels** — "Remnic Orchestrator",
  not "Engram Orchestrator".

### 8. Dead Code — Remove What You Don't Need

Reviewers flagged unreachable branches and unused exports.

- **Remove unreachable branches** — if a non-recursive flag makes a branch
  unreachable, delete it rather than leaving dead code.
- **Don't duplicate helpers across packages** — if `toolJsonResult` exists in
  two tool files, extract to a shared utility.
- **Remove dead switch cases** — after normalizing tool names, remove the old
  case rather than leaving it to silently never match.

### 9. Config Resolution — Deduplicate Shared Lookup Logic

The slot-based config resolution pattern (`slot → PLUGIN_ID → LEGACY_PLUGIN_ID`)
was independently reimplemented in 5+ locations with divergent guard styles,
causing inconsistent behavior during migration.

- **Extract config resolution into a single shared module** — `resolveRemnicPluginEntry`
  must be the one source of truth; all callers (access-cli, operator-toolkit,
  materialize.cjs, src/index.ts) must import from it.
- **Validate that resolved plugin IDs belong to Remnic** — a foreign plugin's
  config can be read and applied to Remnic when `slots.memory` points elsewhere.
  Always check `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.
- **Maintain legacy flat-config fallback** — developer-mode configs where the
  top-level object IS the plugin config must still resolve correctly.
- **Keep env var priority consistent** — primary `REMNIC_*` / `OPENCLAW_*`
  must be checked before legacy `ENGRAM_*` / `OPENCLAW_ENGRAM_*` everywhere.

### 10. Path Handling — Expand Tildes and Validate Types

Node.js `fs` functions do NOT expand `~`. Multiple PRs had path-related bugs.

- **Expand `~` consistently with `expandTilde`** — never use ad-hoc regex like
  `path.replace(/^~/, homedir())` which incorrectly matches `~user/` prefixes.
  Use the shared `expandTilde()` for all user-facing path inputs: `memoryDir`,
  `--config`, `OPENCLAW_CONFIG_PATH`, `--memory-dir`.
- **Validate path type before using** — `existsSync` returns true for files too;
  use `statSync().isDirectory()` when a directory is expected. Reject file paths
  used as `memoryDir`.
- **Fail fast on invalid JSON config** — when `openclaw.json` exists but cannot
  be parsed (or parses to `null` / non-object), surface an error instead of
  silently returning `{}` which then overwrites the file destroying all settings.
- **Validate `plugins.entries` shape** — check it's a plain object, not `null`,
  array, number, or string before using `in` operator or property access.

### 11. Signature Changes — Propagate to All Call Sites

Changing a function signature is a high-risk operation that consistently
required follow-up fixes.

- **Search ALL code including tests and adapters** — when changing
  `addTurn(role, content)` to `addTurn(sessionId, turn)`, search not just `src/`
  but `tests/`, and `packages/*/` for old-form call sites.
- **Add a deprecation path for public APIs** — if the function is exported,
  add a compatibility wrapper that maps old args to new with a deprecation log,
  rather than breaking silently.
- **Update test helpers to match production behavior** — if production code
  gates on a `migrateLegacy` flag, the test helper must read the same flag
  instead of unconditionally executing.

### 12. Sort Stability — Comparators Must Return 0 for Equal Items

Multiple sort comparators never returned `0`, causing non-deterministic
ordering that broke diffs and automation.

- **Sort comparators must be well-formed** — return `-1`, `0`, or `1`. Never
  return `1` for both orderings of equal items. When `a.updatedAt === b.updatedAt`,
  return `0` or use a stable secondary key (e.g., `id`).
- **Non-deterministic output breaks downstream** — top-N slices from unstable
  sorts produce different results across runs, making briefings, reports, and
  diffs unreliable.
- **Test sort stability explicitly** — sort a list with duplicate keys and
  assert the output is identical across multiple invocations.

### 13. Hash/Dedup Consistency — Use the Same Content Form Everywhere

When content is transformed before persistence (e.g., citation injection,
timestamp appending), hash operations must consistently use either raw or
transformed form — never a mix.

- **All hash-index operations must use the same content form** — if writes
  hash `rawContent`, reads and dedup checks must also hash `rawContent`, not
  `citedContent` (which includes timestamps).
- **Beware of double-hashing** — if `contentHashIndex.remove()` internally
  hashes its argument, passing an already-hashed value produces `hash(hash(x))`
  which never matches stored entries.
- **Don't mix `contentHashSource` and direct hashing** — if one write path
  passes `contentHashSource: rawContent` and another omits it (causing the
  index to hash the persisted form with timestamp), dedup breaks.

### 14. Atomic Multi-Step Operations — Don't Destroy Old State Before New State Is Confirmed

PR #400 had 20+ review rounds on connector lifecycle. The dominant pattern was
destroying valid state before confirming the replacement is viable.

- **Don't rotate/destroy tokens before confirming the new config write succeeds**
  — if `generateToken()` revokes the old token, then `upsertHermesConfig` or
  `commitTokenEntry` fails, the user is left with a revoked token and no working
  config. Always confirm the new state before destroying the old.
- **Don't clean up old profile config before new profile write succeeds** — if
  `removeHermesConfig(oldProfile)` runs before `upsertHermesConfig(newProfile)`
  succeeds, a partial failure leaves neither profile configured.
- **Persist rollback data BEFORE writing success markers** — if `.rollback.json`
  write fails, a `.migrated-from-engram` marker creates a false success signal.
- **Don't write connector JSON with a new token before confirming token store
  commit** — `connector.json` holding a token the daemon doesn't recognize
  creates an invisible auth mismatch.

### 15. Monorepo Package Boundaries — Never Reach Across `src/` Directories

Reviewers repeatedly flagged cross-package relative imports that bypass the
public export surface.

- **Import via package name, not relative path** — use
  `import { X } from "@remnic/core"` not
  `import { X } from "../../../remnic-core/src/foo.js"`. A directory rename or
  build-output change in the target package silently breaks the import.
- **Shim packages must own their runtime identity** — when a shim re-exports
  `pluginDefinition`, its `register()` must use its own `LEGACY_PLUGIN_ID`, not
  the inherited `PLUGIN_ID`. Module-level constants are captured at import time,
  not overridden by object-spread.
- **Config loaders must ALL agree on lookup semantics** — if `access-cli.ts`
  uses ternary+`??` fallback and `src/index.ts` uses early-return, they diverge
  during migration when both entries exist. One shared resolver, one pattern.

### 16. Config Guard Rails — New Features Must Be Gatable and Reversible

Reviewers caught features that unconditionally transformed behavior without any
escape hatch or configuration gate.

- **Procedural memory (issue #519)** — All runtime behavior is behind **`procedural.enabled`** (default **`true`**, on by default since issue #567 PR 4/5; only the `conservative` preset pins it `false`). Docs: `docs/procedural-memory.md`. When changing extraction, recall injection, or mining paths, keep gates aligned with that flag and the nested `procedural.*` knobs in `parseConfig`.
- **Add an `enabled` check or escape hatch for every new filter/transform** —
  if a new recall filter unconditionally removes `dream`/`procedural` memories,
  users can never search for them even when the feature is disabled. Mirror the
  pattern: lifecycle filters have `enabled` checks; new filters must too.
- **Force reinstall must merge from existing config** — when `--force` is used
  without re-supplying `--config profile=...`, hard-resetting to defaults
  silently loses the user's configured profile/host/port. Read the existing
  stored config first and merge.
- **Guard slot-based lookups against foreign plugin IDs** — if
  `plugins.slots.memory` points to a non-Remnic plugin, the lookup must reject
  it rather than silently applying a foreign plugin's settings to Remnic.
  Always validate `resolvedId === PLUGIN_ID || resolvedId === LEGACY_PLUGIN_ID`.

### 17. JavaScript Numeric Footguns — Guard Zero, Negative Zero, and Type Coercion at Boundaries

Multiple PRs had bugs from JavaScript's numeric quirks and CLI string→number
coercion issues.

- **Guard `slice(-maxEntries)` against `maxEntries === 0`** —
  `entries.slice(-Math.max(0, 0))` produces `slice(-0)` which equals `slice(0)`
  and returns ALL entries. Always check `if (maxEntries <= 0)` before negation.
- **CLI values arrive as strings** — `--config port=5555` produces `"5555"`,
  not `5555`. Type guards like `typeof prev?.port === "number"` reject saved
  values on reinstall. Always coerce at the input boundary with
  `Number(port)` + validation, then store as the expected type.
- **Reject non-integers explicitly** — `Number.isFinite(4318.9)` is true but
  silently truncating to a different port is a misconfiguration. Use
  `Number.isInteger()` when integers are expected.

### 18. Force-Flush and Dedupe — Explicit Operations Must Bypass Dedupe

Reviewers caught a critical bug where explicit flush operations (session flush,
before_reset) were suppressed by the same deduplication that guards automatic
extraction.

- **Explicit flushes must pass `skipDedupeCheck: true`** — if a prior
  extraction attempt failed/timed out but left the buffer intact, the
  dedupe fingerprint still exists. A subsequent force-flush must not be
  suppressed by stale dedup state.
- **Buffer key must be propagated through all extraction paths** — if
  `ingestReplayBatch` calls `queueBufferedExtraction` without `bufferKey`,
  the default `"default"` key is used, clearing the wrong buffer on success.
- **Don't health-check with uncommitted tokens** — if `commitTokenEntry`
  fails or is skipped, `checkDaemonHealth` sends an unknown token, gets 401,
  waits 6 seconds on retry, and reports a misleading "not reachable" message.

### 19. Architecture Boundary Naming — Core Must Be Host-Agnostic

Reviewers caught host-prefixed files living in core packages, violating the
stated architecture boundary that `@remnic/core` must not depend on any host.

- **Never prefix core files with host names** — `openclaw-recall-audit.ts`
  in `@remnic/core` violates the boundary rule even though the file itself
  contains no OpenClaw-specific logic. The prefix creates confusion about
  where host-specific code belongs and signals a wrong dependency direction.
- **Generic audit/log modules belong in core without host prefixes** — rename
  to `recall-audit.ts` or similar. If host-specific behavior is needed, the
  host adapter extends or wraps the core module.
- **When in doubt, check the architecture boundary rules** — Section 1 of this
  document states: "Core and standalone paths must not depend on OpenClaw,
  Hermes, or any future host." File names are part of this contract.

### 20. Parser Position Tracking — Don't Use indexOf for Duplicate Lines

Multiple parsers used `content.indexOf(line)` to compute source offsets, which
returns the first occurrence rather than the current parsing position.

- **Track character position during iteration** — when parsing structured text
  (heartbeat blocks, task lists), maintain a running `offset` variable that
  advances with each line/section processed, rather than re-searching from the
  start with `indexOf`.
- **`indexOf` on repeated content is wrong** — if the same line text appears
  earlier in the content (e.g., a repeated indentation pattern or comment),
  `indexOf` returns the position of the first occurrence, making the offset
  point to the wrong location.
- **This applies to all line-based parsers** — not just heartbeat parsing.
  Any parser that needs error-reporting positions or source mapping must track
  its own position during iteration.

### 21. Test Mock Signature Fidelity — Mocks Must Match Production Signatures

Reviewers caught test mocks that defined functions with fewer parameters than
the production interface, making tests pass vacuously.

- **Mock signatures must match the production interface exactly** — if the
  production interface declares `getLastRecall(sessionKey: string)`, the test
  mock must accept and use the `sessionKey` parameter, not define a zero-argument
  function that ignores it.
- **Verify mock parameter usage in assertions** — for per-session dispatch
  (command handlers, keyed lookups), test that different session keys produce
  different results. A mock that always returns the same value masks that
  per-session dispatch is broken.
- **Interface changes must propagate to test mocks** — when a production
  function signature changes (e.g., adding a `sessionKey` parameter), grep
  all test files for the old signature and update mocks to match.

### 22. Error-Result Conflation — Distinguish Empty Results from Backend Failures

When a backend call returns an empty result (e.g., no matching embeddings) versus
when it fails (timeout, error, 5xx), the code must NOT conflate both cases into
the same return path. Reviewers caught 5+ instances in PR #399 alone.

- **Return distinct sentinel values for "empty" vs "failed"** — if `search()` returns
  `[]` for both "index is empty" and "embedding endpoint returned 5xx", callers
  cannot short-circuit on genuine failures. Use a result object like
  `{ok: true, results: []}` vs `{ok: false, error: "backend_unavailable"}`.
- **Batch operations need failure detection** — when processing many items, a single
  backend failure should be distinguishable from "no candidates found" so the batch
  can stop paying timeouts on every subsequent item.
- **Telemetry and dashboards depend on correct categorization** — `reason: "no_candidates"`
  from a genuinely empty index is a healthy signal. `reason: "backend_unavailable"`
  from a timeout is an alert. Conflating them masks outages.

### 23. Timestamp Boundary Semantics — Use Inclusive-Start, Exclusive-End Intervals

When filtering data by time ranges, code must consistently use `[start, end)`
(half-open) interval semantics. Reviewers caught 6+ instances of inclusive upper
bounds causing double-counting at exact boundaries in PR #396.

- **Upper bounds must be exclusive (`<`) not inclusive (`<=`)** — a memory timestamped
  at exactly midnight should appear in only one day's briefing, not both yesterday's
  and today's. When `to` is documented as exclusive, the filter must use `ts < toMs`.
- **Date-only comparisons need careful handling** — a "floating" event with `endDate`
  as a date string (no time component) must not be treated as active on the end date
  itself when the contract says `[start, end)`. Convert date-only values to the start
  of the next day for exclusive-end comparisons.
- **Test boundary conditions explicitly** — include test cases with timestamps at exact
  boundary values (midnight, start-of-day, end-of-day) to catch inclusive/exclusive
  confusion.

### 24. String Coercion at Config Boundaries — Handle "false", "0", "no" as Falsy

CLI flags pass values as strings: `--config installExtension=false` produces the
string `"false"`, not the boolean `false`. Code that checks `!== false` treats
`"false"` as truthy, silently ignoring the user's explicit opt-out. Reviewers
caught 4+ instances across PRs #394 and #397.

- **Coerce boolean-like strings at config-read boundaries** — `"false"`, `"0"`,
  `"no"`, `"off"` must be treated as falsy. Use a shared `coerceBool()` helper
  that normalizes these string representations.
- **`!== false` is NOT a boolean gate** — when config values come from CLI or
  persisted JSON, they may be strings. Use explicit coercion or a Zod boolean
  transform rather than relying on JavaScript truthiness.
- **Test with string-typed config values** — every config gate test should include
  cases where the value is the string `"false"` and `"0"`, not just the boolean
  `false`.

### 25. Cache Invalidation Completeness — Clear ALL Cache Layers

When a storage manager maintains multiple caches (hot memory, cold tier, hash
index), the invalidation function must clear ALL of them. Reviewers caught cases
where `invalidateAllMemoriesCache()` only cleared the hot cache but left the cold
cache stale, despite comments claiming it cleared both (PR #402).

- **Name invalidation functions precisely** — if a function only clears one cache
  layer, name it `invalidateHotCache()`, not `invalidateAllMemoriesCache()`.
- **Verify invalidation covers all layers** — when adding a new cache layer,
  grep for all invalidation functions and add the new cache to each one.
- **Don't invalidate before reads that need the cache** — calling invalidation
  before a read that populates the cache defeats the caching purpose. Invalidation
  should happen after writes, not before reads.

### 26. Object Key Order in Hash/Serialization — Sort Before Serializing

When building a hash or serialized string from object properties, `Object.entries()`
preserves insertion order. Two semantically identical objects constructed differently
produce different hash strings, silently bypassing deduplication (PR #402).

- **Sort object keys before serializing for hashing** — use
  `Object.keys(obj).sort().map(k => ...)` or `JSON.stringify(obj, Object.keys(obj).sort())`
  to ensure deterministic serialization regardless of insertion order.
- **This affects all dedup/content-hash operations** — if structured attributes
  like `{city: "NYC", country: "US"}` vs `{country: "US", city: "NYC"}` produce
  different hash strings, deduplication silently fails.
- **Test with different key orderings** — when testing dedup, include test cases
  where the same data is represented with keys in different orders.

### 27. Feature Gate Consistency — Apply Gates Uniformly Across All Code Paths

When a feature flag (e.g., `temporalSupersessionEnabled`) controls behavior, ALL
recall paths (QMD search, recent-scan fallback, cold fallback) must implement
the gate identically. Reviewers caught divergent gating across code paths in
PR #402 (4 instances).

- **Enumerate every code path when adding a feature gate** — list all recall/search
  paths and verify each one checks the same flag in the same way.
- **Enable-then-disable must revert cleanly** — if a user enables a feature, runs
  for a while, then disables it, all paths must behave as if the feature never
  existed. Partial gating leaves stale artifacts that only appear on some paths.
- **Test each path independently with the flag on AND off** — don't just test the
  primary path. Each fallback path should have explicit tests for both flag states.

### 28. Promise Chain Resilience — Serialized Chains Must Recover From Rejection

The `writeChain = writeChain.then(async () => { ... })` serialization pattern in
session-toggles.ts permanently broke all future writes after the first I/O error.
A rejected promise in the chain prevents all subsequent `.then()` callbacks from
executing for the process lifetime. PR #408.

- **Always add `.catch()` recovery to serialized promise chains** — after
  `writeChain = writeChain.then(...)`, ensure the chain resets to a resolved
  state so a single failure doesn't poison all subsequent operations.
- **Surface the failure to the current caller but unblock future callers** —
  use a pattern like `writeChain = writeChain.then(fn).catch(err => { throw err; })`
  or a dedicated `queueWrite()` wrapper that recovers the chain after rejection.
- **Test serialization resilience explicitly** — force a write failure in a test,
  then verify the next write on the same instance succeeds.

### 29. Loop Collection Mismatch — Use Correct Iterator Method for Needed Data

In `ingestReplayBatch`, the loop used `for (const sessionTurns of bySession.values())`
but then referenced `bufferKey: key` where `key` was undefined. The loop needed
`.entries()` to destructure both key and value. PR #408 (High Severity).

- **Match the iterator method to the data you need** — `.keys()` for keys only,
  `.values()` for values only, `.entries()` for both. Never reference a variable
  from an outer scope when the loop doesn't bind it.
- **TypeScript strict mode catches this** — ensure `noImplicitAny` and `strict`
  are enabled so referencing an undefined variable in the block is a compile error.
- **Grep the entire function body for variables used but not declared locally**
  — if a loop body references `key` or `id` that isn't in its destructuring
  pattern, it's either undefined or from an outer scope, both likely wrong.

### 30. Namespace-Aware Read/Write Consistency — Storage Paths Must Match

`recallForActiveMemory` searched across all namespaces (no namespace constraint)
while `getMemoryForActiveMemory` read from default storage only. In multi-tenant
deployments, search could return IDs from non-default namespaces that get operations
would fail to resolve. PR #408 (P1 severity).

- **Read and write paths must resolve through the same namespace layer** — if
  search goes through namespace-aware resolution, get/delete must too.
- **Cross-tenant data exposure is a security risk** — un-namespaced search in
  multi-principal deployments can leak data between tenants. Always constrain
  search scope via session-derived namespace resolution.
- **Test with multiple namespaces** — create test fixtures with data in different
  namespaces and verify each session only sees its own data.

### 31. Post-Write Reindexing — Write Paths Must Trigger Index Updates

The heartbeat import path wrote procedural memories directly to storage but
didn't trigger any reindex step. Because active-memory search is QMD-backed,
newly imported entries were not discoverable until unrelated maintenance happened.
PR #408 (P2 severity).

- **After writing data that needs to be searchable, trigger reindex** — direct
  storage writes bypass the normal extraction→persist→index pipeline, so they
  must explicitly call the reindex step.
- **Verify discoverability in tests** — after writing data, perform a search
  and assert the new data is findable. Tests that only check file existence
  miss index staleness.
- **Document all direct-write paths** — any code that bypasses the normal
  write pipeline should be flagged as needing manual reindex triggers.

### 32. Index-Persistence Consistency — Don't Index Rejected/Non-Persisted Content

In the semantic dedup guard (PR #399), when a fact was rejected by the
importance gate or semantic dedup check, `fact.content` was still added to
`contentHashIndex`. The index accumulated phantom entries for content that
doesn't exist in storage, causing false dedup matches on subsequent extractions.

- **Only add to index AFTER successful persistence** — move `contentHashIndex.add()`
  calls to after the write succeeds. If a dedup check, importance gate, or other
  filter rejects content before persistence, the index must remain untouched.
- **Phantom index entries cause silent data loss** — a phantom entry causes the
  next extraction with similar content to be dedup-suppressed against a
  non-existent stored fact, effectively losing the new extraction silently.
- **Test index consistency after rejection paths** — force a dedup/importance
  rejection in a test, then verify the index does not contain an entry for the
  rejected content.

### 33. Config Schema-Code Consistency — Schema Minimums Must Honor Documented Disable Values

In PR #399, `semanticDedupCandidates` was documented as "set to 0 to disable"
but the JSON schema had `minimum: 1` and the code clamped to `Math.max(1, ...)`.
Users following docs to disable the feature got silently overridden to minimum 1.

- **When a config value can disable a feature, schema AND code must accept 0** —
  if docs say "set `maxCandidates` to 0 to disable", the JSON schema must set
  `minimum: 0` (not `1`), and the code must handle the `0` case (typically by
  short-circuiting before the operation).
- **Zero-value semantics are a compatibility contract** — `enabled=false` and
  `0` limits are user-facing guarantees. Coercing `0` to `1` violates the
  documented contract silently. Test with the documented disable values.
- **Validate schema against documented behavior in CI** — the `check-config-contract`
  script should flag when a config property's schema `minimum` contradicts the
  documented disable value.

### 34. Template-Derived Regex Safety — Escape Literal Parts Before Building Patterns

In PR #401, `templateMatcher` built a regex from only the prefix (before first
placeholder) and suffix (after last placeholder) of a citation template. When
both were empty (a template consisting of only a placeholder), the resulting
regex matched everything. Additionally, special `$` patterns in regex replacement
strings corrupted citation output.

- **Escape all literal template parts before embedding in regex** — use
  `String.raw` or `escapeRegex()` on prefix/suffix before building the pattern.
  Never assume template parts are regex-safe.
- **Test with empty prefix/suffix** — a template like `{{tag}}` with no surrounding
  literal text must not produce a match-everything regex.
- **Escape `$` in replacement strings** — `String.replace` with a regex treats
  `$'`, `` $` ``, `$&`, `$1`, etc. as special in the replacement string. Use a
  replacement function or escape `$` → `$$` before passing to replace.

### 35. Shared Mutable State Across Connections — No Cross-Session Data Leakage

PR #347 had a single mutable `clientInfo` object shared across all MCP connections.
When one connection set its `clientInfo`, the value bled into all other active
connections. In multi-tenant deployments this is a cross-tenant data leak.

- **Each connection/session must own its mutable state** — if `resolveAdapter()`
  writes to a shared `clientInfo` object, two concurrent connections see each
  other's adapter metadata. Use per-connection instances or deep-copy before
  storing.
- **Shared state is distinct from global singletons** — pattern #5 covers
  singleton scoping by plugin ID. This pattern covers mutable objects shared
  across connections within the same plugin instance. Both are needed.
- **Test with concurrent connections** — create two sessions, set different
  adapter data on each, and verify neither sees the other's data.

### 36. Unsafe Enum Defaults — Missing Values Must Default to Least-Privileged Option

In PRs #344 and #345, a feedback decision enum silently defaulted to
`"approved"` when the value was `undefined` or missing. This means a missing
rejection is treated as approval — a security vulnerability. PR #343 had a
similar issue with `qmdDebug` passing an object instead of a string to a method
that expected a string, silently producing wrong debug output.

- **Enum defaults must be the safest option, not the most convenient** — when
  a decision/status enum value is missing or unrecognized, default to
  `"rejected"`, `"pending"`, `"disabled"`, or `"none"` — never `"approved"`,
  `"enabled"`, or `"active"`.
- **Never silently coerce unexpected types** — if `qmdDebug` receives an object
  where a string is expected, throw or log a warning. Don't silently stringify
  as `[object Object]`.
- **Test with missing/undefined enum values** — every enum parser should have
  test cases for `undefined`, `null`, `""`, and unrecognized string values, and
  each must assert the default is the least-privileged option.

### 37. Duplicate Identifiers in Batch Rename/Move Operations

In PR #392, duplicate rollout slugs caused an ENOENT crash: the first rename
moved the file, then the second rename tried to move the same (now non-existent)
source. When processing batches of file operations, duplicate identifiers in
the input cause the second operation to fail.

- **Deduplicate batch operation inputs before execution** — before processing a
  list of rename/move/delete operations, check for duplicate source or target
  identifiers. Either deduplicate (keep the last) or fail fast with a clear
  error.
- **Verify source exists before each move** — in a batch loop, `statSync` the
  source file before attempting to move it. If it was already moved by a
  duplicate entry, skip or error rather than crashing.
- **Test batch operations with duplicate inputs** — include test cases where
  the input list contains duplicate identifiers and verify the behavior is
  deterministic (not dependent on filesystem ordering).

### 38. CI Pipelines Must Not Silence Test/Type Failures

In PR #349, the Hermes Python CI workflow used patterns that hid test and type
failures, making them invisible to reviewers. Broken tests that passed CI
were caught only by manual review.

- **Never use `|| true` on test/type-check commands in CI** — if `pytest`,
  `mypy`, `tsc`, or equivalent commands fail, the CI step MUST fail. Silencing
  failures with `|| true` or missing `set -e` means broken code passes CI.
- **Each language's quality gate must be a separate CI step** — don't bundle
  `ruff check && mypy && pytest` into a single script with `set -e` at the top
  and then call it with `|| true`. Make each a distinct step so failures are
  visible in the CI UI.
- **Audit CI workflows for failure suppression** — grep all workflow files for
  `|| true`, `continue-on-error: true`, and missing `set -e` in shell scripts.
  These should only exist on intentional tolerance (like cleanup steps), never
  on quality gates.

### 39. Silent Acceptance of Invalid User Input — Reject Instead of Reinterpreting

PR #396 had 10+ instances where invalid CLI flags (`--format jsno`), MCP
parameters, briefing window tokens, and format values silently fell back to
defaults instead of being rejected. While pattern #1 covers CLI flag validation,
this pattern addresses the broader issue of accept-then-default behavior in
ALL input surfaces (CLI, MCP, config, API).

- **Invalid values must be rejected, not silently reinterpreted** — when
  `--format jsno` is provided, throw an error listing valid formats. Don't
  silently fall back to `config.briefing.defaultFormat`. The user explicitly
  chose a value; ignoring it hides configuration mistakes.
- **MCP/API surfaces must validate exactly like CLI surfaces** — when a tool
  parameter is invalid, return a clear error, not a result computed with
  default values. MCP callers (agents) cannot tell the difference between a
  valid response and a silently-defaulted response.
- **Missing flag arguments must fail, not default** — `--since` with no value
  must error, not fall back to `config.briefing.defaultWindow`. The user's
  intent is ambiguous, not "use the default".
- **Briefing window tokens must reject unrecognized values** — when `since`
  contains `garbage`, don't silently fall back to `yesterday`. The caller
  should know their input was invalid.

### 40. Validator-Implementation Consistency — Schemas Must Match Code Paths

PR #396 had 3 instances where validation accepted values that downstream code
never handled. `BRIEFING_FORMAT_ALLOWED` included `"text"` but the format
resolution only handled `"markdown"` and `"json"`. Dead switch cases after
name normalization. Legacy tool schemas inheriting updated descriptions.

- **Validation allow-lists must exactly match handled values** — if a format
  validator accepts `"text"`, `"markdown"`, and `"json"`, the downstream code
  must handle ALL three. Any value accepted by validation but unhandled in
  code produces undefined behavior (typically silent fallthrough to default).
- **Dead switch cases after normalization must be removed** — if tool names
  are normalized from `remnic.*` to `engram.*`, a `case "remnic.briefing":`
  branch is dead code that can never match. Remove it rather than leaving it
  to silently never execute.
- **Legacy wrappers must override ALL inherited fields, not just names** —
  when creating a legacy tool schema from a primary schema, override both
  `name` AND `description`. Otherwise the legacy tool advertises the new
  branding in its description while using the old name, confusing clients.
- **Test that every accepted value produces correct behavior** — for each
  value in an allow-list, write a test that passes it through the full
  pipeline and verifies the output matches the expected behavior for that
  specific value.

### 41. Exhaustive Status/State Filtering — Cover All Non-Active States

PR #396 had 3 instances where status-based filters only checked some non-active
states (e.g., filtering `superseded` and `archived` but not `quarantined`,
`rejected`, or `pending_review`). Incomplete filtering causes stale, rejected,
or quarantined data to appear in user-facing outputs like briefings.

- **When filtering by status, enumerate ALL non-active states** — if a filter
  excludes `superseded` and `archived`, it must also exclude `quarantined`,
  `rejected`, and `pending_review` unless explicitly intended. Use an
  `isActive` helper that checks a single set, not an ad-hoc exclusion list.
- **Define the "active" set explicitly, not the "inactive" set** — rather
  than listing states to exclude, define the states to include:
  `if (!ACTIVE_STATUSES.includes(memory.status)) continue;`. This prevents
  new states from accidentally flowing through.
- **Test with every known status value** — create a test fixture with memories
  in each known status and verify the filter produces the correct subset.
- **When adding a new status, update ALL filters** — grep for every status
  filter in the codebase and add the new status to the appropriate inclusion
  or exclusion set.

### 42. Non-Atomic File Replace — Write New Before Deleting Old

PR #394 had 2 instances where code deleted an existing file/directory before
writing the replacement. If the write fails after the delete succeeds (e.g.,
permissions, disk full, cross-device rename), the old data is permanently
lost with no recovery path.

- **Never `rmSync` then `renameSync` — use the reverse order** — write the
  new content to a temp location first, then rename it over the target. On
  most filesystems, `renameSync` is atomic, so the target always exists in
  a valid state. If the write to temp fails, the original remains intact.
- **Backup before destructive operations** — when replacing a config file,
  copy the old content to a `.bak` file first. If the new write fails,
  restore from backup. Clean up the backup after confirming success.
- **Verify write success before cleanup** — if you must delete old data
  (e.g., removing a temp directory after successful rename), verify the
  rename succeeded before cleaning up the source. `renameSync` can fail on
  cross-device moves.
- **Test the failure path** — mock `renameSync` to throw after `rmSync`
  succeeds and verify the error is handled and data is recoverable.

### 44. À-la-carte Packaging — Optional Packages Must Stay Optional at Every Layer

Remnic ships as a family of composable packages. The architectural contract
is that users install only what they use: `@remnic/core` alone, core plus
`@remnic/plugin-openclaw`, core plus `@remnic/export-weclone`, or all three.
A PR that forces an optional package into a base install surface breaks
this contract even if every test passes, because the breakage only shows
up at npm-install time for someone who didn't want that optional surface.

- **Load optional packages via computed-specifier dynamic imports.** Never
  do `import { X } from "@remnic/bench"` in a base install surface (CLI,
  core, plugin-openclaw). Use `await import("@remnic/" + "bench")` so the
  bundler cannot statically resolve the module and pull it into the bundle.
  Wrap in a loader helper (`loadBenchModule()`) that throws a user-facing
  install hint on miss. Canonical patterns:
  `packages/remnic-cli/src/optional-bench.ts`,
  `packages/remnic-cli/src/optional-weclone-export.ts`,
  `packages/remnic-core/src/cli.ts:ensureBuiltInBulkImportAdapters`.
- **Declare as optional peer deps, not `dependencies`.** Optional companions
  go under `peerDependencies` with `peerDependenciesMeta.<name>.optional =
  true`. If you put them under `dependencies`, npm install of the base
  package pulls them in and the à-la-carte model is gone.
- **Never add to `noExternal`.** `packages/remnic-cli/tsup.config.ts` must
  `external` any optional package (or simply omit it from `noExternal`). A
  past regression listed `@remnic/bench` and `@remnic/export-weclone` under
  `noExternal`, which bundled them into every CLI install even for users
  who never ran `remnic bench *`.
- **Publish every surface users are told to install.** Any package that
  docs, error messages, or install hints mention must actually exist on
  npm. Keeping a package `"private": true` while recommending it in a CLI
  install hint is a bug — ship it (update
  `.github/workflows/release-and-publish.yml PUBLISH_ORDER`) or stop
  recommending it.
- **Verify both paths end to end.** When you touch tsup configs, optional-
  loader modules, or the publish workflow, verify that:
  1. `npm install @remnic/cli` succeeds without the optional packages.
  2. Running an optional command without the package throws the install
     hint — not a raw `MODULE_NOT_FOUND`.
  3. Installing the optional package and rerunning the command works.

### 43. Documentation-Code Contract — Documented Behavior Must Be Implemented

PRs #397 and #398 had 3 instances where documentation claimed behavior that
the code didn't implement. Docs said `remnic.timeout` applied to daemon calls
but the provider never forwarded the timeout parameter. A publish workflow
allowed dispatching from any branch without branch protection.

- **Every documented behavior must have a corresponding test** — if docs
  say "timeout is applied to all daemon calls", write a test that verifies
  the timeout parameter reaches the daemon client constructor. Without a
  test, documentation drifts from implementation silently.
- **CI workflows must validate their trigger constraints** — if a publish
  workflow should only run on `main`, add `if: github.ref == 'refs/heads/main'`
  to the job, not just to the trigger. Manual `workflow_dispatch` can target
  any branch, bypassing branch-only triggers.
- **When adding a config property, wire it end-to-end** — adding `timeout`
  to the config schema but not passing it through the provider to the client
  means users set a value that has no effect. The `check-config-contract`
  script should flag config properties that are defined in the schema but
  never read in code.
- **Test that documented config properties are consumed** — for each config
  property in the schema, write a test that sets it and verifies it affects
  the documented behavior. Missing tests mean the property may be silently
  ignored.

### 45. Validate the Exact Value — Never Normalize First, Never Let Non-Finite Fall Through

Two failure shapes, both caught in review on a *deletion planner*, both of
which resolve toward the destructive branch. Neither has a textual
signature (see the receipts in `.omp/rules/README.md`), so they are checked
here, by hand, on every validator you write.

- **Never normalize an input before validating it.** `isRefusable(p)` that
  starts with `p.trim()` will accept `" activity/x.md"` as owned and then
  act on `"activity/x.md"` — a value the caller never supplied. Validate
  the exact string; use `trim()` only to detect blankness, and treat
  surrounding whitespace as a refusal in its own right. The same applies to
  case folding, separator rewriting, and Unicode normalization: every
  "helpful" transform before the check widens what passes it.
- **Never let a non-finite number fall through a comparison.** Every
  comparison against `NaN` is `false`, so a corrupt timestamp makes
  `now - captured < window` false, which a retention check reads as
  "not retained" — and the item is queued for deletion. Reject or refuse
  non-finite numbers explicitly, before the decision, and choose the
  refusal branch rather than the permissive one. `Number.isFinite` on every
  externally-sourced number that feeds a delete, supersede, tombstone, or
  authority decision.

The general rule both instances share: when a guard's two outcomes are
"keep data" and "destroy data", an unparseable or unexpected input MUST
resolve to "keep". Write the test that feeds it `NaN`, `Infinity`, and a
whitespace-padded path, and assert nothing was planned for deletion.

### 46. Key Validation Must Read the Same Keys It Validates

Two bypasses of the same allow-list shipped one review round apart, both in
a config gate resolver, both because the validating loop and the reading
expression disagreed about which keys exist.

- **`Object.keys` enumerates own, ENUMERABLE properties.** A key defined with
  `Object.defineProperty(obj, "x", { value: v, enumerable: false })` is
  invisible to it — and still readable by `obj.x`. Validate with
  `Object.getOwnPropertyNames`.
- **A bracket read follows the prototype chain.** After validating with
  `Object.keys(raw)`, `raw[gate]` still honors an inherited `gate`, so an
  object with a doctored prototype enables something the allow-list never
  approved. Gate every read on `Object.hasOwn(raw, key)`.
- **Present-with-`undefined` is not absent.** `hasOwn` true plus an
  `undefined` value is a caller that explicitly set nothing, which composed
  config objects produce constantly. If the API promises to reject invalid
  values, that value must go through the validator, not silently default.

The rule: enumerate with `getOwnPropertyNames`, read with `hasOwn`, and treat
presence and validity as separate questions. Add a regression with a
non-enumerable key and one with an inherited key — both are three lines.

### 47. A Frozen `as const` Must Not Be Annotated `readonly T[]`

`Object.freeze([...] as const)` already delivers both halves: runtime
immutability and a narrow literal tuple. Adding `: readonly string[]` throws
the second half away, so a derived `type X = (typeof LIST)[number]` widens to
`string` and consumers can assign values the runtime rejects.

This shipped as a regression *inside a hardening fix*: a review round asked
for a frozen registry, the fix added `Object.freeze` and the annotation
together, and the next round caught that the gate union had silently become
`string`. When a call site then rejects the narrow type (usually
`.includes(someString)`), cast at that call site —
`(LIST as readonly string[]).includes(key)` — rather than widening the
declaration for every consumer.

Pin it so it cannot regress silently:

```ts
// @ts-expect-error "bogus" is not a Gate
const bad: Gate = "bogus";
```

An unused `@ts-expect-error` is itself a compile error, so that line fails the
build the moment the union widens. A regex cannot police this — the annotation
is legitimate on the many frozen *data* arrays that have no derived union
(measured: 13 such arrays in this repo), which is why it lives here.

### 48. Every Claim in a PR, Comment, or Changeset Must Be Enforced or Deleted

Reviewers reject prose that the code does not back, and they are right to:
a false guarantee is worse than a missing one, because the next reader stops
checking.

Two instances shipped in one run and both were caught:

- A metadata record was described as "structurally incapable of carrying
  content" while its validator accepted any single-line string under 200
  characters — `"Summarize this user's activity"` passed. Either enforce the
  claim (identifier syntax, which is what landed) or delete it.
- A helper was called an "internal helper" in its changeset while being
  re-exported from the package entry point, giving consumers a wrong
  lifecycle signal.

Before pushing, take every guarantee in the PR body, the module header, and
the changeset, and name the line of code or the test that enforces it. A
comment is not enforcement: put the invariant in the types, in a validator,
or in an assertion. If none of those is practical, weaken the sentence to
what is true — "takes no path to write to" is a fact; "cannot corrupt data"
is a claim.

---
