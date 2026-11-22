---
"@remnic/coding-graph": patch
Stability: stable
---

Test-only: the `diffHunks` staged-changes test sets `core.hooksPath=/dev/null` in its throwaway git repo, so a developer's global pre-commit hook no longer fails it. No runtime change. Refs #3627.
