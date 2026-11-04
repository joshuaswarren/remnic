---
"@remnic/core": patch
---

Archive observed turns durably before the observe call is acknowledged. The LCM observe queue now holds session references instead of copied message payloads: content is appended to SQLite first, unsummarized archive reads are bounded with a SQL limit, one summary pass is capped at a fixed number of leaf batches, and a restart resumes outstanding summaries. An archive failure now rejects instead of being logged and swallowed, and the observe surface fails closed so a lost archive is never acknowledged as an accepted turn. Summary building stays in the background.
