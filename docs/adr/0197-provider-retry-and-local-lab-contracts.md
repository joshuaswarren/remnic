# Provider integrations keep billing, retry, timeout, and error surfaces explicit: salvage only what provably succeeded, budget each retry class separately, and never leak secrets or paths

Status: accepted

## Context
The bench providers run real CLI subprocesses and local LLM daemons under benchmark timeouts. Bounded trials showed ~8% of tasks spuriously scored 0 because Claude Code exited non-zero for reasons unrelated to the completion (a failing user hook, a teardown race) while still emitting a complete zero-error envelope; shared retry counters let usage-limit cycles exhaust transient budgets; ambient credentials silently switched children to metered API billing; and raw Node error messages leaked absolute paths into surfaced diagnostics.

This ADR merges the sweep themes: claude-cli-env-billing-isolation, claude-cli-shared-concurrency-gate, claude-cli-gate-timeout-semantics, claude-cli-independent-retry-counters, claude-cli-salvage-parse-before-exit-gate, claude-cli-usage-limit-failure-paths-only, claude-cli-error-diagnostics-stdout-head, claude-cli-timeout-never-salvageable, claude-cli-non-string-result-coercion, claude-cli-strict-is-error-check, claude-cli-usage-limit-budget-exhaustion, claude-cli-no-internal-gateway, retry-fetch-timeout-not-retried-by-default, retry-fetch-429-budget-extends-maxattempts, local-llm-base-url-guard, codex-cli-provider-timeout, local-lab-runtime-options-contract, local-lab-error-message-hygiene, local-lab-temperature-zero-contract, local-lab-preflight-timeout-controller, local-lab-no-apikeys-in-manifests, local-lab-quantization-not-on-providerconfig, local-lab-provider-kind-guard, local-lab-test-fidelity, ollama-baseurl-api-regression.

Merged sweep themes: claude-cli-env-billing-isolation, claude-cli-shared-concurrency-gate, claude-cli-gate-timeout-semantics, claude-cli-independent-retry-counters, claude-cli-salvage-parse-before-exit-gate, claude-cli-usage-limit-failure-paths-only, claude-cli-error-diagnostics-stdout-head, claude-cli-timeout-never-salvageable, claude-cli-non-string-result-coercion, claude-cli-strict-is-error-check, claude-cli-usage-limit-budget-exhaustion, claude-cli-no-internal-gateway, retry-fetch-timeout-not-retried-by-default, retry-fetch-429-budget-extends-maxattempts, local-llm-base-url-guard, codex-cli-provider-timeout, local-lab-runtime-options-contract, local-lab-error-message-hygiene, local-lab-temperature-zero-contract, local-lab-preflight-timeout-controller, local-lab-no-apikeys-in-manifests, local-lab-quantization-not-on-providerconfig, local-lab-provider-kind-guard, local-lab-test-fidelity, ollama-baseurl-api-regression.

## Decision
**claude-cli provider:**
- The child environment is an explicit allow-list. Ambient provider API keys are forwarded ONLY when the caller explicitly configured one — forwarding by default would silently switch the child from subscription auth to metered API billing.
- One process-wide concurrency gate serializes `claude -p` across all provider instances in the process.
- The per-attempt timeout arms only once the gate is acquired — it never counts queue time. A caller-provided signal keeps counting while queued, and the provider must not spawn a doomed child for a call whose signal already fired while queued: fail fast before spawn.
- Retry mechanisms are INDEPENDENT and never share a counter: usage-limit backoff is budget-bounded and deliberately bypasses maxAttempts (it throws when the next required backoff step exceeds its budget); transient-failure retries are count-bounded by maxAttempts. A shared counter let usage-limit cycles prematurely exhaust the transient budget and inflated both backoff exponents.
- Parse the stdout envelope BEFORE gating on exit status: a parseable payload with `is_error` unset (checked strictly as a boolean) and non-empty result text is a successful completion regardless of a non-zero exit.
- A timed-out or aborted completion is NEVER salvageable regardless of exit status — a child that catches SIGTERM can exit 0 with a partial envelope.
- `result` is cast from untrusted CLI JSON and may be a non-string; anything non-string coerces to empty so `.trim()` cannot throw and the value falls into the controlled "no result text" path.
- Usage-limit/rate-limit detection is restricted to FAILURE paths (non-zero exits, is_error payloads). A successful answer that merely mentions "rate limit" or "429" never triggers backoff.
- Failure diagnostics include the stdout HEAD (type/subtype/is_error/result live there; the summary tails it) alongside the tail, so deterministic per-task failures are classifiable from the run log alone.

