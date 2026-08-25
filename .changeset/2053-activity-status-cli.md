---
"@remnic/cli": patch
---

Add `remnic activity-status`: prints the content-free activity health
snapshot (gate state, retention policy, source revision, last analysis
status, observation/card counts) as one JSON line. Defaults match the
charter: master off, 30-day retention, never analyzed. Part of #2053.
