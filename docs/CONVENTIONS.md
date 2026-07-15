# Development Conventions

Conventions and patterns used throughout the Remnic codebase. The repo is a pnpm + Turborepo workspace; the memory engine lives in `packages/remnic-core/`.

## TypeScript

- **Strict mode** — `tsconfig.json` has `"strict": true`. All code must pass `tsc --noEmit` without errors.
- **ESM only** — the package is `"type": "module"`. Use `import`/`export`; no `require()`.
- **Explicit return types** — all exported functions must have explicit return type annotations.
- **No `any`** — use `unknown` and narrow, or define a proper interface.
- **Optional fields** — when building Zod schemas for the OpenAI Responses API, use `.optional().nullable()`, not just `.optional()`.

## OpenAI Usage

- **Always use the Responses API** — never Chat Completions. See `packages/remnic-core/src/extraction.ts` for the pattern.
- **Structured outputs** — use `zodTextFormat()` to get typed responses.
- **Model references** — never hard-code model names; use `packages/remnic-core/src/model-registry.ts`.
- **Token logging** — log total tokens and latency; never log user prompt content.

## File Organization

- One logical unit per file where practical.
- `packages/remnic-core/src/types.ts` is the single source of truth for shared interfaces (`PluginConfig`).
- `packages/remnic-core/src/config.ts` owns all config parsing and defaults.
- New subsystems must register their config properties in `openclaw.plugin.json:configSchema`.

## Memory Storage

- All memory files use markdown + YAML frontmatter.
- IDs follow the format `{category}-{timestamp}-{4-char-random}`.
- Status field must be one of: `active`, `superseded`, `expired`, `archived`.
- Paths that contain user data (`facts/`, `entities/`, `profile.md`, etc.) must never be committed to git.

## Testing

- Tests live in `tests/` and use Node.js's built-in `node:test` runner.
- Run with `npm test`, which builds `@remnic/core` and then runs the root `node:test` suite via `scripts/run-root-tests.mjs`. Individual packages carry their own tests too.
- All tests must be deterministic — no network calls, no filesystem writes to real paths.
- Use `tests/transfer-fixtures.ts` patterns for shared test data.
- New subsystems require tests for: happy path, zero/empty input, and boundary conditions.

## Commit Style

- Follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Reference relevant invariant numbers from `AGENTS.md` when fixing guardrail violations.
- Never commit personal data, API keys, or memory content (see `CLAUDE.md`).

## Adding a New Config Property

1. Add the property to `PluginConfig` in `packages/remnic-core/src/types.ts`, with its default in `packages/remnic-core/src/config.ts`.
2. Add to `openclaw.plugin.json:configSchema` with type and description.
3. Run `npm run check-config-contract` to verify alignment.
4. Document in `docs/config-reference.md`.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Build `@remnic/core`, sync the OpenClaw plugin manifest, then bundle the root plugin with `tsup` |
| `npm run check-types` | Type-check with `tsc --noEmit` (plus each package's own `check-types`) |
| `npm run lint` | Lint with Biome (`biome check`) |
| `npm test` | Build core, then run the root test suite |
| `npm run preflight` | Full pre-PR gate (`scripts/pr-preflight.sh full`) |
| `npm run preflight:quick` | Fast pre-PR gate (`scripts/pr-preflight.sh quick`) |
| `npm run check-config-contract` | Verify config types match the plugin manifest schema |
