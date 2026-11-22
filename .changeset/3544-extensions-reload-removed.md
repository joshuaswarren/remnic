---
"@remnic/cli": patch
Stability: stable
---

`remnic extensions reload` is removed. It never did anything (extension caching was never implemented) while it printed "Extension cache reloaded". `remnic extensions` now lists only `list`, `show` and `validate`. Refs #3544.
