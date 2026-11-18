---
"@remnic/core": patch
---

Stability: stable

Local rerank uses a compact order-json prompt, shorter snippets, capped candidates, and a 48-token decode budget so warm calls land around 2s on the trained Studio model (fail-open timeout unchanged).
