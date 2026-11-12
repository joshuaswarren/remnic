---
"@remnic/core": patch
---

Stability: stable

The daemon now builds the default namespace's fact-hash index in the background at start. The first explicit save after a restart no longer pays the whole-corpus rebuild, and a save that arrives mid-build joins the same in-flight build.
