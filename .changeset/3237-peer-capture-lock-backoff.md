---
"@remnic/core": patch
---

Stability: stable

Apply configured converge capture-lock backoff to both peer apply entrypoints. Scope the override to the operation and target storage instance, retaining ordinary capture bounds and existing cancellation options without mutating shared namespace storage. Fixes #3237.
