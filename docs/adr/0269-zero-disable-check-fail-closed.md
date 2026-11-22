# Zero-disable config checks are interpreted with schema combinator semantics and fail closed

Status: accepted

## Context
AGENTS.md §33 ("Config Schema-Code Consistency — Schema Minimums Must Hold") requires that config fields documented as "0 disables" are actually honored in code. Schema documents can express the zero-disable contract through `allOf`/`anyOf`/`oneOf` combinators, clamping expressions, and grandfather baselines, so a simple text scan is neither sound nor complete.

## Decision
The disable-value check interprets zero-disable documentation through schema combinator semantics: under `allOf`, 0 is rejected if ANY branch rejects it; under `anyOf`, 0 is admitted when at least one branch admits it; under `oneOf`, 0 is admitted only when EXACTLY one branch admits it (two matching branches make 0 invalid). The check recognizes the `0` literal within a short window before "disabl(e|es|ed)" ("0 disables", "set to 0 to disable"). Where a value cannot be verified — e.g. a clamp whose tested value can't be named (`coerceNumber(x) <= 0`), or a missing grandfather baseline ref — the check fails closed. The pre-push checker's `origin/main` base ref also fails closed on a missing ref and treats entries already accepted on the true base as newly grandfathered rather than silently accepting them.

## Consequences
Ambiguous or unresolvable cases produce violations rather than silent passes, so legitimate uses may require explicit annotation. Combinator semantics must be maintained as the schema language evolves.

## Origin comments
- `scripts/check-pre-push.mjs:154` — "`origin/main` here fails closed on a missing ref, or treats entries"
- `scripts/check-pre-push.mjs:155` — "already accepted on the true base as newly grandfathered."
- `scripts/config-contract/disable-value-check.ts:1` — "/** * §33 disable-value check (issue #2070)..." (existence)
- `scripts/config-contract/disable-value-check.ts:83` — "A literal `0` within a short window before \"disabl(e|es|ed)\"..."
- `scripts/config-contract/disable-value-check.ts:173` — "allOf is an intersection: 0 is rejected if ANY branch rejects it."
- `scripts/config-contract/disable-value-check.ts:182` — "Parent admits 0 here (nothing rejected above). Count branches that admit 0:"
- `scripts/config-contract/disable-value-check.ts:183` — "anyOf admits 0 when >= 1 branch does; oneOf requires EXACTLY one (two"
- `scripts/config-contract/disable-value-check.ts:184` — "matching branches make 0 invalid under oneOf)."
- `scripts/config-contract/disable-value-check.ts:764` — "Require a VERIFIED same-value tie: the zero branch yields 0 and the"
- `scripts/config-contract/disable-value-check.ts:765` — "CLAMP NODE ITSELF operates on the exact value the condition tested"
- `scripts/config-contract/disable-value-check.ts:766` — "(not merely somewhere in the branch — ... clamps rawCap, not legacy, and must still be flagged). If the tested"
- `scripts/config-contract/disable-value-check.ts:767` — "value can't be named (e.g. `coerceNumber(x) <= 0`), fail closed."
- `scripts/config-contract/disable-value-check.ts:1039` — "Resolve the grandfather baseline for the shrink-only ban, mirroring the v2 contract checker. `baselineRequired`..."
- `scripts/config-contract/disable-value-check.ts:768` — "// clamps rawCap, not legacy, and must still be flagged). If the tested value can't be named (e.g. `coerceNumber(x) <= 0`), fail closed."
