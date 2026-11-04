---
"@remnic/core": patch
---

Stability: stable

Stop dropping live turn capture when the extraction buffer hits its session-entry cap. The cap is now configurable (`bufferMaxSessions`) and its default is raised from 200 to 1000 sessions: live captures arriving while the single extraction worker drains a backlog doc are admitted with headroom instead of being refused with `ReplayAdmissionRefusedError` (w9C measured 25-40% of live captures dropped at busy hours since October 27; 37 sessions hit). The refusal behavior itself is unchanged at the configured cap, and accepted captures are still never evicted (#3251). Fixes #3303.
