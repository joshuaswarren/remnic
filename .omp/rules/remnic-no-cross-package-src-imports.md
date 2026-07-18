---
name: remnic-no-cross-package-src-imports
description: "Never import another workspace package via a relative ../<pkg>/src/ path; use the @remnic/* package name"
condition:
  - '(from\s+|import\s*\(\s*|require\(\s*|import\s+)["''](\.\./)+(belief-ledger|bench|bench-ui|coding-graph|connector-[a-z-]+|export-weclone|hermes-provider|import-[a-z-]+|plugin-[a-z-]+|remnic-cli|remnic-core|remnic-server|shim-openclaw-engram)/src/'
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
  - "**/*.js"
  - "**/*.mjs"
---

You are importing another workspace package through a relative
`../<package>/src/...` path. This bypasses the package's public export
surface: a directory rename or build-output change in the target package
silently breaks the import, and the module graph escapes the package
boundary contract (AGENTS.md pattern 15). The repo's structural gates
were extended twice (PRs #1665, #1681) because static, dynamic
(`await import(...)`), and side-effect import forms all kept sneaking in.

Import via the package name instead: `import { X } from "@remnic/core"`.
If the symbol is not exported, export it from the target package's
public surface rather than deep-linking into its `src/`.

(Non-import uses, e.g. `path.resolve(dir, "../../remnic-server/src/...")`
for dev-mode process spawning, are not affected by this rule.)
