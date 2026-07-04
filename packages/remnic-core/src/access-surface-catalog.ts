/**
 * Static inventory of every handler on the MCP and HTTP access surfaces, with
 * its migration status against the access boundary (issue #1525).
 *
 * The fitness test (`access-surface-catalog.test.ts`) walks this catalog,
 * checks each entry against the live registry, and counts unmigrated handlers.
 * The ratchet (`scripts/check-ratchets.mjs`) reads this file and counts
 * `operation: null` entries so the unmigrated count can only decrease.
 *
 * WHEN MIGRATING A HANDLER (follow-up PRs):
 *   1. Add the operation to `access-operations.ts` via `defineOperation`.
 *   2. Flip its entry here from `operation: null` to `operation: "<name>"`.
 *   3. Delete the surface-local validation the handler used to do.
 *   4. Run `node scripts/check-ratchets.mjs --update` to ratchet the count
 *      down — the improvement is recorded in `scripts/ratchet-baseline.json`.
 *
 * WHEN ADDING A NEW HANDLER:
 *   1. Add the entry here with `operation: null` (the fitness test will fail
 *      until you either migrate it or acknowledge it as unmigrated).
 *   2. Migrate it in the same PR if it carries user input — the boundary's
 *      whole point is that no new handler bypasses it.
 */

import type { OperationName } from "./access-boundary.js";

/**
 * One row per MCP tool, keyed by the canonical SHORT name (no `engram.`/
 * `remnic.` prefix — both aliases dispatch to the same operation). The name
 * MUST match the tool's short suffix as advertised by `tools/list`.
 */
export interface McpToolEntry {
  readonly tool: string;
  readonly operation: OperationName | null;
}

/**
 * One row per HTTP route that invokes an access-service method. Routes that
 * only serve static assets, SSE streams, or admin console HTML are excluded —
 * they don't carry user-validated request envelopes into the facade.
 */
export interface HttpRouteEntry {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly pathname: string;
  readonly operation: OperationName | null;
}

