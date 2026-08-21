---
"@remnic/core": minor
---

Add `engram.entity_synthesis_run` — an operator-triggered bulk drain for the entity synthesis queue (issue #2136). Every automatic call site (consolidation, session close, governance-apply refresh) processes at most 5 entities per event, which a busy deployment's queue inflow outruns; the new access operation drains up to `maxEntities` (default 25, clamped to 200) per call and reports `{requested, processed, remaining}` so operators can loop until `processed < requested`. Invalid `maxEntities` values are rejected, not silently defaulted. The MCP admin/maintenance tool-listing block moved to `access-mcp-admin-tools.ts` (structural ratchet).
