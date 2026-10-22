---
"@remnic/core": patch
---

Persist harmonic source path lookups and confirmed misses across restarts, invalidating them when the projection or corpus changes and retaining the existing ten-minute expiry. Resolve imported source files by frontmatter ID even when filenames differ. Format QMD results before awaiting harmonic enrichment, preserving the existing recall scopes and deadlines.

Stability: stable
