---
"@remnic/core": minor
---

Add shared-context contradiction detection (issue #1957). `detectContradictionPair` reports `same` for identical ids, `conflict` with the overlapping claim keys whose values differ (sorted), and `none` otherwise. Pure helper; never deletes or persists. Part of #1957.
