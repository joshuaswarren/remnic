---
name: remnic-no-static-optional-package-imports
description: "Base packages must not statically value-import optional companion packages (bench, export/import-*, connector-*, coding-graph)"
condition:
  - 'import\s+(?!type\b)(?!\{)[A-Za-z_$*][^;]{0,300}?from\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - 'import\s+(?!type\b)[^;{]{0,120}?\{([^}]*,)?\s*(?!type\s)[A-Za-z_$][\w$]*\s*(as\s+[\w$]+\s*)?[,}][^;]{0,200}?from\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - '(?<!typeof )(?<!: )(?<!<)(?<!as )(?<!\btype\s[A-Za-z_$][\w$<>, ]{0,80}=\s*)import\s*\(\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - '(?m)^\s*import\s+["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - 'require\(\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - 'export\s+(?!type\b)\*[^;]{0,50}?from\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
  - 'export\s+(?!type\b)[^;{]{0,120}?\{([^}]*,)?\s*(?!type\s)[A-Za-z_$][\w$]*\s*(as\s+[\w$]+\s*)?[,}][^;]{0,200}?from\s*["'']@remnic/(bench|export-weclone|import-[a-z0-9-]+|connector-[a-z0-9-]+|coding-graph|replit)(/[^"'']*)?["'']'
globs:
  - "**/packages/remnic-cli/**"
  - "**/packages/remnic-core/**"
  - "**/packages/remnic-server/**"
  - "**/packages/plugin-*/**"
  - "**/packages/shim-*/**"
  - "src/**"
  - "**/remnic*/src/**"
---

You are adding a runtime import of an optional companion package
(`@remnic/bench`, `@remnic/export-weclone`, `@remnic/import-*`,
`@remnic/connector-*`, `@remnic/replit`, `@remnic/coding-graph` —
including any `/subpath`) into an install surface
(a base package, or the repo-root `src/` compatibility wiring that is
built and published as the OpenClaw extension).
These are optional peer dependencies — a static import, a side-effect
import, a runtime re-export (`export * from ...`, `export { x } from
...`), or a literal-specifier dynamic import (awaited or not: `void
import(...)`, `import(...).then(...)`) lets the bundler resolve them
and pulls them into every
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

Type-only imports are erased at compile time and are fine — this rule
intentionally does not match `import type { X } from "@remnic/bench"`,
all-type inline specifiers (`import { type A, type B } from ...`), or
`typeof import("@remnic/bench")` type positions. A mixed list like
`import { type A, B } from ...` still imports `B` at runtime and is
correctly caught.

Recorded non-goal: token-obfuscated forms such as a block comment
between `import` and its clause (`import /* x */ { load } from ...`)
are not matched. TTSRs are guardrails against realistic accidental
code, not an adversarial sandbox — generated code does not interleave
comments inside import statements, and supporting arbitrary comment
positions would make every condition unreadable. The packaging
contract itself is still enforced downstream by tsup externals and the
packaging tests; this rule is the early-warning layer.
