---
"@remnic/core": patch
---

A fact-hash index publish that fails or stays deferred behind a held lock now changes the index file's timestamp. A second process on the same memory directory (the CLI next to the daemon) used to keep trusting its snapshot and answer an authoritative MISS for a fact the first process had just written, so it could write a second copy. The next lookup in that process now revalidates against the corpus.

Stability: stable
