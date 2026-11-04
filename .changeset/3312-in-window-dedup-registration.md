---
"@remnic/core": patch
---

Register non-fact dedup hashes (procedures, preferences, decisions) inside the fact-dedup commit window instead of after persistence, so a concurrent extraction session's in-window recheck observes the committed content instead of writing a duplicate active copy at `extractionQueueConcurrency > 1`. Fact-hash index publication also happens before the window releases, and a raced duplicate now carries temporal-bound backfill onto the surviving copy. Closes #3312 (first finding; concurrency stays default 1, startup-only).
