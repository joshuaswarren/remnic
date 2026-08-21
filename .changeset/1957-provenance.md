---
"@remnic/core": minor
---

Add shared-context provenance stamp (issue #1957). `stampProvenance` copies the item, attaches `{actor, at}`, and rejects an empty actor or a non-ISO/NaN timestamp. Part of #1957.
