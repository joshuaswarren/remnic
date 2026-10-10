---
"@remnic/core": patch
---

Entity retrieval no longer re-reads the fact corpus after a score or lifecycle rewrite. Heat, decay, and lastValidatedAt updates leave the in-memory mention index in place. A new or edited entity file is included on the next recall, without scanning fact files. Fact creates, edits, and deletes serve the last index immediately and reconcile it in the background; once those writes quiesce, the section matches a full rebuild.

Stability: stable
