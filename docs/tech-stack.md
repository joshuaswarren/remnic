# Tech stack

What Remnic is built on. Versions below are the ranges declared in the workspace manifests; the memory engine and its dependencies live in `packages/remnic-core/`.

## Runtime and tooling

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Node.js ≥ 22.12.0 | ESM only (`"type": "module"`) |
| Package manager | pnpm 10.32.1 | Declared via `packageManager`; workspace globs `packages/*` |
| Monorepo | Turborepo 2.9.x | Task graph + caching via `turbo.json` |
| Language | TypeScript 5.9 | Strict mode; `tsc --noEmit` for type checks |
| Build | [tsup](https://tsup.egoist.dev/) 8.x | Bundles packages to `dist/` |
| Lint / format | [Biome](https://biomejs.dev/) 1.9.4 | `biome.json` |

## Core dependencies

| Package | Purpose |
|---------|---------|
| `openai ^6` | LLM extraction/consolidation via the OpenAI Responses API |
| `zod ^3` | Runtime schema validation for structured LLM outputs |
| `@sinclair/typebox ^0.34` | JSON Schema generation for the plugin config contract |
| `better-sqlite3 ^12` | Embedded SQLite for artifact cache and indexes |
| `@lancedb/lancedb ^0.26` | LanceDB embedded vector search backend |
| `@orama/orama ^3` | Orama embedded (pure-JS) search backend |
| `meilisearch ^0.46` | Meilisearch search backend client |
| `@node-rs/argon2 ^2` | Argon2 hashing for the secure store |
| `@honcho-ai/sdk ^2` | Optional Honcho-AI integration for shared context |

## Dev dependencies

| Package | Purpose |
|---------|---------|
| `tsx ^4` | Run TypeScript files directly (tests, scripts) |
| `tsup ^8` | Build and bundle TypeScript |
| `typescript ^5.9` | Type checking (`tsc --noEmit`) |
| `@biomejs/biome 1.9.4` | Linting and formatting |
| `turbo 2.9.x` | Monorepo task runner |

## External tools (not npm packages)

| Tool | Purpose | Required? |
|------|---------|-----------|
| [QMD](https://github.com/tobi/qmd) | Hybrid BM25 + vector search (default backend); supported version 2.5.3 | Recommended; recall falls back gracefully when unavailable |
| OpenAI API | LLM extraction and consolidation | Required for extraction (unless using a local-LLM configuration) |

## Test infrastructure

Tests use Node.js's built-in test runner (`node:test`) executed via `tsx --test` — no additional test framework. Import `node:test` and `node:assert` directly. The root suite runs through `scripts/run-root-tests.mjs`; each package also carries its own tests.

## CI

GitHub Actions (`.github/workflows/`) runs the type checks, the test suite, the build, and the config/docs parity gates (`check-config-contract`, `check-docs-parity`) on every push and pull request.