// Each tool below corresponds 1:1 to an `engram.*` definition in
// `EngramMcpServer.tools` (access-mcp.ts). The fitness test asserts the live
// `tools/list` response matches this list by short name, so a new tool cannot
// land without either migrating it or acknowledging the unmigrated count.
export const MCP_TOOLS: readonly McpToolEntry[] = [
  { tool: "recall", operation: null },
  { tool: "recall_explain", operation: null },
  { tool: "set_coding_context", operation: null },
  { tool: "recall_tier_explain", operation: null },
  { tool: "recall_xray", operation: null },
  { tool: "wearables_status", operation: null },
  { tool: "wearables_sync", operation: null },
  { tool: "transcript_day", operation: null },
  { tool: "transcript_search", operation: null },
  { tool: "transcript_memories", operation: null },
  { tool: "action_confidence", operation: null },
  { tool: "chatgpt_memory_inspector", operation: null },
  { tool: "day_summary", operation: null },
  { tool: "capsule_export", operation: null },
  { tool: "capsule_import", operation: null },
  { tool: "capsule_list", operation: null },
  { tool: "memory_governance_run", operation: null },
  { tool: "procedure_mining_run", operation: null },
  { tool: "pattern_reinforcement_run", operation: null },
  { tool: "procedural_stats", operation: null },
  { tool: "memory_get", operation: "memory_get" },
  { tool: "memory_timeline", operation: null },
  { tool: "memory_store", operation: "memory_store" },
  { tool: "coding_decision", operation: "coding_decision" },
  { tool: "suggestion_submit", operation: null },
  { tool: "entity_get", operation: null },
  { tool: "review_queue_list", operation: null },
  { tool: "observe", operation: null },
  { tool: "lcm_search", operation: null },
  { tool: "lcm_compaction_flush", operation: null },
  { tool: "lcm_compaction_record", operation: null },
  { tool: "continuity_audit_generate", operation: null },
  { tool: "continuity_incident_open", operation: null },
  { tool: "continuity_incident_close", operation: null },
  { tool: "continuity_incident_list", operation: null },
  { tool: "continuity_loop_add_or_update", operation: null },
  { tool: "continuity_loop_review", operation: null },
  { tool: "identity_anchor_get", operation: null },
  { tool: "identity_anchor_update", operation: null },
  { tool: "memory_identity", operation: null },
  { tool: "work_task", operation: null },
  { tool: "work_project", operation: null },
  { tool: "work_board", operation: null },
  { tool: "shared_context_write_output", operation: null },
  { tool: "shared_feedback_record", operation: null },
  { tool: "shared_priorities_append", operation: null },
  { tool: "shared_context_cross_signals_run", operation: null },
  { tool: "shared_context_curate_daily", operation: null },
  { tool: "compounding_weekly_synthesize", operation: null },
  { tool: "compounding_promote_candidate", operation: null },
  { tool: "compression_guidelines_optimize", operation: null },
  { tool: "compression_guidelines_activate", operation: null },
  { tool: "memory_search", operation: "memory_search" },
  { tool: "memory_profile", operation: null },
  { tool: "memory_entities_list", operation: null },
  { tool: "memory_questions", operation: null },
  { tool: "memory_last_recall", operation: null },
  { tool: "memory_intent_debug", operation: null },
  { tool: "memory_qmd_debug", operation: null },
  { tool: "memory_graph_explain", operation: null },
  { tool: "graph_snapshot", operation: null },
  { tool: "memory_feedback", operation: null },
  { tool: "memory_promote", operation: null },
  { tool: "memory_outcome", operation: null },
  { tool: "memory_action_apply", operation: null },
  { tool: "context_checkpoint", operation: null },
  { tool: "briefing", operation: null },
  { tool: "review_list", operation: null },
  { tool: "review_resolve", operation: null },
  { tool: "contradiction_scan_run", operation: null },
  { tool: "memory_summarize_hourly", operation: null },
  { tool: "conversation_index_update", operation: null },
  { tool: "profiling_report", operation: null },
  { tool: "graph_edge_decay_run", operation: null },
  { tool: "live_connectors_run", operation: null },
  { tool: "peer_list", operation: null },
  { tool: "peer_get", operation: null },
  { tool: "peer_set", operation: null },
  { tool: "peer_delete", operation: null },
  { tool: "peer_profile_get", operation: null },
  { tool: "peer_forget", operation: null },
  { tool: "console_state", operation: null },
  { tool: "dreams_status", operation: null },
  { tool: "dreams_run", operation: null },
];

