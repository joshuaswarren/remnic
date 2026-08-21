---
"@remnic/core": patch
---

Add `lintCuratedClaims` to shared-context: report curated claims whose citations are missing, blank, or absent from the item ids the curation run had available (issue #1957 requirement 4). Internal helper — wiring into `curate_daily` output is a later slice. Part of #1957
