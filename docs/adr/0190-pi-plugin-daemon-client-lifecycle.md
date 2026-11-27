# Pi plugin daemon access is probed once per startup, bounded by explicit budgets, and guarded against staleness

Status: accepted

## Context
Pi plugin hooks run inside the host's roughly 30-second handler window with a fixed per-turn request budget. Several hooks (namespace preflight, recall, observe, compaction, MCP tool registration) each want to call the daemon, so a dead or saturated daemon would burn the whole budget hook by hook. Recalls can outlive the session that started them or outlive a reachability change, and a transient startup failure used to register zero MCP tools for a session that otherwise looked healthy.

## Decision
- Session start performs one bounded startup probe. Its verdict updates the shared circuit breaker and reachability unconditionally — even when the status UI is off — while the status label itself stays gated on `statusEnabled`. The probe chain runs in the background; its promise is stored on session state so first-turn hooks can await it.
- First-turn daemon calls join the in-flight startup probe instead of issuing their own request; an unreachable daemon is skipped, not recalled.
- When startup proves the daemon unreachable, the fast-skip breaker trips immediately; otherwise the first live hook spends the full turn budget on a doomed request. Budget exhaustion inside a turn — transient connection failures that consumed the whole deadline, or a shared chunked-observe deadline exhausted across chunks — is classified as effectively-unreachable for the turn: trip the breaker and cool down. These errors arise only from transient connection failures, never from a semantic HTTP response. A 503 "not ready" answer is server backpressure, not unreachability. Any HTTP response from the daemon clears a stale cooldown a prior timeout left on the shared client.
- The startup drain makes one cheap attempt. Whatever stays queued replays on the next successful contact; the drain runs in the background with its own error handling so it can neither delay the hook nor turn a delivered live turn into a failed one.
- Shutdown observe is the exception to both the breaker and the per-turn budget: teardown is the last chance to observe the branch, so the attempt is forced even mid-cooldown and runs under the general request budget. A failure there still trips the breaker normally.
- Live turn hooks share one deadline across their daemon calls and never retry within it, so a stalled daemon costs at most one deadline instead of one per call. A minimum-budget floor only decides whether a retry may start, never how long a request may take.
- MCP tool registration retries once within the remaining startup budget and records a warning-state entry when the catalog still cannot be listed — including when the first attempt exhausted the budget and the retry never started. A catalog that mixes shapes registers only the first occurrence of each Pi-safe name.
- Recall's cached context is populated once from the user's prompt text and injected into the system prompt byte-identically on every turn to preserve the KV-cache prefix. Injection goes through the system prompt, never the context hook: the host's message union has no system role, and context-hook system messages produce an invalid provider payload the host drops.
- Before an in-flight recall proceeds, capture the startup epoch and the reachability generation. A recall that outlives a session start must not overwrite the newer epoch's state, and a recall that outlives a newer reachability success must not stamp a stale unreachable; unreachable-marking is a no-op once the generation has moved.
- Registration tests gate `tools/list` responses on explicit test control so overlapping registration windows are deterministic without any wall-clock wait.

## Consequences
An offline daemon costs one probe plus breaker bookkeeping instead of a full budget per hook. Cached context only changes by re-population, first-turn hooks depend on the stored probe promise, and shutdown may legitimately exceed the per-turn budget.

