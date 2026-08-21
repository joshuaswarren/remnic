---
"@remnic/core": patch
---

Add a span clipper. Offsets clip to `[0, textLength]`. Empty after clip returns `{ok:false,error:"empty"}`. Non-integers throw. Extraction wiring is unchanged. Part of #2333.
