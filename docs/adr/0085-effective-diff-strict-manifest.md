# The effective-diff gate parses its ignore manifest strictly and fails loud

Status: accepted

## Context
The AI review gate wasted effort outside the effective change scope (issue #1991, umbrella #1988), and a silently mis-parsed ignore manifest would quietly widen or shrink review scope.

## Decision
Effective-diff computation for AI-review scope fences parses the ignore manifest text into a list of pattern strings and throws on unsupported syntax, so a bad manifest fails loudly rather than producing a wrong review scope.

## Consequences
New manifest syntax requires updating the parser before use; a bad manifest blocks the gate instead of degrading silently.

## Origin comments
- `scripts/effective-diff.mjs:1` — "Effective-diff computation for AI-review scope fences (issue #1991, umbrella #1988)..."
- `scripts/effective-diff.mjs:27` — "Parse the ignore manifest text into a list of pattern strings. Throws on unsupported syntax so a bad manifest fa..."