**retry-fetch:**
- Transient transport failures and 5xx retry with exponential backoff, capped by maxAttempts. The 429 wait budget only EXTENDS retries beyond maxAttempts, and only for pure-429 sequences — no non-429 failure since the last 429, and only when a retryable response has already been observed. With the default budget of 0, the loop always breaks and throws the last error. Request timeouts are not retried by default. When the extended budget is configured, transient server errors continue within that same wall-clock budget so cloud throttling does not become a false benchmark task failure.

**Runtime profiles and local-lab:**
- The CLI rejects remote base URLs for local LLMs (defense in depth), and there is no internal gateway wiring for the claude-cli provider in the core layer or the profiles — programmatic callers get the same guard. A Codex CLI completion is a subprocess-backed model turn with the same timeout semantics.
- Local-lab runtime options appear in effective config only when actually configured — the manifest-only common case must not sprout empty retry options or provider overrides.
- Local-lab manifests never carry API keys: provider + model + baseUrl + temperature + seed only; operator auth is out-of-band.
- `temperature` must be exactly the number 0 — the reproducibility contract. Anything else (string "0", null, missing, non-zero) is rejected, never silently coerced.
- Error hygiene: never echo raw Node error.message (it embeds absolute paths and system diagnostics); surface the stable errno code instead (ENOENT, EACCES, …). JSON.parse errors carry position info but no filesystem paths, so that detail is safe to surface.
- Preflight always creates an internal controller with its timeout timer, even when a caller signal is supplied — without it a caller signal disables the documented per-request timeout entirely.
- Quantization is recorded on the resolved role (for artifacts), never added to ProviderConfig — that would be a breaking change to the existing transport contract; tests verify the runtime property is absent without claiming the type has it.
- A manifest provider kind must map to a known built-in provider; anything else throws. The documented sample Ollama baseUrl without the /api suffix must still reach /api/generate — discovery succeeded while generation 404ed once, so it is regression-tested. Test stubs capture the request URL so tests can assert discovery endpoints.

## Consequences
Salvage logic trusts only strict evidence, so genuinely broken invocations still fail — the price of not over-salvaging is manual triage of the residual failure class. Budget-bounded backoff can give up where count-bounded retry would have continued. Strict validation (temperature, provider kinds) rejects configs a coercing loader would have accepted.

