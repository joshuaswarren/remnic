# Output budget is clamped so input always keeps positive headroom against the model context window

Status: accepted

If the requested output budget exceeds the model/server context window, the
derived input budget goes negative and prompt generation produces huge,
invalid prompts.

## Decision

The model registry guards context budgeting: the output budget is never
allowed to exceed the model/server context window, and output is clamped so
input always retains positive headroom.

## Consequences

Very large requested output budgets are silently reduced rather than erroring;
callers asking for more output than the window allows get a clamped budget.

## Origin comments
- `packages/remnic-core/src/model-registry.ts:288` — "// Guardrails: never allow output budget to exceed the model/server context window."
- `packages/remnic-core/src/model-registry.ts:289` — "// If we do, input budget goes negative and we end up generating huge, invalid prompts."
- `packages/remnic-core/src/model-registry.ts:305` — "// Clamp output so we always have positive input headroom."
