---
"@remnic/core": minor
---

Stability: alpha

Add default-off `extractionReceiptsEnabled` and opt-in extraction receipts for exact observed text pieces, authenticated owner-scoped reads, and writer-confirmed outcomes. Persist actual artifact IDs and fence attempts per piece; distinguish validated empty extraction from failed, filtered, truncated, or partially persisted results.

This is an integration checkpoint. Void writers, deduplication, cross-namespace effects and ambiguous write journals retain incomplete coverage until verified reconciliation is available. Backfill consumers must retain input while coverageComplete is false.
