# Contributing to Remnic

## Monorepo Workflow

### Prerequisites

- Node.js >= 22.12.0
- pnpm >= 9.0
- Python 3.11+ (for `plugin-hermes` only)

### Setup

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install
pnpm run build
pnpm test
```

### Running a Single Package

```bash
# Build one package
pnpm run build --filter=@remnic/core

# Test one package
pnpm test --filter=@remnic/server

# Type-check one package
pnpm run check-types --filter=@remnic/cli
```

### Running Everything

```bash
pnpm run build          # builds all packages in dependency order
pnpm test               # tests all packages
pnpm run check-types    # type-checks all packages
```

## Adding a New Package

1. Create the directory: `packages/my-package/`
2. Add `package.json` with `name`, `version`, `type: "module"`, `main`, `types`, `exports`
3. Add `tsconfig.json` extending `../../tsconfig.base.json`
4. Add `tsup.config.ts` if the package needs building
5. The workspace is auto-discovered via `pnpm-workspace.yaml` glob

### Package Naming

| Published name | Directory |
|---------------|-----------|
| `@remnic/core` | `packages/remnic-core/` |
| `@remnic/server` | `packages/remnic-server/` |
| `@remnic/plugin-openclaw` | `packages/plugin-openclaw/` |
| `remnic-hermes` (PyPI) | `packages/plugin-hermes/` |

### Dependencies Between Packages

Use workspace protocol in `package.json`:

```json
{
  "dependencies": {
    "@remnic/core": "workspace:*"
  }
}
```

Turborepo ensures correct build order via `turbo.json` task dependencies.

> **Important:** This repo requires [pnpm](https://pnpm.io/) (`npm install -g pnpm`). `npm ci` / `npm install` cannot resolve `workspace:` specifiers. At publish time, `pnpm publish` rewrites `workspace:^` to real version numbers automatically.

## Code Standards

- **TypeScript strict mode** — all packages
- **ESM only** — `"type": "module"` in every package.json
- **Node.js native test runner** — `import test from "node:test"` + `import assert from "node:assert/strict"`
- **No external mocking frameworks** — use temp directories and direct assertions
- **Max line length:** 120 characters
- **One concern per file** — prefer small, focused modules

## Testing

### Test File Location

Tests live inside each package: `packages/<name>/tests/*.test.ts`

Cross-package integration tests live in root: `tests/integration/*.test.ts`

### Test Patterns

```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("description of behavior", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-test-"));
  try {
    // test logic using temp directory
    assert.equal(actual, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

### Running Tests

```bash
pnpm test                              # all tests
pnpm test --filter=@remnic/core        # one package
npx tsx --test tests/specific.test.ts  # one file
```

## Pull Request Process

1. Create a feature branch from `main`
2. Keep the PR narrow. Split mixed work before review whenever possible.
3. Sync with latest `main` before requesting AI review.
4. Write documentation first (if adding new features)
5. Write tests second
6. Write implementation third
7. Run `pnpm run preflight:quick`
8. If you touched `orchestrator.ts`, `storage.ts`, `intent.ts`, `memory-cache.ts`,
   `entity-retrieval.ts`, `config.ts`, or any file under `storage/` or `orchestration/`
   in `src/` or `packages/remnic-core/src/`, run `pnpm run test:entity-hardening`
9. Run `pnpm run build && pnpm test` — everything must pass
10. Update `CHANGELOG.md` under `[Unreleased]`
11. Create PR with description following the template

### PR Checklist

- [ ] All tests pass
- [ ] Type-check passes (`pnpm run check-types`)
- [ ] CHANGELOG updated
- [ ] Documentation updated (if behavior changed)
- [ ] No secrets or credentials committed
- [ ] PR diff <= 400 LOC (or justified)
- [ ] Review fixes will be batched by subsystem, not pushed as micro-fixes

## Release Process

See [release-process.md](./release-process.md) for multi-package versioning and publishing.

## Project Structure

See [monorepo-structure.md](../architecture/monorepo-structure.md) for the complete package map and dependency graph.
