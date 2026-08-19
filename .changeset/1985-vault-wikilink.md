---
"@remnic/core": minor
---

Add `formatVaultWikilink` to wrap a relative vault path as `[[path]]`. The helper strips `.md` and rejects absolute, empty, newline, and `..` paths. Part of #1985.