// Each route below corresponds 1:1 to a service-invoking route branch in
// `EngramAccessHttpServer.handle` (access-http.ts). Pathname patterns use
// `:param` for path segments. The fitness test asserts each entry resolves
// against the catalog so a new service route cannot land without either
// migrating it or acknowledging the unmigrated count. Infrastructure probes
// (health, adapters, the /mcp delegate, admin console, SSE-only endpoints)
// carry no user request envelope and are intentionally excluded.
export const HTTP_ROUTES: readonly HttpRouteEntry[] = [
  { method: "POST", pathname: "/engram/v1/recall", operation: null },
  { method: "POST", pathname: "/engram/v1/coding-context", operation: null },
  { method: "POST", pathname: "/engram/v1/capsules/export", operation: null },
  { method: "POST", pathname: "/engram/v1/capsules/import", operation: null },
  { method: "GET", pathname: "/engram/v1/offline-sync/snapshot", operation: null },
  { method: "GET", pathname: "/engram/v1/offline-sync/snapshot-stream", operation: null },
  { method: "POST", pathname: "/engram/v1/offline-sync/snapshot", operation: null },
  { method: "POST", pathname: "/engram/v1/offline-sync/files", operation: null },
  { method: "POST", pathname: "/engram/v1/offline-sync/file-content", operation: null },
  { method: "POST", pathname: "/engram/v1/offline-sync/apply-file-content", operation: null },
  { method: "POST", pathname: "/engram/v1/offline-sync/apply", operation: null },
  { method: "POST", pathname: "/engram/v1/recall/explain", operation: null },
  { method: "POST", pathname: "/engram/v1/action-confidence", operation: null },
  { method: "GET", pathname: "/engram/v1/recall/tier-explain", operation: null },
  { method: "GET", pathname: "/engram/v1/recall/xray", operation: null },
  { method: "GET", pathname: "/engram/v1/wearables/status", operation: null },
  { method: "POST", pathname: "/engram/v1/wearables/sync", operation: null },
  { method: "GET", pathname: "/engram/v1/wearables/transcript", operation: null },
  { method: "GET", pathname: "/engram/v1/wearables/transcripts/search", operation: null },
  { method: "GET", pathname: "/engram/v1/wearables/memories", operation: null },
  { method: "POST", pathname: "/engram/v1/observe", operation: null },
  { method: "POST", pathname: "/engram/v1/lcm/search", operation: null },
  { method: "POST", pathname: "/engram/v1/lcm/compaction/flush", operation: null },
  { method: "POST", pathname: "/engram/v1/lcm/compaction/record", operation: null },
  { method: "GET", pathname: "/engram/v1/lcm/status", operation: null },
  { method: "POST", pathname: "/engram/v1/memories", operation: "memory_store" },
  { method: "POST", pathname: "/engram/v1/coding/decisions", operation: "coding_decision" },
  { method: "POST", pathname: "/engram/v1/suggestions", operation: null },
  { method: "GET", pathname: "/engram/v1/memories", operation: null },
  { method: "GET", pathname: "/engram/v1/memories/:id", operation: "memory_get" },
  { method: "GET", pathname: "/engram/v1/memories/:id/timeline", operation: null },
  { method: "GET", pathname: "/engram/v1/entities", operation: null },
  { method: "GET", pathname: "/engram/v1/entities/:id", operation: null },
  { method: "GET", pathname: "/engram/v1/review-queue", operation: null },
  { method: "GET", pathname: "/engram/v1/maintenance", operation: null },
  { method: "GET", pathname: "/engram/v1/quality", operation: null },
  { method: "GET", pathname: "/engram/v1/trust-zones/status", operation: null },
  { method: "GET", pathname: "/engram/v1/procedural/stats", operation: null },
  { method: "GET", pathname: "/engram/v1/trust-zones/records", operation: null },
  { method: "POST", pathname: "/engram/v1/review-disposition", operation: null },
  { method: "POST", pathname: "/engram/v1/trust-zones/promote", operation: null },
  { method: "POST", pathname: "/engram/v1/trust-zones/demo-seed", operation: null },
  { method: "POST", pathname: "/v1/citations/observed", operation: null },
  { method: "GET", pathname: "/engram/v1/review/contradictions", operation: null },
  { method: "GET", pathname: "/engram/v1/review/contradictions/:id", operation: null },
  { method: "POST", pathname: "/engram/v1/review/resolve", operation: null },
  { method: "GET", pathname: "/engram/v1/graph/snapshot", operation: null },
  { method: "POST", pathname: "/engram/v1/contradiction-scan", operation: null },
  { method: "GET", pathname: "/engram/v1/graph/events", operation: null },
  { method: "GET", pathname: "/engram/v1/console/state", operation: null },
  { method: "GET", pathname: "/engram/v1/peers", operation: null },
  { method: "GET", pathname: "/engram/v1/peers/:id/profile", operation: null },
  { method: "GET", pathname: "/engram/v1/peers/:id", operation: null },
  { method: "PUT", pathname: "/engram/v1/peers/:id", operation: null },
  { method: "DELETE", pathname: "/engram/v1/peers/:id", operation: null },
  { method: "GET", pathname: "/engram/v1/dreams/status", operation: null },
  { method: "POST", pathname: "/engram/v1/dreams/run", operation: null },
];

/**
 * Total unmigrated-handler count across both surfaces. The ratchet baseline
 * tracks this number; it may only decrease. `access-surface-catalog.test.ts`
 * recomputes it from the live catalog and asserts equality, so a catalog edit
 * without a baseline bump (or, ideally, a migration) fails the gate.
 */
export function countUnmigratedHandlers(): number {
  let count = 0;
  for (const entry of MCP_TOOLS) {
    if (entry.operation === null) count += 1;
  }
  for (const entry of HTTP_ROUTES) {
    if (entry.operation === null) count += 1;
  }
  return count;
}
