---
"@remnic/core": patch
---

Add `selectRecapForDay` to the activity timeline layer. It selects the journal body in precedence order (AI render, last stored journal, deterministic render), skips blank bodies, throws on an unknown or slot-mismatched candidate kind, and echoes a non-blank provider failure string onto the result. Internal helper; wiring into the recap build path is a later slice. Part of #2051.
