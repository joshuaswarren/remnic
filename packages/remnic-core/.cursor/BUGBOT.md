# Core Package Review Context

This package (`@remnic/core`) is the engine: orchestrator, storage, extraction, retrieval, config, and all shared types.

## Key Files & Their Invariants

### `src/orchestrator.ts` (13.7K lines)
- Coordinates the three-phase lifecycle (recall → buffer → extract).
- All runtime globals MUST be scoped by `serviceId` when multiple instances coexist.
- Clean up ALL test globals in teardown, including unkeyed ones like `__openclawEngramOrchestrator`.

### `src/storage.ts` (5.6K lines)
- All memory files use markdown + YAML frontmatter.
- IDs follow `{category}-{timestamp}-{4-char-random}`.
- Status field: `active`, `superseded`, `expired`, `archived`.
- **Never delete before write** — write to temp, then atomic rename.
- Hash operations: if writes hash `rawContent`, reads must hash `rawContent` too.

### `src/extraction.ts` (2.6K lines)
- **Must use OpenAI Responses API** — never `chat.completions.create`.
- Uses `zodTextFormat()` for structured output.
- Extraction judge gate evaluates fact durability before writes.
- **Don't index content that failed to persist** — rejected content must not go into `contentHashIndex`.

### `src/config.ts` (2.4K lines)
- Single source of truth for config parsing and defaults.
- Config resolution must be deduplicated — import from shared utility, never reimplement slot resolution.
- Legacy env var fallback: try `REMNIC_*` first, then `ENGRAM_*`.
- Coerce boolean-like strings (`"false"`, `"0"`, `"no"`, `"off"`) at config-read boundaries.

### `src/types.ts` (2K lines)
- Single source of truth for shared interfaces.
- When adding types here, verify all consumers in `packages/*/` are updated.

### `src/qmd.ts` (1.9K lines)
- **QMD `query` command is intentional** — DO NOT change to `search` or `vsearch`. The `query` command provides LLM expansion + reranking.

### `src/cli.ts` (6.7K lines)
- CLI flag arguments must exist — `--format`, `--focus`, `--since` without a value must throw an error.
- Coerce CLI values to expected types at input boundaries (`Number()`, boolean coercion).

## Common Review Patterns

- New config properties → must appear in BOTH `config.ts` interface AND `openclaw.plugin.json:configSchema`.
- New status values → grep ALL status filters across the codebase.
- New cache layers → update ALL invalidation functions.
- New feature gates → must be checked in EVERY code path, not just the main one.
- Sort comparators → must return 0 for equal items, use stable secondary key.
- `for...of` loops → if you need the key too, use `.entries()`, not `.values()` with outer-scope variable.
- Line parsers → track position during iteration, don't use `indexOf` (returns first match, not current).
