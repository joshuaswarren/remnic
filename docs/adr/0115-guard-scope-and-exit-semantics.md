# Guards against the disable value are recognized only within the use's own function and only when they exit

Status: accepted

## Context
Config values may legitimately reach 0 ("0 disables") when code guards against it first. Deciding whether a guard actually protects a use is easy to get wrong: guards in enclosing functions do not protect nested calls, and an `||` guard in an action context triggers the action instead of protecting the use.

## Decision
A guard protects a use of a config value only when it appears within the use's own function scope: an enclosing `if`/guard in an outer function cannot protect a threshold inside a nested function, whose parameter can still be the disable value. A boolean `||` with a disabling left operand counts as a guard only when the whole `||` is an if-condition whose then-branch always exits (`if (cfg.x <= 0 || used > cfg.x) return`). In an action context (`if (cfg.x <= 0 || used > cfg.x) flush()`) the disable value triggers the action, so it is not a guard and the use is flagged.

## Consequences
Cross-function guard patterns are flagged and must be restructured or annotated; guard-style conditions used for side effects cannot mask unguarded uses.

## Origin comments
- `scripts/config-contract/disable-value-check.ts:584` — "A guard in an outer function does not protect a use in a nested"
- `scripts/config-contract/disable-value-check.ts:585` — "function: the inner function's parameter can still be 0."
- `scripts/config-contract/disable-value-check.ts:592` — "True when a boolean `||`/`&&`/paren expression is (part of) an if-condition whose then-branch always exits..."
- `scripts/config-contract/disable-value-check.ts:622` — "Stop at the use's own function boundary: an enclosing `if`/guard in an"
- `scripts/config-contract/disable-value-check.ts:623` — "outer function cannot protect a threshold inside a nested function, whose"
- `scripts/config-contract/disable-value-check.ts:624` — "parameter can still be the disable value."
- `scripts/config-contract/disable-value-check.ts:634` — "`cfg.x <= 0 || use` — a disabling left operand short-circuits, but only"
- `scripts/config-contract/disable-value-check.ts:635` — "PROTECTS when the whole `||` is an if-condition whose branch EXITS"
- `scripts/config-contract/disable-value-check.ts:636` — "(`if (cfg.x <= 0 || used > cfg.x) return`). In an action context"
- `scripts/config-contract/disable-value-check.ts:637` — "(`if (cfg.x <= 0 || used > cfg.x) flush()`) the disable value TRIGGERS"
- `scripts/config-contract/disable-value-check.ts:638` — "the action, so it is not a guard."
