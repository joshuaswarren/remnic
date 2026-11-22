# Alias and helper resolution prefers the calling module and binds key literals to parameters

Status: accepted

## Context
Config readers delegate through local helpers and parameterized functions. Same-named helpers exist in multiple modules (e.g. `parseBoundedInt` in both meetings/config.ts and recall-navigation-config.ts), and key names passed as string literals would otherwise collapse distinct reads into one.

## Decision
Parameterized local function expressions are registered before their bodies are visited, and their bodies are revisited at each distinct literal call site. Key-name string-literal arguments bind to the helper's parameters so `cfg[keyParam]` resolves; the literal signature also keys the dedup so distinct-literal calls to the same reader (`readFlatOrNestedConfig(cfg, "a", …)` vs `(cfg, "b", …)`) are all followed instead of collapsing to one. When resolving a helper, prefer the calling file's module-local definition so a same-named helper in another module cannot win and mint phantom doubled key paths (issue #1956 CI). Only functions whose parameter at the argument position exists participate in helper recursion. Entry-parser input re-bindings (`cfg`, `baseCfg`) are an explicit, documented allowlist — if these drift, they must be updated. Files exporting a `parse*Config` function participate; so do `*config.ts` module files exporting any parse* helper (e.g. `parseScopeProfiles`), otherwise parseConfig's delegated calls go unresolved (issue #1990 review), and scoping the broader match to `*config.ts` keeps the program within the CI <60s budget. In Zod schemas, walkSchemaObject handles every nested `z.object` at its correct depth — do not descend again, or nested keys would re-record at the outer prefix (review finding).

## Consequences
Resolution is precise but coupled to the explicit entry-alias list and file-scope conventions; a CI time budget constrains how far the file match may widen.

## Origin comments
- `scripts/config-contract/extract-parsed-keys.ts:516` — "Register parameterized local function expressions before their bodies are"
- `scripts/config-contract/extract-parsed-keys.ts:517` — "visited. Their bodies are revisited at each distinct literal call site."
- `scripts/config-contract/extract-parsed-keys.ts:715` — "Key-name arguments passed as string literals bind to the helper's"
- `scripts/config-contract/extract-parsed-keys.ts:716` — "params so `cfg[keyParam]` resolves (issue #1990 review). The literal"
- `scripts/config-contract/extract-parsed-keys.ts:717` — "signature also keys the dedup so distinct-literal calls to the same"
- `scripts/config-contract/extract-parsed-keys.ts:718` — "reader (readFlatOrNestedConfig(cfg, \"a\", …) vs (cfg, \"b\", …)) are all"
- `scripts/config-contract/extract-parsed-keys.ts:719` — "followed instead of collapsing to one."
- `scripts/config-contract/extract-parsed-keys.ts:737` — "Prefer the calling file when resolving the helper: a same-named"
- `scripts/config-contract/extract-parsed-keys.ts:738` — "module-local helper in another module (parseBoundedInt exists in"
- `scripts/config-contract/extract-parsed-keys.ts:739` — "both meetings/config.ts and recall-navigation-config.ts) must not"
- `scripts/config-contract/extract-parsed-keys.ts:740` — "win and mint phantom doubled key paths (issue #1956 CI)."
- `scripts/config-contract/extract-parsed-keys.ts:885` — "Locate a callable for helper recursion. Only functions whose parameter at the argument position exists participate..."
- `scripts/config-contract/extract-parsed-keys.ts:940` — "Local names the entry parser re-binds its input to (`cfg`, `baseCfg`). Explicit and documented: if these drift,..."
- `scripts/config-contract/extract-parsed-keys.ts:875` — "walkSchemaObject handled every NESTED z.object at its correct"
- `scripts/config-contract/extract-parsed-keys.ts:876` — "depth — do not descend, or nested keys would re-record at the"
- `scripts/config-contract/extract-parsed-keys.ts:877` — "outer prefix (review finding)."
- `scripts/config-contract/extract-parsed-keys.ts:1230` — "Files that export a parse*Config function participate; so do *config.ts"
- `scripts/config-contract/extract-parsed-keys.ts:1231` — "module files that export any parse* helper (e.g. scope-profile-config.ts"
- `scripts/config-contract/extract-parsed-keys.ts:1232` — "exports parseScopeProfiles/parseScopeTeams, not parse*Config) — otherwise"
- `scripts/config-contract/extract-parsed-keys.ts:1233` — "parseConfig's delegated calls to them go unresolved (issue #1990 review)."
- `scripts/config-contract/extract-parsed-keys.ts:1234` — "Scoping the broader match to *config.ts keeps the program within the CI"
- `scripts/config-contract/extract-parsed-keys.ts:1235` — "<60s budget."
