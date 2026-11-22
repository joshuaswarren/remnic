---
"@remnic/connector-x": patch
Stability: stable
---

The X connector's dedupe cap (20,000 posts) now prunes the least recently seen entries instead of the first seen (#3541). A bookmark that every sync still returns keeps its dedupe entry, so it is no longer re-ingested as a new memory once the cap is reached.
