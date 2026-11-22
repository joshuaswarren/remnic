---
"@remnic/core": patch
Stability: stable
---

`ModelRegistry.fetchFromHuggingFace` is removed. It only logged "not yet implemented" and returned `false`, and nothing called it; model capabilities still come from the known-models table and manual updates. Refs #3561.