## Origin comments
- `packages/plugin-pi/src/index.ts:200` — "// One cheap attempt: a dead daemon must not hold session start behind retry and"
- `packages/plugin-pi/src/index.ts:201` — "// backoff ladders; whatever stays queued replays on the next successful contact."
- `packages/plugin-pi/src/index.ts:205` — "// Probe health + update the circuit breaker UNCONDITIONALLY so an offline"
- `packages/plugin-pi/src/index.ts:206` — "// daemon is marked unreachable even when the status UI is off; otherwise"
- `packages/plugin-pi/src/index.ts:207` — "// the namespace preflight and every later hook each burn a full request"
- `packages/plugin-pi/src/index.ts:208` — "// budget on a doomed call. The status LABEL stays gated on statusEnabled."
- `packages/plugin-pi/src/index.ts:209` — "// The chain runs in the background (#3273 phase 1); the promise is kept on"
- `packages/plugin-pi/src/index.ts:210` — "// session state so first-turn hooks can await it."
- `packages/plugin-pi/src/index.ts:228` — "// On the first before_agent_start, populate the cache using the user's"
- `packages/plugin-pi/src/index.ts:229` — "// prompt text so semantic recall produces relevant results. Once"
- `packages/plugin-pi/src/index.ts:230` — "// populated, the cached context is appended to the system prompt on"
- `packages/plugin-pi/src/index.ts:231` — "// every turn for KV cache prefix stability (PR #2208)."
- `packages/plugin-pi/src/index.ts:232` — "// Join the in-flight startup probe (bounded) so an unreachable daemon is skipped, not recalled."
- `packages/plugin-pi/src/index.ts:244` — "// Capture the epoch now: a session_start during the in-flight recall"
- `packages/plugin-pi/src/index.ts:245` — "// bumps startupEpoch and resets context, so a stale recall must not"
- `packages/plugin-pi/src/index.ts:246` — "// overwrite the new epoch's state (#3273 review)."
- `packages/plugin-pi/src/index.ts:248` — "// And sample the reachability generation so a recall that outlives a"
- `packages/plugin-pi/src/index.ts:249` — "// newer reachability success cannot stamp a stale unreachable (#3273"
- `packages/plugin-pi/src/index.ts:250` — "// review): markUnreachableIfGeneration no-ops once generation moved."
- `packages/plugin-pi/src/index.ts:290` — "// Inject cached context into the system prompt — byte-identical across"
- `packages/plugin-pi/src/index.ts:291` — "// turns so the KV cache prefix is preserved. This avoids the"
- `packages/plugin-pi/src/index.ts:292` — "// system-role message issue: Pi's AgentMessage union does not include"
- `packages/plugin-pi/src/index.ts:293` — "// "system", so injecting via the context hook produced an invalid"
- `packages/plugin-pi/src/index.ts:294` — "// provider payload that Pi drops (codex review)."
- `packages/plugin-pi/src/index.ts:307` — "// Observe is a first-turn daemon call gated on isReachable(): join the in-flight probe first."
- `packages/plugin-pi/src/index.ts:342` — "// omp aborts this hook at ~30s. One deadline covers all three calls and none retries, so a"
- `packages/plugin-pi/src/index.ts:343` — "// stalled daemon costs at most turnRequestTimeoutMs here instead of requestTimeoutMs per call."
- `packages/plugin-pi/src/index.ts:476` — "// The daemon responded (any HTTP result), so clear any stale cooldown a"
- `packages/plugin-pi/src/index.ts:477` — "// prior timeout left on the shared client (cursor review)."
- `packages/plugin-pi/src/index.ts:582` — "// A transient failure at session start used to silently register zero"
- `packages/plugin-pi/src/index.ts:583` — "// tools for the whole session (recall kept working, so the session looked"
- `packages/plugin-pi/src/index.ts:584` — "// healthy). Retry once inside the remaining startup budget, and record a"
- `packages/plugin-pi/src/index.ts:585` — "// warning state entry when the catalog still cannot be listed."
- `packages/plugin-pi/src/index.ts:594` — "// Honor the configured budget exactly: the floor only decides whether"
- `packages/plugin-pi/src/index.ts:595` — "// a retry may start, never how long a request may take."
- `packages/plugin-pi/src/index.ts:603` — "// Warn on every terminal failure — including when the first attempt"
- `packages/plugin-pi/src/index.ts:604` — "// exhausted the budget and the retry never started."
- `packages/plugin-pi/src/index.ts:623` — "// A catalog that mixes shapes could map two names onto one Pi-safe name;"
- `packages/plugin-pi/src/index.ts:624` — "// register the first occurrence only."
- `packages/plugin-pi/src/index.ts:851` — "// Circuit breaker: when config is wired (the live Pi handlers always pass"
- `packages/plugin-pi/src/index.ts:852` — "// it), skip observe fast while the daemon is known-down so a dead host"
- `packages/plugin-pi/src/index.ts:853` — "// doesn't burn the full per-turn budget on every turn (#1626). Shutdown is"
- `packages/plugin-pi/src/index.ts:854` — "// the exception — it is the last chance to observe the branch before the"
- `packages/plugin-pi/src/index.ts:855` — "// session tears down, so force the attempt even mid-cooldown; a failure"
- `packages/plugin-pi/src/index.ts:856` — "// still trips the breaker normally (codex review)."
- `packages/plugin-pi/src/index.ts:858` — "// Live turn hooks are bounded by the per-turn budget to protect the host's"
- `packages/plugin-pi/src/index.ts:859` — "// ~30s handler window (#1626). Shutdown is teardown with no such constraint,"
- `packages/plugin-pi/src/index.ts:860` — "// so the forced replay uses the general request budget — otherwise a large"
- `packages/plugin-pi/src/index.ts:861` — "// unobserved branch would time out exactly when forceAttempt tried to save it"
- `packages/plugin-pi/src/index.ts:862` — "// (cursor review)."
- `packages/plugin-pi/src/index.ts:884` — "// Shutdown is the last chance before teardown: wait for one bounded pass (it never rejects)."
- `packages/plugin-pi/src/index.ts:980` — "/** * Probe the daemon and return the verdict plus the shared-breaker action the * startup chain must apply (under it..."
- `packages/plugin-pi/src/index.ts:1004` — "// Startup just proved the daemon is unreachable, so trip the fast-skip"
- `packages/plugin-pi/src/index.ts:1005` — "// breaker — otherwise the first live hook spends the full turn budget on a"
- `packages/plugin-pi/src/index.ts:1006` — "// doomed request before the breaker would trip on its own."
- `packages/plugin-pi/src/index.ts:1139` — "// Retry-budget exhaustion means transient failures ate the whole per-turn"
- `packages/plugin-pi/src/index.ts:1140` — "// deadline inside requestWithRetry — the daemon is effectively unreachable"
- `packages/plugin-pi/src/index.ts:1141` — "// for this turn, so trip the breaker and cool down instead of burning another"
- `packages/plugin-pi/src/index.ts:1142` — "// full budget on the next hook (codex review). This error only arises from"
- `packages/plugin-pi/src/index.ts:1143` — "// transient connection failures, never from a semantic HTTP response."
- `packages/plugin-pi/src/index.ts:1145` — "// Multi-chunk observe throws its own budget-exceeded message when the shared"
- `packages/plugin-pi/src/index.ts:1146` — "// per-turn deadline is exhausted across chunks; that is also an effectively-"
- `packages/plugin-pi/src/index.ts:1147` — "// unreachable condition for the turn, so trip the breaker and fast-skip"
- `packages/plugin-pi/src/index.ts:1148` — "// subsequent turns instead of piling on more doomed chunked observes (cursor)."
- `packages/plugin-pi/src/mcp-registration.test.ts:286` — "// Both handlers await the daemon before they register, so the two retries"
- `packages/plugin-pi/src/mcp-registration.test.ts:287` — "// overlap in the listing window without any wall-clock wait."
- `packages/plugin-pi/src/mcp-registration.test.ts:306` — "// The gate holds every `tools/list` response until the test releases it, so"
- `packages/plugin-pi/src/mcp-registration.test.ts:307` — "// the startup registration and the status command are in the listing window"
- `packages/plugin-pi/src/mcp-registration.test.ts:308` — "// at the same time. No wall-clock wait is involved."
- `packages/plugin-pi/src/mcp-registration.test.ts:350` — "// The command is registered synchronously by the extension factory, so the"
- `packages/plugin-pi/src/mcp-registration.test.ts:351` — "// status handler can run while the startup listing is still pending."
- `packages/plugin-pi/src/observe-flow.ts:106` — "// One cheap attempt: never let a hanging daemon hold session start or shutdown for a full turn budget."
