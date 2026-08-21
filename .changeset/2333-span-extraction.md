---
"@remnic/core": patch
---

Add a default-off span offset parser. Disabled or `0` returns the whole text. Enabled slices half-open `[start, end)` and rejects reversed or out-of-range offsets. Default extraction path is unchanged. Part of #2333.
