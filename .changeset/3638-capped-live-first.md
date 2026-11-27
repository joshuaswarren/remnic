---
"@remnic/core": patch
Stability: stable
---

The backlog scheduler now drains a live session that has reached `bufferMaxTurnsPerSession` before it lists the claim backlog. Before, discovery always put one page of existing drain claims first and re-listed that page whenever the concurrency bound stopped submission. With a large claim backlog, live sessions never got a slot, and a session at its turn cap refused every new durable observe capture. Only capped sessions move ahead, so older claims still drain in page order once no live session is at the cap. Closes #3638.
