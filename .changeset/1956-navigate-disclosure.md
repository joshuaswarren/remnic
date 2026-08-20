---
"@remnic/core": patch
---

Add `disclosureRank` and `planDisclosureStep` for recall navigation, which allow only strictly deeper expansions (chunk -> section -> raw) so a caller cannot re-pay budget for output it already holds. Both read the canonical `RECALL_DISCLOSURE_LEVELS` from `types.ts` rather than defining a second ladder. Internal helpers only — the expand and traverse surfaces land in a later slice. Part of #1956.
