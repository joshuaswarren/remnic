---
"@remnic/core": patch
---

A local-LLM availability probe that TIMES OUT no longer marks the backend
unavailable. The probe budget is a fixed 2s, and a busy event loop can burn it
before the socket is scheduled — so a loaded daemon could cache itself into an
extraction blackout while the backend answered other callers in milliseconds. A
timed-out probe now leaves availability unknown and re-probes on the next
request, probe failures log their actual cause, and the transition to
unavailable is surfaced at warn instead of debug.
