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
  { tool: "recall", operation: "recall" },
  { tool: "recall_explain", operation: "recall_explain" },
  { tool: "set_coding_context", operation: "set_coding_context" },
  { tool: "recall_tier_explain", operation: "recall_tier_explain" },
  { tool: "recall_xray", operation: "recall_xray" },
  { tool: "wearables_status", operation: "wearables_status" },
  { tool: "wearables_sync", operation: "wearables_sync" },
  { tool: "transcript_day", operation: "transcript_day" },
  { tool: "transcript_search", operation: "transcript_search" },
  { tool: "transcript_memories", operation: "transcript_memories" },
  { tool: "meetings_list", operation: "meetings_list" },
  { tool: "meetings_get", operation: "meetings_get" },
  { tool: "meetings_build", operation: "meetings_build" },
  { tool: "action_confidence", operation: "action_confidence" },
  { tool: "chatgpt_memory_inspector", operation: "chatgpt_memory_inspector" },
  { tool: "day_summary", operation: "day_summary" },
  { tool: "capsule_export", operation: "capsule_export" },
  { tool: "capsule_import", operation: "capsule_import" },
  { tool: "capsule_list", operation: "capsule_list" },
  { tool: "memory_governance_run", operation: "memory_governance_run" },
  { tool: "entity_synthesis_run", operation: "entity_synthesis_run" },
  { tool: "procedure_mining_run", operation: "procedure_mining_run" },
  { tool: "pattern_reinforcement_run", operation: "pattern_reinforcement_run" },
  { tool: "procedural_stats", operation: "procedural_stats" },
  { tool: "memory_get", operation: "memory_get" },
  { tool: "memory_timeline", operation: "memory_timeline" },
  { tool: "memory_store", operation: "memory_store" },
  // Correction Contract (issue #1580) — one plan/apply pipeline.
  { tool: "memory_correct_plan", operation: "memory_correct_plan" },
  { tool: "memory_correct_apply", operation: "memory_correct_apply" },
  // Conversational memory inspection + correction (issue #1583) — unmigrated
  // handler dispatched to processChatMessage (not a boundary operation).
  { tool: "memory_chat", operation: "chat_message" },
  { tool: "coding_decision", operation: "coding_decision" },
  { tool: "coding_architecture", operation: "coding_architecture" },
  // codegraph parity tools (issue #1554)
  { tool: "codegraph_index", operation: "codegraph_index" },
  { tool: "codegraph_list_projects", operation: "codegraph_list_projects" },
  { tool: "codegraph_delete_project", operation: "codegraph_delete_project" },
  { tool: "codegraph_index_status", operation: "codegraph_index_status" },
  { tool: "codegraph_search_graph", operation: "codegraph_search_graph" },
  { tool: "codegraph_trace_path", operation: "codegraph_trace_path" },
  { tool: "codegraph_detect_changes", operation: "codegraph_detect_changes" },
  { tool: "codegraph_query_graph", operation: "codegraph_query_graph" },
  { tool: "codegraph_get_schema", operation: "codegraph_get_schema" },
  { tool: "codegraph_get_snippet", operation: "codegraph_get_snippet" },
  { tool: "codegraph_get_architecture", operation: "codegraph_get_architecture" },
  { tool: "codegraph_search_code", operation: "codegraph_search_code" },
  { tool: "codegraph_manage_adr", operation: "codegraph_manage_adr" },
  { tool: "codegraph_ingest_traces", operation: "codegraph_ingest_traces" },
  { tool: "coding_delta", operation: "coding_delta" },
  { tool: "suggestion_submit", operation: "suggestion_submit" },
  { tool: "entity_get", operation: "entity_get" },
  { tool: "review_queue_list", operation: "review_queue_list" },
  { tool: "observe", operation: "observe" },
  { tool: "lcm_search", operation: "lcm_search" },
  { tool: "lcm_compaction_flush", operation: "lcm_compaction_flush" },
  { tool: "extraction_force_flush", operation: "extraction_force_flush" },
  { tool: "lcm_compaction_record", operation: "lcm_compaction_record" },
  { tool: "continuity_audit_generate", operation: "continuity_audit_generate" },
  { tool: "continuity_incident_open", operation: "continuity_incident_open" },
  { tool: "continuity_incident_close", operation: "continuity_incident_close" },
  { tool: "continuity_incident_list", operation: "continuity_incident_list" },
  { tool: "continuity_loop_add_or_update", operation: "continuity_loop_add_or_update" },
  { tool: "continuity_loop_review", operation: "continuity_loop_review" },
  { tool: "identity_anchor_get", operation: "identity_anchor_get" },
  { tool: "identity_anchor_update", operation: "identity_anchor_update" },
  { tool: "memory_identity", operation: "memory_identity" },
  { tool: "work_task", operation: "work_task" },
  { tool: "work_project", operation: "work_project" },
  { tool: "work_board", operation: "work_board" },
  { tool: "shared_context_write_output", operation: "shared_context_write_output" },
  { tool: "shared_feedback_record", operation: "shared_feedback_record" },
  { tool: "shared_priorities_append", operation: "shared_priorities_append" },
  { tool: "shared_context_cross_signals_run", operation: "shared_context_cross_signals_run" },
  { tool: "shared_context_curate_daily", operation: "shared_context_curate_daily" },
  { tool: "compounding_weekly_synthesize", operation: "compounding_weekly_synthesize" },
  { tool: "compounding_promote_candidate", operation: "compounding_promote_candidate" },
  { tool: "compression_guidelines_optimize", operation: "compression_guidelines_optimize" },
  { tool: "compression_guidelines_activate", operation: "compression_guidelines_activate" },
  { tool: "memory_search", operation: "memory_search" },
  { tool: "external_wiki_search", operation: "external_wiki_search" },
  { tool: "memory_profile", operation: "memory_profile" },
  { tool: "memory_entities_list", operation: "memory_entities_list" },
  { tool: "memory_questions", operation: "memory_questions" },
  { tool: "memory_last_recall", operation: "memory_last_recall" },
  { tool: "memory_intent_debug", operation: "memory_intent_debug" },
  { tool: "memory_qmd_debug", operation: "memory_qmd_debug" },
  { tool: "memory_graph_explain", operation: "memory_graph_explain" },
  { tool: "graph_snapshot", operation: "graph_snapshot" },
  { tool: "memory_feedback", operation: "memory_feedback" },
  { tool: "memory_promote", operation: "memory_promote" },
  { tool: "memory_outcome", operation: "memory_outcome" },
  { tool: "memory_action_apply", operation: "memory_action_apply" },
  { tool: "context_checkpoint", operation: "context_checkpoint" },
  { tool: "briefing", operation: "briefing" },
  { tool: "review_list", operation: "review_list" },
  { tool: "review_resolve", operation: "review_resolve" },
  { tool: "contradiction_scan_run", operation: "contradiction_scan_run" },
  { tool: "memory_summarize_hourly", operation: "memory_summarize_hourly" },
  { tool: "conversation_index_update", operation: "conversation_index_update" },
  { tool: "profiling_report", operation: "profiling_report" },
  { tool: "graph_edge_decay_run", operation: "graph_edge_decay_run" },
  { tool: "live_connectors_run", operation: "live_connectors_run" },
  { tool: "peer_list", operation: "peer_list" },
  { tool: "peer_get", operation: "peer_get" },
  { tool: "peer_set", operation: "peer_set" },
  { tool: "peer_delete", operation: "peer_delete" },
  { tool: "peer_profile_get", operation: "peer_profile_get" },
  { tool: "peer_forget", operation: "peer_forget" },
  { tool: "console_state", operation: "console_state" },
  { tool: "dreams_status", operation: "dreams_status" },
  { tool: "dreams_run", operation: "dreams_run" },
];

