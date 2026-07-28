# Theory: reliable MCP structured outputs

## Problem

Strict MCP clients reject catalog entries whose advertised output schemas do not match tool responses. Successful MCP output must be object-rooted, named collection results must be required, no-data day summaries must remain `{}`, and generation failures must remain errors.

## Operating theory

Core services retain their domain return contracts. The MCP boundary wraps wearable and transcript arrays in named object properties, marks those properties required, validates calendar-date input before dispatch, and serializes successful nullish results as `{}`. Day-summary generation throws when a configured model path fails without a fallback, so that transport success cannot hide an outage.

## Strategy

Limit the repair to MCP output-schema registration, operation-boundary presentation and validation, day-summary error propagation, and contract tests. Do not alter memory behavior, storage, service return types, HTTP wrappers, or host adapters.

## Verification

`pnpm exec tsx --test tests/access-mcp.test.ts` passed 25/25. `pnpm --filter @remnic/core check-types` passed. PR #2219 is the repository-owned successor to contributor PR #2181; CI and current-head review gates remain before merge.
