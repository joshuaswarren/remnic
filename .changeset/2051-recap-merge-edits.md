---
"@remnic/core": patch
---

Add a pure `mergeRecapUserEdits` helper (plus `RecapSection` / `MergeRecapEditsResult` types) in the activity timeline layer that merges user hand-edited recap sections with a regenerated recap: edited bodies win over regenerated bodies, edited-only sections are kept, whitespace-only edits fall back to the generated body, and `reset: true` is the only path that discards edits. Not yet wired into the regeneration flow. Part of #2051.
