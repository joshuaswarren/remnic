# A half-open circuit-breaker probe is owned single-flight and settleable only by its owner

Status: accepted

## Context
Under concurrency, several callers could pile onto the half-open state: a queued probe plus a double timeout held every drain for up to 55 minutes, unowned failures could reopen or re-arm a breaker mid-probe, and forced extraction attempts could masquerade as probe results.

## Decision
The half-open probe is OWNED, not merely timed: exactly one probe owner exists at a time (single-flight); only the owner's failure settles the probe (forced extraction must not masquerade); an unowned auth_config failure must not reopen over a held probe (its cooldown applies once settled); a failed probe re-opens immediately so an auth-opened breaker cannot stick half_open; an unowned failure must not cross the open threshold while a probe is held (that would mint a second probe). A bounded probe timeout prevents indefinite drain holds. Observability metrics are emitted once per state change, not per attempt.

## Consequences
Drain is never held hostage by stacked probes or unowned failures. The cost is owner-tracking bookkeeping in the breaker state machine.

## Origin comments

- `packages/remnic-core/src/orchestration/provider-breaker.ts:10` — "HALF_OPEN_PROBE_TIMEOUT_MS: probe bound — a queued probe + double timeout held every drain up to 55 min"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:46` — "Probe is OWNED, not timed: single-flight half-open probe ownership under concurrency > 1 (codex P2 on #3311)"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:95` — "Only the probe OWNER's failure settles the half-open probe; forced extraction must not masquerade"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:105` — "Unowned auth_config failure must not reopen over a held half-open probe; auth cooldown applies once settled"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:109` — "Failed half-open probe re-opens immediately; otherwise auth_config-opened breaker would stick half_open"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:114` — "PRRT_kwDORJXyws6zxG6V: unowned failure must not cross threshold while probe held — would mint a second probe"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:135` — "PRRT_kwDORJXyws6zxG6u: while a half-open probe is held, only its OWNER may settle it"
- `packages/remnic-core/src/orchestration/provider-breaker.ts:160` — "Once per state change (not per attempt) — AGENTS.md observability rule."
