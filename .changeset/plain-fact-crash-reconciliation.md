---
"@remnic/core": patch
---

Recover interrupted opt-in extraction receipts for plain facts only after verifying an immutable complete plan and exact writer provenance in durable fact files. Changed plans, missing or modified effects, and unsupported artifact paths remain incomplete. Retries remain at-least-once and require the same validated provider plan.

Stability: alpha
