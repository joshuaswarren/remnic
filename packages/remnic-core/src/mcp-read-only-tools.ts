/**
 * Conservative allowlist of canonical MCP tool suffixes that are
 * unambiguously read-only. Tools in this set are tagged with
 * `annotations: { readOnlyHint: true }` so ChatGPT (and other MCP
 * clients that honor the hint) can skip per-call confirmation.
 *
 * The list is suffix-based so it covers both the `remnic.*` and
 * `engram.*` naming forms. Anything not on it stays unannotated:
 * uncertainty is resolved as "might mutate".
 *
 * Excluded by construction: anything that writes, runs a pipeline,
 * flushes, applies, records, imports, or destructively deletes.
 */
export const MCP_READ_ONLY_TOOL_SUFFIXES: Readonly<Record<string, true>> = {
  recall: true,
  recall_explain: true,
  recall_tier_explain: true,
  recall_xray: true,
  briefing: true,
  wearables_status: true,
  transcript_day: true,
  transcript_search: true,
  transcript_memories: true,
  meetings_list: true,
  meetings_get: true,
  action_confidence: true,
  capsule_list: true,
  procedural_stats: true,
  memory_get: true,
  memory_timeline: true,
  entity_get: true,
  review_queue_list: true,
  lcm_search: true,
  continuity_incident_list: true,
  identity_anchor_get: true,
  memory_identity: true,
  memory_search: true,
  memory_profile: true,
  memory_entities_list: true,
  memory_questions: true,
  memory_last_recall: true,
  memory_intent_debug: true,
  memory_qmd_debug: true,
  memory_graph_explain: true,
  graph_snapshot: true,
  review_list: true,
  profiling_report: true,
  peer_list: true,
  peer_get: true,
  peer_profile_get: true,
  console_state: true,
  dreams_status: true,
  codegraph_list_projects: true,
  codegraph_index_status: true,
  codegraph_search_graph: true,
  codegraph_trace_path: true,
  codegraph_detect_changes: true,
  codegraph_query_graph: true,
  codegraph_get_schema: true,
  codegraph_get_snippet: true,
  codegraph_get_architecture: true,
  codegraph_search_code: true,
};
