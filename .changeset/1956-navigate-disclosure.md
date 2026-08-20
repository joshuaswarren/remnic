---
"@remnic/core": patch
---

Add the disclosure ladder for recall navigation: `DISCLOSURE_LEVELS` (chunk→section→raw), `disclosureRank`, and `planDisclosureStep`, which allows only strictly deeper expansions so a caller cannot re-pay budget for output it already has. Part of #1956.