## Origin comments
- `packages/bench/src/local-lab/manifest.test.ts:182` — "// Node readFile errors embed the absolute path + system diagnostics in"
- `packages/bench/src/local-lab/manifest.test.ts:183` — "// error.message. The thrown error must use the stable errno code instead."
- `packages/bench/src/local-lab/manifest.test.ts:189` — "// The absolute path appears once (as filePath) but must NOT be doubled"
- `packages/bench/src/local-lab/manifest.test.ts:190` — "// by a raw Node message like \"open '/tmp/...'\"."
- `packages/bench/src/local-lab/manifest.test.ts:206` — "// JSON.parse errors carry position info but not file-system paths,"
- `packages/bench/src/local-lab/manifest.test.ts:207` — "// so the detail is safe to surface."
- `packages/bench/src/local-lab/manifest.ts:130` — "// Do not echo raw error.message — Node read errors embed the absolute"
- `packages/bench/src/local-lab/manifest.ts:131` — "// path and system diagnostics. Use the errno code (ENOENT, EACCES, …)"
- `packages/bench/src/local-lab/manifest.ts:132` — "// which is stable and free of path leakage (cursor review, #1573 PR2)."
- `packages/bench/src/local-lab/manifest.ts:141` — "// JSON.parse errors carry a position hint but no file-system paths."
- `packages/bench/src/local-lab/manifest.ts:162` — "// `temperature` must be exactly the number 0 — local-lab reproducibility"
- `packages/bench/src/local-lab/manifest.ts:163` — "// contract. Anything else (string \"0\", null, missing, non-zero) is rejected"
- `packages/bench/src/local-lab/manifest.ts:164` — "// rather than silently coerced (rule 39)."
- `packages/bench/src/local-lab/preflight.test.ts:11` — "/** * Stub fetch that responds with a fixed body + status. Captures the request * URL so tests can assert the discover"
- `packages/bench/src/local-lab/preflight.ts:90` — "// Always create an internal controller with the timeout timer, even when a"
- `packages/bench/src/local-lab/preflight.ts:91` — "// caller signal is supplied. Without this, a caller-provided signal"
- `packages/bench/src/local-lab/preflight.ts:92` — "// disables the documented per-request timeout entirely (codex review, #1573 PR2)."
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:87` — "// quantization is recorded on the resolved role (for artifacts/PR3), NOT on"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:88` — "// ProviderConfig (which has no such field — adding one would be a breaking"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:89` — "// change to the existing transport contract). Cast through a record to"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:90` — "// verify the runtime property is absent without claiming the type has it."
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:128` — "// Regression: an Ollama role with the documented sample baseUrl"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:129` — "// (http://127.0.0.1:11434, no /api) caused the provider to POST to"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:130` — "// /generate instead of /api/generate (404) while preflight succeeded"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:131` — "// because discoveryEndpointFor already appended /api/tags."
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:199` — "// The shape matches: provider + model + baseUrl + temperature + seed are all"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:200` — "// present, and there are no API keys (manifests deliberately never carry"
- `packages/bench/src/local-lab/resolve-local-lab-profile.test.ts:201` — "// them — operator auth is out-of-band)."
- `packages/bench/src/local-lab/resolve-local-lab-profile.ts:141` — "/** * Map a manifest provider kind to the bench `BuiltInProvider` enum. Throws * on any value not in `LOCAL_LAB_PROVID"
- `packages/bench/src/providers/claude-cli.ts:79` — "/** * Runtime env keys forwarded to the `claude` child process. Deliberately * does NOT include ANTHROPIC_API_KEY / ANTH"
- `packages/bench/src/providers/claude-cli.ts:151` — "/** Serializes `.complete()` calls so the harness never fires concurrent * `claude -p` invocations against the operator'"
- `packages/bench/src/providers/claude-cli.ts:226` — "/** Process-wide `claude -p` concurrency gate, shared by every * `ClaudeCliProvider` instance in this process (see `Clau"
- `packages/bench/src/providers/claude-cli.ts:290` — "// Runs AFTER the shared concurrency gate has been acquired (see"
- `packages/bench/src/providers/claude-cli.ts:291` — "// `complete()` -> `gate.run`), so the per-attempt timeout armed inside"
- `packages/bench/src/providers/claude-cli.ts:292` — "// `runClaudeCliCommand` only starts counting once this call is actually"
- `packages/bench/src/providers/claude-cli.ts:293` — "// active, never while it was queued. A caller-provided `opts.signal`"
- `packages/bench/src/providers/claude-cli.ts:294` — "// (e.g. a harness phase/trial timeout) is owned by the caller and does"
- `packages/bench/src/providers/claude-cli.ts:295` — "// keep counting while queued; the provider can't extend it, but it MUST"
- `packages/bench/src/providers/claude-cli.ts:296` — "// NOT spawn a doomed `claude -p` for a call whose signal already fired"
- `packages/bench/src/providers/claude-cli.ts:297` — "// while it waited in the gate — fail fast here instead."
- `packages/bench/src/providers/claude-cli.ts:306` — "// These two retry mechanisms are INDEPENDENT and must not share a counter:"
- `packages/bench/src/providers/claude-cli.ts:307` — "// usage-limit backoff is budget-bounded (deliberately bypasses maxAttempts),"
- `packages/bench/src/providers/claude-cli.ts:308` — "// while transient-failure retries are count-bounded by maxAttempts. A single"
- `packages/bench/src/providers/claude-cli.ts:309` — "// shared counter let usage-limit cycles prematurely exhaust the transient"
- `packages/bench/src/providers/claude-cli.ts:310` — "// budget (and inflated each mechanism's backoff exponent). (#1735 review)"
- `packages/bench/src/providers/claude-cli.ts:320` — "// Parse the stdout envelope BEFORE gating on the exit status. Claude"
- `packages/bench/src/providers/claude-cli.ts:321` — "// Code can exit non-zero for reasons unrelated to the completion"
- `packages/bench/src/providers/claude-cli.ts:322` — "// itself (a failing user hook, a teardown race) while still emitting"
- `packages/bench/src/providers/claude-cli.ts:323` — "// a complete zero-error result envelope — the dominant source of"
- `packages/bench/src/providers/claude-cli.ts:324` — "// spuriously 0-scored tasks in the 2026-07-08 bounded trials (~8%"
- `packages/bench/src/providers/claude-cli.ts:325` — "// of tasks). A parseable payload with `is_error` unset and"
- `packages/bench/src/providers/claude-cli.ts:326` — "// non-empty result text is a successful completion regardless of"
- `packages/bench/src/providers/claude-cli.ts:336` — "// Usage-limit detection is deliberately restricted to FAILURE"
- `packages/bench/src/providers/claude-cli.ts:337` — "// paths (non-zero exits here, is_error payloads below). A"
- `packages/bench/src/providers/claude-cli.ts:338` — "// successful benchmark answer that merely mentions \"rate limit\""
- `packages/bench/src/providers/claude-cli.ts:339` — "// or \"429\" must never trigger backoff."
- `packages/bench/src/providers/claude-cli.ts:352` — "// Diagnostics: the envelope's identifying fields live at the HEAD"
- `packages/bench/src/providers/claude-cli.ts:353` — "// of stdout (type/subtype/is_error/result), but the summary tails"
- `packages/bench/src/providers/claude-cli.ts:354` — "// it — include the head explicitly so deterministic per-task"
- `packages/bench/src/providers/claude-cli.ts:355` — "// failures are classifiable from the run log alone (live 2026-07-13"
- `packages/bench/src/providers/claude-cli.ts:356` — "// full-run triage: ~8% of tasks failed with a parseable envelope"
- `packages/bench/src/providers/claude-cli.ts:357` — "// that was not salvageable, invisible from the tail)."
- `packages/bench/src/providers/claude-cli.ts:378` — "// A timed-out or aborted completion is never salvageable, regardless of"
- `packages/bench/src/providers/claude-cli.ts:379` — "// exit status — a child that catches SIGTERM can exit 0 with a partial"
- `packages/bench/src/providers/claude-cli.ts:380` — "// envelope in stdout. The salvage guard above catches status!=0; this"
- `packages/bench/src/providers/claude-cli.ts:381` — "// catches the status==0 edge (codex P2)."
- `packages/bench/src/providers/claude-cli.ts:416` — "// `result` is `as`-cast from untrusted CLI JSON, so it may be a"
- `packages/bench/src/providers/claude-cli.ts:417` — "// non-string (number/boolean/object/array). Coerce anything that"
- `packages/bench/src/providers/claude-cli.ts:418` — "// isn't a string to empty so `.trim()` can't throw a TypeError — a"
- `packages/bench/src/providers/claude-cli.ts:419` — "// non-string result falls into the same controlled \"no result text\" /"
- `packages/bench/src/providers/claude-cli.ts:653` — "// Opt-in only: forwarding an ambient ANTHROPIC_API_KEY by default would"
- `packages/bench/src/providers/claude-cli.ts:654` — "// silently switch the child from free subscription auth to metered API"
- `packages/bench/src/providers/claude-cli.ts:655` — "// billing. Only set it when the caller explicitly configured one."
- `packages/bench/src/providers/claude-cli.ts:745` — "/** * Strict boolean check for the CLI's `is_error` flag (PR #1735 review, * finding 2). `parseClaudeCliJsonResult` cast"
- `packages/bench/src/providers/claude-cli.ts:828` — "/** * Backoff for detected usage-limit/rate-limit failures. Gives up (throws) * when the NEXT required backoff step no l"
- `packages/bench/src/providers/retry-fetch.ts:1` — "/** * Fetch wrapper with retry for transient failures. * Retries on ECONNREFUSED, ECONNRESET, transport ETIMEDOUT, HTTP "
- `packages/bench/src/providers/retry-fetch.ts:174` — "// Non-429 errors (transient, 5xx) are always capped by maxAttempts."
- `packages/bench/src/providers/retry-fetch.ts:175` — "// The 429 budget only extends retries for 429 responses beyond maxAttempts."
- `packages/bench/src/providers/retry-fetch.ts:179` — "// Only return a saved 429 when the budget feature is active and"
- `packages/bench/src/providers/retry-fetch.ts:180` — "// no non-429 failures have occurred since the last 429."
- `packages/bench/src/providers/retry-fetch.ts:181` — "// With max429WaitMs=0 (default), always break to throw lastError."
- `packages/bench/src/providers/retry-fetch.ts:185` — "// Past maxAttempts but within the extended provider budget — only"
- `packages/bench/src/providers/retry-fetch.ts:186` — "// continue if a retryable response/error has already been observed."
- `packages/bench/src/providers/retry-fetch.ts:222` — "// Stop if past maxAttempts with no budget remaining."
- `packages/bench/src/providers/retry-fetch.ts:223` — "// Under maxAttempts, 429s always retry regardless of budget —"
- `packages/bench/src/providers/retry-fetch.ts:224` — "// the budget only EXTENDS retries beyond maxAttempts."
- `packages/bench/src/providers/retry-fetch.ts:270` — "// 5xx — retry with exponential backoff. When an extended provider"
- `packages/bench/src/providers/retry-fetch.ts:271` — "// wait budget is configured, keep retrying transient server errors"
- `packages/bench/src/providers/retry-fetch.ts:272` — "// within that same wall-clock budget so cloud throttling does not"
- `packages/bench/src/providers/retry-fetch.ts:273` — "// become a false benchmark task failure."
- `packages/bench/src/runtime-profiles.test.ts:726` — "// Regression: the local-lab branch built ProviderConfig values only from the"
- `packages/bench/src/runtime-profiles.test.ts:815` — "// The explicit /api form used by run-tierf-opus.sh is an identity"
- `packages/bench/src/runtime-profiles.test.ts:894` — "// The manifest-only common case must not sprout empty retryOptions or"
- `packages/bench/src/runtime-profiles.test.ts:934` — "// Regression: resolveLocalLabRuntimeProfile built effectiveRemnicConfig from"
- `packages/bench/src/runtime-profiles.ts:494` — "// Issue #566 slice 5 — defense in depth: the CLI rejects"
- `packages/bench/src/runtime-profiles.ts:505` — "// PR #1735 review: defense in depth for programmatic callers that bypass"
- `packages/bench/src/runtime-profiles.ts:526` — "// A Codex CLI completion is a subprocess-backed model turn, including for"
- `packages/bench/src/runtime-profiles.ts:696` — "// PR #1735 review: `@remnic/core` only special-cases `api ==="
- `packages/bench/src/runtime-profiles.ts:730` — "// PR #1735 review: no internal gateway wiring for claude-cli (see"
