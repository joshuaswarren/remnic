---
"@remnic/core": patch
Stability: stable
---

A durable observe capture refused at the per-session turn cap now says so: the error names the session and the cap (`session <key> holds the per-session turn cap (200) of unextracted turns`) instead of reporting "extraction buffer at entry capacity". The entry-cap refusal keeps its wording and now states the session-entry cap. Both stay the same retryable `ReplayAdmissionRefusedError` (HTTP 503 `buffer_admission_refused`), so client retry behavior does not change. Operators can now tell a session whose backlog outran extraction from a buffer that is out of session slots. Closes #3632.
