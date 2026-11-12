---
"@remnic/core": patch
---

Explicit fact captures (`memory_store` and inline memory notes) now commit inside the per-directory fact-dedup window. A concurrent extraction or promotion write of the same fact is caught by the recheck, so it no longer leaves a second active copy.

Stability: stable