// Each route below corresponds 1:1 to a service-invoking route branch in
// `EngramAccessHttpServer.handle` (access-http.ts). Pathname patterns use
// `:param` for path segments. The fitness test asserts each entry resolves
// against the catalog so a new service route cannot land without either
// Infrastructure routes (health, the /mcp delegate, admin console, UI assets)
// carry no user request envelope and are intentionally excluded. The adapters
// route was migrated through the boundary in issue #1850 round 5 (finding 1):
// it is now op-gated by `enforceTokenOp("adapters_status")` so a scoped token
// cannot reach adapter metadata, and is tracked here so the gate is enforced.
export const HTTP_ROUTES: readonly HttpRouteEntry[] = [
  { method: "GET", pathname: "/engram/v1/adapters", operation: "adapters_status" },
  { method: "POST", pathname: "/engram/v1/recall", operation: "recall" },
  { method: "POST", pathname: "/engram/v1/external-wikis/search", operation: "external_wiki_search" },
  { method: "POST", pathname: "/engram/v1/memories/search", operation: "memory_search" },
  { method: "POST", pathname: "/engram/v1/coding-context", operation: "set_coding_context" },
  { method: "POST", pathname: "/engram/v1/capsules/export", operation: "capsule_export" },
  { method: "POST", pathname: "/engram/v1/capsules/import", operation: "capsule_import" },
  { method: "GET", pathname: "/engram/v1/offline-sync/snapshot", operation: "offline_sync_snapshot" },
  { method: "GET", pathname: "/engram/v1/offline-sync/capabilities", operation: "offline_sync_snapshot" },
    { method: "POST", pathname: "/engram/v1/offline-sync/snapshot", operation: "offline_sync_snapshot" },
  { method: "POST", pathname: "/engram/v1/offline-sync/files", operation: "offline_sync_files" },
  { method: "POST", pathname: "/engram/v1/offline-sync/file-content", operation: "offline_sync_file_content" },
  { method: "POST", pathname: "/engram/v1/offline-sync/apply-file-content", operation: "offline_sync_apply_file_content" },
  {
    method: "POST",
    pathname: "/engram/v1/offline-sync/convergence-complete",
    operation: "offline_sync_apply_file_content",
  },
  { method: "POST", pathname: "/engram/v1/offline-sync/apply", operation: "offline_sync_apply" },
  { method: "POST", pathname: "/engram/v1/recall/explain", operation: "recall_explain" },
  { method: "POST", pathname: "/engram/v1/action-confidence", operation: "action_confidence" },
  { method: "GET", pathname: "/engram/v1/recall/tier-explain", operation: "recall_tier_explain" },
  { method: "GET", pathname: "/engram/v1/recall/xray", operation: "recall_xray" },
  { method: "GET", pathname: "/engram/v1/namespace/writable", operation: "namespace_writable" },
  { method: "GET", pathname: "/engram/v1/wearables/status", operation: "wearables_status" },
  { method: "POST", pathname: "/engram/v1/wearables/sync", operation: "wearables_sync" },
  { method: "GET", pathname: "/engram/v1/wearables/transcript", operation: "transcript_day" },
  { method: "GET", pathname: "/engram/v1/wearables/transcripts/search", operation: "transcript_search" },
  { method: "GET", pathname: "/engram/v1/wearables/memories", operation: "transcript_memories" },
  { method: "GET", pathname: "/engram/v1/meetings", operation: "meetings_list" },
  { method: "POST", pathname: "/engram/v1/meetings/build", operation: "meetings_build" },
  { method: "GET", pathname: "/engram/v1/meetings/:id", operation: "meetings_get" },
  { method: "POST", pathname: "/engram/v1/observe", operation: "observe" },
  { method: "POST", pathname: "/engram/v1/lcm/search", operation: "lcm_search" },
  { method: "POST", pathname: "/engram/v1/lcm/compaction/flush", operation: "lcm_compaction_flush" },
  { method: "POST", pathname: "/engram/v1/extraction/flush", operation: "extraction_force_flush" },
  { method: "POST", pathname: "/engram/v1/lcm/compaction/record", operation: "lcm_compaction_record" },
  { method: "GET", pathname: "/engram/v1/lcm/status", operation: "lcm_status" },
  { method: "GET", pathname: "/engram/v1/relay/missions/:id", operation: "relay_mission_read" },
  { method: "POST", pathname: "/engram/v1/relay/missions/:id/events", operation: "relay_mission_append" },
  // Correction Contract (issue #1580) — plan/apply/pending.
  { method: "POST", pathname: "/engram/v1/correction/plan", operation: "memory_correct_plan" },
  { method: "POST", pathname: "/engram/v1/correction/apply", operation: "memory_correct_apply" },
  { method: "GET", pathname: "/engram/v1/correction/pending", operation: "correction_pending" },
  { method: "POST", pathname: "/engram/v1/memories", operation: "memory_store" },
  { method: "POST", pathname: "/engram/v1/coding/decisions", operation: "coding_decision" },
  { method: "POST", pathname: "/engram/v1/coding/architecture", operation: "coding_architecture" },
  { method: "POST", pathname: "/engram/v1/coding/delta", operation: "coding_delta" },
  { method: "POST", pathname: "/engram/v1/suggestions", operation: "suggestion_submit" },
  { method: "GET", pathname: "/engram/v1/memories", operation: "memory_list" },
  { method: "GET", pathname: "/engram/v1/recall/timings", operation: "recall_timings" },
  { method: "GET", pathname: "/engram/v1/memories/:id", operation: "memory_get" },
  { method: "GET", pathname: "/engram/v1/memories/:id/timeline", operation: "memory_timeline" },
  { method: "GET", pathname: "/engram/v1/entities", operation: "entity_list" },
  { method: "GET", pathname: "/engram/v1/entities/:id", operation: "entity_get" },
  { method: "GET", pathname: "/engram/v1/review-queue", operation: "review_queue_list" },
  { method: "GET", pathname: "/engram/v1/maintenance", operation: "maintenance_status" },
  { method: "GET", pathname: "/engram/v1/quality", operation: "quality_status" },
  { method: "GET", pathname: "/engram/v1/trust-zones/status", operation: "trust_zones_status" },
  { method: "GET", pathname: "/engram/v1/procedural/stats", operation: "procedural_stats" },
  { method: "GET", pathname: "/engram/v1/trust-zones/records", operation: "trust_zones_records" },
  { method: "POST", pathname: "/engram/v1/review-disposition", operation: "review_disposition" },
  { method: "POST", pathname: "/engram/v1/trust-zones/promote", operation: "trust_zones_promote" },
  { method: "POST", pathname: "/engram/v1/trust-zones/demo-seed", operation: "trust_zones_demo_seed" },
  { method: "POST", pathname: "/v1/citations/observed", operation: "citations_observed" },
  { method: "GET", pathname: "/engram/v1/review/contradictions", operation: "review_list" },
  { method: "GET", pathname: "/engram/v1/review/contradictions/:id", operation: "contradiction_detail" },
  { method: "POST", pathname: "/engram/v1/review/resolve", operation: "review_resolve" },
  { method: "GET", pathname: "/engram/v1/graph/snapshot", operation: "graph_snapshot" },
  { method: "POST", pathname: "/engram/v1/contradiction-scan", operation: "contradiction_scan_run" },
    { method: "GET", pathname: "/engram/v1/console/state", operation: "console_state" },
  { method: "GET", pathname: "/engram/v1/peers", operation: "peer_list" },
  { method: "GET", pathname: "/engram/v1/peers/:id/profile", operation: "peer_profile_get" },
  { method: "GET", pathname: "/engram/v1/peers/:id", operation: "peer_get" },
  { method: "PUT", pathname: "/engram/v1/peers/:id", operation: "peer_set" },
  { method: "DELETE", pathname: "/engram/v1/peers/:id", operation: "peer_delete" },
  { method: "GET", pathname: "/engram/v1/dreams/status", operation: "dreams_status" },
  { method: "POST", pathname: "/engram/v1/dreams/run", operation: "dreams_run" },
  // SSE-only endpoints: carried in the catalog for completeness tracking.
  // The operation registration makes them visible to the boundary; the
  // streaming lifecycle is owned by the HTTP transport (handleGraphEventsSSE).
  { method: "GET", pathname: "/engram/v1/offline-sync/snapshot-stream", operation: "offline_sync_snapshot_stream" },
  { method: "GET", pathname: "/engram/v1/offline-sync/manifest-stream", operation: "offline_sync_snapshot_stream" },
  { method: "GET", pathname: "/engram/v1/graph/events", operation: "graph_events" },
  { method: "POST", pathname: "/engram/v1/chat/message", operation: "chat_message" },
  { method: "GET", pathname: "/engram/v1/chat/events/:id", operation: "chat_events" },
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
