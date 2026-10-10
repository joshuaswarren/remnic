---
"@remnic/core": patch
---

Entity retrieval no longer re-reads the fact corpus after a score or lifecycle rewrite. Heat, decay, and lastValidatedAt updates leave the in-memory mention index in place. A new or edited entity file is included on the next recall, without scanning fact files. Fact creates, edits, and deletes serve the last index immediately and reconcile it in the background; once those writes quiesce, the section matches a full rebuild. A body replacement passed through a frontmatter write moves that epoch too. An access flush that rewrites `entityRef` does as well; access counts alone do not. Reconciliation runs once more if the scan overlaps a later write, then waits for the next recall. Review, governance restore, capsule import and merge, and the other out-of-band fact writers move the same epoch when they change indexed text.

Stability: stable
