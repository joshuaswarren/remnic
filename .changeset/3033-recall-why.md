---
"@remnic/core": patch
"@remnic/cli": patch
---

feat: add `remnic why` — recall-miss diagnosis (#3033)

New read-only diagnostic surface that replays the recall pipeline and reports which stage dropped an expected memory, or confirms the backend was unavailable. Mirrors the existing xray surface pattern.