---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Finish pending digest-cache writes before offline commands return, including error exits. Prevent delayed writes from recreating a removed memory root.
