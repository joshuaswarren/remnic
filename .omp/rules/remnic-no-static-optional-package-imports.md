---
name: remnic-no-static-optional-package-imports
description: "Base packages must not statically value-import optional companion packages (bench, export/import-*, connector-*, coding-graph)"
condition:
  - 'import\s+(?!type\b)[^;]{0,300}?from\s*["'']@remnic/(bench|export-weclone|import-[a-z-]+|connector-[a-z-]+|coding-graph)["'']'
  - '(await\s+import|require)\(\s*["'']@remnic/(bench|export-weclone|import-[a-z-]+|connector-[a-z-]+|coding-graph)["'']'
globs:
  - "**/packages/remnic-cli/**"
  - "**/packages/remnic-core/**"
  - "**/packages/remnic-server/**"
  - "**/packages/plugin-*/**"
  - "**/packages/shim-*/**"
---

You are adding a runtime import of an optional companion package
(`@remnic/bench`, `@remnic/export-weclone`, `@remnic/import-*`,
`@remnic/connector-*`, `@remnic/coding-graph`) into a base package.
These are optional peer dependencies — a static or literal-specifier
dynamic import lets the bundler resolve them and pulls them into every
base install, breaking the à-la-carte packaging contract (AGENTS.md
pattern 44). A past regression bundled bench and export-weclone into
every CLI install this way.

Load optional packages through the existing computed-specifier loader
helpers instead:

- `packages/remnic-cli/src/optional-bench.ts`
- `packages/remnic-cli/src/optional-weclone-export.ts`
- `packages/remnic-core/src/cli.ts` → `ensureBuiltInBulkImportAdapters`

Pattern: `await import("@remnic/" + "bench")` wrapped in a loader that
throws a user-facing install hint on `MODULE_NOT_FOUND`.

Type-only imports (`import type { X } from "@remnic/bench"` or
`typeof import("@remnic/bench")`) are erased at compile time and are
fine — this rule intentionally does not match them.
