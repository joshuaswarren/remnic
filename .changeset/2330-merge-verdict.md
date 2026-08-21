---
"@remnic/core": patch
---

Add `parseMergeJudgeVerdict`: a strict, throw-free parser for free-form merge-judge verdicts that distinguishes unparseable answers from deliberate "create" verdicts while failing closed — every non-"merge" outcome carries `decision: "create"`. Part of #2330
