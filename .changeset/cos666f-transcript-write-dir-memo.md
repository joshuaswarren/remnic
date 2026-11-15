---
"@remnic/core": patch
---

A session's transcript appends no longer re-read and re-hash every daily file of the session's directory on every message. The directory ownership check now runs on a session's first append in a process (and again after an append error); later appends reuse the remembered directory. On a 225 MB session directory the check took 0.36 s warm, so a 3-message observe paid about 1 s of it (COS-666f).

Stability: stable
