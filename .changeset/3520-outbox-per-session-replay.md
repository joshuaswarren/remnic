---
"@remnic/plugin-pi": patch
---

A permanently rejected observe capture no longer blocks every queued capture behind it. The drain now sets the refused session aside for the rest of the pass — its entries stay queued in order for the next retry — while captures from other sessions still run. Same-session FIFO, per-destination eligibility, and retry-until-fixed retention are unchanged.

Stability: stable
