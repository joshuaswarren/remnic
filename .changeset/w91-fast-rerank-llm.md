---
"@remnic/core": patch
---

Stability: stable

Local rerank uses a compact order-json prompt, shorter snippets, and capped candidates. Decode budget is `24 + 10×candidate count` (max 256). Each rerank attempt caps at 2500 ms; on timeout, empty model reply, or unparseable JSON, recall keeps the pre-rerank order (fail-open).
