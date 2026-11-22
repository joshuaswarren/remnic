# The Codex subscription provider authenticates only via the operator's CLI login, runs the child fully sandboxed with an allowlisted environment, redacts all child output, and treats timeouts as timeouts - never as auth failures.

Status: accepted

## Context
Extraction traffic is routed through a local codex CLI subprocess that shares the operator's terminal environment; ambient API keys, relative paths, and unbounded output would leak credentials, misbehave across cwds, or misclassify deadline expiry as an auth problem.

## Decision
The provider is a built-in entry so `codex-subscription/<model>` chains resolve with no models.json or apiKey; a configured apiKey is rejected as a configuration mistake. The child environment is an explicit allowlist (path-valued keys resolved against the original process cwd first); ambient OPENAI_API_KEY/OPENAI_BASE_URL never reach the child. Child processes run fully sandboxed and ephemeral (no tools/hooks/plugins/memories - extraction must be deterministic), with web_search removed at the config level so extraction text cannot cause browsing. Messages are written one JSON object per line so role boundaries are structural; literal role-marker text in content cannot impersonate a system turn.

Path handling: relative executable paths are resolved against the original process cwd before spawn (the exec child's cwd is the temp workspace), and login/exec children see the same absolute, daemon-cwd-anchored directories. Runners are owned per runtime/config object so teardown cannot cross instances, and the core transport registers only when no runner exists yet.

Deadlines and errors: the effective deadline starts before the login-status precheck (login consumes, not adds to, the call budget); a caller joins a shared login check with its own budget and rejects on its own deadline while the shared check keeps running; login-status results are cached briefly. A subprocess timeout is a deadline expiry, never reported as "unauthenticated", and the authoritative timeout marker wins over 401/403 text a timed-out exec may have already printed. Child output is streamed bounded (tail kept, where the final error lives), secret-redacted, and only the redacted bounded tail ever reaches a thrown error. The provider reads the auth store as mtime:size metadata only - never its contents.

## Consequences
The provider cannot use any ambient OpenAI credential by design; wall-clock deadline races are inherent to the shared-check design; output tails may truncate long mid-stream diagnostics.
## Origin comments
(55 records)
- `packages/remnic-core/src/providers/codex-subscription.test.ts:73` - "// Frozen clock: the fake login consumes zero budget, so exec timeout"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:74` - "// assertions stay exact."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:123` - "// Ambient OpenAI credentials must not reach the child: the subscription"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:124` - "// login — not an API key — has to authenticate the request."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:176` - "// Config-level disable, not a prompt-level request: the web_search tool is"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:177` - "// removed from the session, so extraction text cannot cause browsing."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:456` - "// The shared login subprocess uses the 10s ceiling; this caller still"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:457` - "// spends its 5s budget and exec only gets what login left: 5s - 2s."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:530` - "// Layout: 50 chars | 25-char secret | 479 chars. The 500-char tail window"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:531` - "// starts 4 chars INTO the secret, so truncating first would expose"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:532` - "// "ive-abcdefgh12345678" with no matchable sk- prefix."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:627` - "// The exec child runs with cwd = temp workspace; ./codex-fake must point"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:628` - "// at the operator's original cwd, not the scratch dir."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:675` - "/** Yield the event loop so synchronously-started fakes register before * assertions sample them (no wall-clock sleep)"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:685` - "/** A runner's child untracks on the child's async exit event, which can * land after the runner promise already settl"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:723` - "// Request B has a tiny budget: it must reject on ITS deadline while A's"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:724` - "// shared check keeps running. Real timer by design: the budget arithmetic"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:725` - "// uses the injected fake clock, but the deadline race itself exercises the"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:726` - "// provider's actual timer behavior."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1185` - "// The login child and the workspace-cwd exec child must see the SAME"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1186` - "// absolute directories, anchored to the daemon's cwd — not whichever cwd"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1187` - "// each child happens to run in."
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1375` - "// Real timer by design: the deadline race is wall-clock behavior. The"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1376` - "// exec "child" ignores the abort signal (like one already mid-close)"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1377` - "// and settles 35ms after its own 475ms budget — past the caller's"
- `packages/remnic-core/src/providers/codex-subscription.test.ts:1378` - "// 500ms deadline but inside the 25ms settle grace (T=500 -> 25 headroom)."
- `packages/remnic-core/src/providers/codex-subscription.ts:1` - "/** * Codex subscription extraction provider (issue #2784). * * Routes extraction/consolidation LLM calls through the `c"
- `packages/remnic-core/src/providers/codex-subscription.ts:46` - "/** * Env keys whose value is a filesystem path. Relative values resolve against * the original process cwd before eithe"
- `packages/remnic-core/src/providers/codex-subscription.ts:53` - "/** * Environment keys forwarded to the codex child. Everything else — including * ambient `OPENAI_API_KEY` / `OPENAI_BA"
- `packages/remnic-core/src/providers/codex-subscription.ts:115` - "/** * Built-in provider entry so `"codex-subscription/<model>"` chains resolve * with no models.json and no apiKey — the"
- `packages/remnic-core/src/providers/codex-subscription.ts:251` - "/** One runner per owning runtime/config object so teardown cannot cross instances. */"
- `packages/remnic-core/src/providers/codex-subscription.ts:269` - "/** * Registers the core subprocess transport on the codex-cli seam, but only * when no runner is registered yet — a hos"
- `packages/remnic-core/src/providers/codex-subscription.ts:337` - "// The effective deadline starts BEFORE the login-status precheck: login"
- `packages/remnic-core/src/providers/codex-subscription.ts:338` - "// consumes the same call/provider timeout budget, it is not additive."
- `packages/remnic-core/src/providers/codex-subscription.ts:406` - "/** * This provider authenticates exclusively through the codex CLI login, so a * configured apiKey is a configuration m"
- `packages/remnic-core/src/providers/codex-subscription.ts:425` - "// The exec child runs with cwd = the temp workspace, and spawn resolves a"
- `packages/remnic-core/src/providers/codex-subscription.ts:426` - "// relative executable against the CHILD cwd. Resolve relative paths against"
- `packages/remnic-core/src/providers/codex-subscription.ts:427` - "// the original process cwd now so `./codex` stays valid; bare names keep"
- `packages/remnic-core/src/providers/codex-subscription.ts:428` - "// PATH lookup."
- `packages/remnic-core/src/providers/codex-subscription.ts:447` - "/** * The exec child runs with cwd = the ephemeral workspace while the login * child runs with cwd = this process, so a "
- `packages/remnic-core/src/providers/codex-subscription.ts:473` - "/** * Verifies the operator's Codex subscription login via `codex login status`. * Success is cached briefly; failures a"
- `packages/remnic-core/src/providers/codex-subscription.ts:551` - "// A login-status subprocess timeout is a deadline expiry, not an auth"
- `packages/remnic-core/src/providers/codex-subscription.ts:552` - "// failure — never report it as "unauthenticated"."
- `packages/remnic-core/src/providers/codex-subscription.ts:568` - "/** * Waits on a shared login check with this caller's own budget. A deadline or * caller abort rejects immediately — wi"
- `packages/remnic-core/src/providers/codex-subscription.ts:590` - "// Identity matters: the same reference is removed in the finally below."
- `packages/remnic-core/src/providers/codex-subscription.ts:597` - "// The deadline timer intentionally holds the event loop: this caller's"
- `packages/remnic-core/src/providers/codex-subscription.ts:598` - "// await is backed by nothing else while the shared check is in flight."
- `packages/remnic-core/src/providers/codex-subscription.ts:630` - "/** * `mtimeMs:size` of the Codex auth store, read as metadata only — the * provider never reads the store's contents. A"
- `packages/remnic-core/src/providers/codex-subscription.ts:676` - "/** * Args mirror the bench provider: fully sandboxed, ephemeral, no tools/hooks/ * plugins/memories — extraction must b"
- `packages/remnic-core/src/providers/codex-subscription.ts:764` - "/** * One JSON object per message: role boundaries are structural (JSON string * escaping), so literal `[system]`/role-m"
- `packages/remnic-core/src/providers/codex-subscription.ts:790` - "// The authoritative timeout marker wins over auth-pattern text: a timed-out"
- `packages/remnic-core/src/providers/codex-subscription.ts:791` - "// exec may have already printed model/diagnostic output containing 401/403"
- `packages/remnic-core/src/providers/codex-subscription.ts:792` - "// before the deadline fired (issue #2833)."
- `packages/remnic-core/src/providers/codex-subscription.ts:812` - "/** Secret-redacted, then bounded tail of child output — the only child text * that ever reaches a thrown error. Redacti"
- `packages/remnic-core/src/providers/codex-subscription.ts:891` - "/** Bounds streamed child output to STDIO_LIMIT, keeping the TAIL — codex * prints its final error or turn.completed res"
