/**
 * Output-schema registry for MCP tools — extracted from access-mcp.ts to
 * keep that file under the 3000-LOC structural ratchet.
 *
 * Contains the per-suffix JSON-Schema declarations (derived from
 * production TS return contracts) and the application helper that
 * assigns schemas to tool objects.
 */

const T_STRING = { type: "string" } as const;
const T_NUMBER = { type: "number" } as const;
const T_BOOLEAN = { type: "boolean" } as const;
const T_ARRAY = { type: "array" } as const;
const T_OBJECT = { type: "object" } as const;
const T_NULLABLE_OBJECT = { type: ["object", "null"] } as const;
const T_NULLABLE_STRING = { type: ["string", "null"] } as const;

/** Build a JSON Schema object type with the given properties. */
function objectSchema(
  properties: Record<string, Readonly<Record<string, unknown>>>,
  required?: readonly string[]
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: true,
  };
}

/**
 * Per-suffix outputSchema registry. Tools not present here fall back to
 * `{ type: "object", additionalProperties: true }` in the constructor pass.
 * The `chatgpt_memory_inspector` tool ships its own precise schema and is
 * intentionally absent — the apply pass skips tools that already have one.
 */
const TOOL_OUTPUT_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  recall: objectSchema({
    query: T_STRING,
    namespace: T_STRING,
    context: T_STRING,
    contextComposition: objectSchema({ context: T_STRING, footer: T_STRING }),
    count: T_NUMBER,
    memoryIds: T_ARRAY,
    results: T_ARRAY,
    fallbackUsed: T_BOOLEAN,
    sourcesUsed: T_ARRAY,
  }),
  recall_explain: objectSchema({
    found: T_BOOLEAN,
    snapshot: T_OBJECT,
    intent: T_NULLABLE_OBJECT,
    graph: T_NULLABLE_OBJECT,
  }),
  recall_tier_explain: objectSchema({ snapshotFound: T_BOOLEAN, tierExplain: T_NULLABLE_OBJECT }),
  recall_xray: objectSchema({ snapshotFound: T_BOOLEAN, snapshot: T_OBJECT }),
  who_knows: objectSchema({ topic: T_STRING, results: T_ARRAY }),
  promotion_candidates: objectSchema({ namespace: T_STRING, targetNamespace: T_STRING, candidates: T_ARRAY }),
  set_coding_context: objectSchema({ ok: T_BOOLEAN }),
  wearables_status: objectSchema({
    enabled: T_BOOLEAN,
    timezone: T_STRING,
    sources: T_ARRAY,
    connectorsInstalled: T_ARRAY,
  }),
  wearables_sync: objectSchema({ summaries: T_ARRAY }, ["summaries"]),
  transcript_day: objectSchema({ transcripts: T_ARRAY }, ["transcripts"]),
  transcript_search: objectSchema({ results: T_ARRAY }, ["results"]),
  transcript_memories: objectSchema({ memories: T_ARRAY }, ["memories"]),
  location_status: objectSchema({ enabled: T_BOOLEAN, timezone: T_STRING, sources: T_ARRAY, recentDays: T_ARRAY }),
  location_check: objectSchema({ results: T_ARRAY }, ["results"]),
  location_sync: objectSchema({ days: T_ARRAY }, ["days"]),
  location_backfill: objectSchema({ days: T_ARRAY }, ["days"]),
  location_day: objectSchema({ date: T_STRING, found: T_BOOLEAN, sources: T_ARRAY, observationCount: T_NUMBER }),
  meetings_list: objectSchema({ enabled: T_BOOLEAN, days: T_ARRAY }),
  meetings_get: objectSchema({ enabled: T_BOOLEAN, found: T_BOOLEAN, id: T_STRING, record: T_NULLABLE_STRING }),
  meetings_build: objectSchema({
    date: T_STRING,
    enabled: T_BOOLEAN,
    meetings: T_ARRAY,
    built: T_NUMBER,
    skipped: T_NUMBER,
    removed: T_ARRAY,
  }),
  deep_recall: objectSchema(
    { ok: T_BOOLEAN, error: T_NULLABLE_STRING, entries: T_ARRAY, trace: T_ARRAY, rendered: T_STRING },
    ["entries", "trace"]
  ),
  standup: objectSchema({
    date: T_STRING,
    yesterday: T_STRING,
    today: T_STRING,
    highlights: T_ARRAY,
    priorities: T_ARRAY,
    blockers: T_ARRAY,
    activityGrid: T_STRING,
    markdown: T_STRING,
  }),
  action_confidence: objectSchema({
    schemaVersion: T_NUMBER,
    decision: T_STRING,
    confidence: T_NUMBER,
    risk: T_STRING,
    contextReadiness: T_STRING,
    intendedAction: T_STRING,
    attentionPolicy: T_STRING,
    principle: T_STRING,
    reasons: T_ARRAY,
    blockers: T_ARRAY,
    factors: T_ARRAY,
    retrievedMemoryCount: T_NUMBER,
    scopeMismatchCount: T_NUMBER,
    safeToAct: T_BOOLEAN,
  }),
  day_summary: objectSchema({
    summary: T_STRING,
    bullets: T_ARRAY,
    next_actions: T_ARRAY,
    risks_or_open_loops: T_ARRAY,
  }),
  capsule_export: objectSchema({
    archivePath: T_STRING,
    manifestPath: T_STRING,
    encryptedArchivePath: T_NULLABLE_STRING,
    manifest: T_OBJECT,
  }),
  capsule_import: objectSchema({ imported: T_ARRAY, skipped: T_ARRAY, manifest: T_OBJECT }),
  capsule_list: objectSchema({ namespace: T_STRING, capsulesDir: T_STRING, capsules: T_ARRAY }),
  entity_synthesis_run: objectSchema({
    namespace: T_STRING,
    requested: T_NUMBER,
    processed: T_NUMBER,
    remaining: T_NUMBER,
  }),
  memory_governance_run: objectSchema({
    namespace: T_STRING,
    runId: T_STRING,
    traceId: T_STRING,
    mode: T_STRING,
    reviewQueueCount: T_NUMBER,
    proposedActionCount: T_NUMBER,
    appliedActionCount: T_NUMBER,
    summaryPath: T_STRING,
    reportPath: T_STRING,
  }),
  procedure_mining_run: objectSchema({ namespace: T_STRING, clustersProcessed: T_NUMBER, proceduresWritten: T_NUMBER }),
  pattern_reinforcement_run: objectSchema({
    namespace: T_STRING,
    ran: T_BOOLEAN,
    clustersFound: T_NUMBER,
    canonicalsUpdated: T_NUMBER,
    duplicatesSuperseded: T_NUMBER,
  }),
  procedural_stats: objectSchema({ namespace: T_STRING, counts: T_OBJECT, recent: T_OBJECT }),
  procedure_library_maintenance: objectSchema({
    enabled: T_BOOLEAN,
    namespace: T_STRING,
    report: T_OBJECT,
  }),
  memory_get: objectSchema({ found: T_BOOLEAN, namespace: T_STRING, memory: T_NULLABLE_OBJECT }),
  memory_timeline: objectSchema({ found: T_BOOLEAN, namespace: T_STRING, count: T_NUMBER, timeline: T_ARRAY }),
  memory_store: objectSchema({
    schemaVersion: T_NUMBER,
    operation: T_STRING,
    namespace: T_STRING,
    dryRun: T_BOOLEAN,
    accepted: T_BOOLEAN,
    queued: T_BOOLEAN,
    status: T_STRING,
    memoryId: T_STRING,
  }),
  suggestion_submit: objectSchema({
    schemaVersion: T_NUMBER,
    operation: T_STRING,
    namespace: T_STRING,
    dryRun: T_BOOLEAN,
    accepted: T_BOOLEAN,
    queued: T_BOOLEAN,
    status: T_STRING,
    memoryId: T_STRING,
  }),
  entity_get: objectSchema({ found: T_BOOLEAN, namespace: T_STRING, entity: T_NULLABLE_OBJECT }),
  review_queue_list: objectSchema({ found: T_BOOLEAN, runId: T_STRING, reviewQueue: T_ARRAY }),
  observe: objectSchema({
    accepted: T_NUMBER,
    sessionKey: T_STRING,
    namespace: T_STRING,
    effectiveNamespace: T_STRING,
    lcmArchived: T_BOOLEAN,
    extractionQueued: T_BOOLEAN,
    transcriptPersisted: T_BOOLEAN,
  }),
  lcm_search: objectSchema({
    query: T_STRING,
    namespace: T_STRING,
    results: T_ARRAY,
    count: T_NUMBER,
    lcmEnabled: T_BOOLEAN,
  }),
  lcm_compaction_flush: objectSchema({
    enabled: T_BOOLEAN,
    flushed: T_BOOLEAN,
    sessionKey: T_STRING,
    namespace: T_STRING,
  }),
  extraction_force_flush: objectSchema({
    flushed: T_BOOLEAN,
    sessionKey: T_STRING,
    namespace: T_STRING,
    effectiveNamespace: T_STRING,
  }),
  lcm_compaction_record: objectSchema({
    enabled: T_BOOLEAN,
    recorded: T_BOOLEAN,
    sessionKey: T_STRING,
    namespace: T_STRING,
  }),
  continuity_audit_generate: objectSchema({ enabled: T_BOOLEAN, period: T_STRING, reportPath: T_STRING }),
  continuity_incident_open: objectSchema({ created: T_BOOLEAN, incident: T_NULLABLE_OBJECT }),
  continuity_incident_close: objectSchema({ closed: T_BOOLEAN, incident: T_NULLABLE_OBJECT }),
  continuity_incident_list: objectSchema({ incidents: T_ARRAY }),
  continuity_loop_add_or_update: objectSchema({ saved: T_BOOLEAN, loop: T_NULLABLE_OBJECT }),
  continuity_loop_review: objectSchema({ reviewed: T_BOOLEAN, loop: T_NULLABLE_OBJECT }),
  identity_anchor_get: objectSchema({ found: T_BOOLEAN, anchor: T_NULLABLE_STRING }),
  identity_anchor_update: objectSchema({ updated: T_BOOLEAN, sections: T_ARRAY }),
  memory_identity: objectSchema({ found: T_BOOLEAN, identity: T_NULLABLE_STRING, message: T_STRING }),
  work_task: objectSchema({
    action: T_STRING,
    task: T_NULLABLE_OBJECT,
    tasks: T_ARRAY,
    count: T_NUMBER,
    deleted: T_BOOLEAN,
  }),
  work_project: objectSchema({
    action: T_STRING,
    project: T_NULLABLE_OBJECT,
    projects: T_ARRAY,
    count: T_NUMBER,
    deleted: T_BOOLEAN,
  }),
  work_board: objectSchema({ action: T_STRING, markdown: T_STRING, snapshot: T_OBJECT, result: T_OBJECT }),
  shared_context_write_output: objectSchema({ written: T_BOOLEAN, path: T_STRING }),
  shared_feedback_record: objectSchema({ recorded: T_BOOLEAN }),
  shared_priorities_append: objectSchema({ appended: T_BOOLEAN }),
  shared_context_cross_signals_run: objectSchema({
    crossSignalsMarkdownPath: T_STRING,
    crossSignalsPath: T_STRING,
    sourceCount: T_NUMBER,
    feedbackCount: T_NUMBER,
    overlapCount: T_NUMBER,
  }),
  shared_context_curate_daily: objectSchema({
    roundtablePath: T_STRING,
    crossSignalsMarkdownPath: T_STRING,
    crossSignalsPath: T_STRING,
    overlapCount: T_NUMBER,
  }),
  compounding_weekly_synthesize: objectSchema({
    weekId: T_STRING,
    reportPath: T_STRING,
    reportJsonPath: T_STRING,
    rubricsPath: T_STRING,
    rubricsIndexPath: T_STRING,
    mistakesCount: T_NUMBER,
    promotionCandidateCount: T_NUMBER,
  }),
  compounding_promote_candidate: objectSchema({
    enabled: T_BOOLEAN,
    dryRun: T_BOOLEAN,
    weekId: T_STRING,
    promoted: T_ARRAY,
    skipped: T_ARRAY,
    tombstoneBlocked: T_ARRAY,
  }),
  compression_guidelines_optimize: objectSchema({
    enabled: T_BOOLEAN,
    dryRun: T_BOOLEAN,
    eventCount: T_NUMBER,
    nextGuidelineVersion: T_NUMBER,
    changedRules: T_NUMBER,
    semanticRefinementApplied: T_BOOLEAN,
    persisted: T_BOOLEAN,
  }),
  compression_guidelines_activate: objectSchema({
    enabled: T_BOOLEAN,
    activated: T_BOOLEAN,
    guidelineVersion: { type: ["number", "null"] } as const,
  }),
  memory_search: objectSchema({ query: T_STRING, results: T_ARRAY, count: T_NUMBER }),
  external_wiki_search: objectSchema(
    {
      query: T_STRING,
      hits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            wikiId: T_STRING,
            title: T_STRING,
            path: T_STRING,
            snippet: T_STRING,
            score: T_NUMBER,
            rank: T_NUMBER,
            citations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: T_STRING,
                  lineStart: T_NUMBER,
                  lineEnd: T_NUMBER,
                  note: T_STRING,
                },
                required: ["path", "lineStart", "lineEnd", "note"],
                additionalProperties: false,
              },
            },
            indexBlurb: T_STRING,
          },
          required: ["wikiId", "title", "path", "snippet", "score", "rank", "citations"],
          additionalProperties: false,
        },
      },
      count: T_NUMBER,
      degradedWikiIds: T_ARRAY,
    },
    ["query", "hits", "count", "degradedWikiIds"]
  ),
  memory_profile: objectSchema({ profile: T_STRING }),
  memory_entities_list: objectSchema({ entities: T_ARRAY, count: T_NUMBER }),
  memory_questions: objectSchema({ questions: T_ARRAY, count: T_NUMBER }),
  memory_last_recall: objectSchema({
    sessionKey: T_STRING,
    recordedAt: T_STRING,
    queryHash: T_STRING,
    queryLen: T_NUMBER,
    memoryIds: T_ARRAY,
    namespace: T_STRING,
    recallNamespaces: T_ARRAY,
    plannerMode: T_STRING,
    requestedMode: T_STRING,
    source: T_STRING,
    fallbackUsed: T_BOOLEAN,
    sourcesUsed: T_ARRAY,
    latencyMs: T_NUMBER,
    includedMemories: T_ARRAY,
    message: T_NULLABLE_STRING,
  }),
  memory_intent_debug: objectSchema({
    recordedAt: T_STRING,
    promptHash: T_STRING,
    promptLength: T_NUMBER,
    retrievalQueryHash: T_STRING,
    retrievalQueryLength: T_NUMBER,
    plannerEnabled: T_BOOLEAN,
    plannedMode: T_STRING,
    effectiveMode: T_STRING,
    recallResultLimit: T_NUMBER,
    queryIntent: T_OBJECT,
    graphExpandedIntentDetected: T_BOOLEAN,
    graphDecision: T_OBJECT,
    message: T_NULLABLE_STRING,
  }),
  memory_qmd_debug: objectSchema({
    recordedAt: T_STRING,
    queryHash: T_STRING,
    queryLength: T_NUMBER,
    collection: T_STRING,
    namespaces: T_ARRAY,
    fetchLimit: T_NUMBER,
    primaryResultCount: T_NUMBER,
    hybridResultCount: T_NUMBER,
    queryAwareSeedCount: T_NUMBER,
    resultCount: T_NUMBER,
    intentHint: T_STRING,
    explainEnabled: T_BOOLEAN,
    hybridTopUpUsed: T_BOOLEAN,
    hybridTopUpSkippedReason: T_STRING,
    results: T_ARRAY,
    message: T_NULLABLE_STRING,
  }),
  memory_graph_explain: objectSchema({ explanation: T_STRING }),
  graph_snapshot: objectSchema({ nodes: T_ARRAY, edges: T_ARRAY }),
  memory_feedback: objectSchema({ recorded: T_BOOLEAN, enabled: T_BOOLEAN }),
  memory_promote: objectSchema({ promoted: T_BOOLEAN, memoryId: T_STRING }),
  memory_outcome: objectSchema({
    ok: T_BOOLEAN,
    memoryId: T_STRING,
    mw_success: T_NUMBER,
    mw_fail: T_NUMBER,
    reason: T_STRING,
    message: T_STRING,
  }),
  memory_action_apply: objectSchema({ recorded: T_BOOLEAN, event: T_OBJECT }),
  context_checkpoint: objectSchema({ saved: T_BOOLEAN }),
  briefing: objectSchema({
    markdown: T_STRING,
    json: T_OBJECT,
    window: T_OBJECT,
    format: T_STRING,
    namespace: T_STRING,
  }),
  review_list: objectSchema({ pairs: T_ARRAY, total: T_NUMBER, durationMs: T_NUMBER }),
  review_resolve: objectSchema({ pairId: T_STRING, verb: T_STRING, affectedIds: T_ARRAY, message: T_STRING }),
  contradiction_scan_run: objectSchema({
    scanned: T_NUMBER,
    candidates: T_NUMBER,
    judged: T_NUMBER,
    queued: T_NUMBER,
    cooledDown: T_NUMBER,
    elapsedMs: T_NUMBER,
  }),
  preference_drift_scan: objectSchema({
    schemaVersion: T_NUMBER,
    generatedAt: T_STRING,
    mode: T_STRING,
    namespace: T_STRING,
    scanned: T_NUMBER,
    eligible: T_NUMBER,
    findings: T_ARRAY,
    counts: T_OBJECT,
    appliedCount: T_NUMBER,
    reviewItemsOpened: T_NUMBER,
    elapsedMs: T_NUMBER,
    skippedReason: T_STRING,
  }),
  memory_summarize_hourly: objectSchema({
    ok: T_BOOLEAN,
    message: T_STRING,
    sessionsConsidered: T_NUMBER,
    sessionsWithEntries: T_NUMBER,
    summariesWritten: T_NUMBER,
    staleStore: T_BOOLEAN,
    newestEntryTimestamp: T_NULLABLE_STRING,
    scanFailed: T_BOOLEAN,
    warning: T_STRING,
  }),
  conversation_index_update: objectSchema({
    enabled: T_BOOLEAN,
    sessions: T_NUMBER,
    chunks: T_NUMBER,
    skipped: T_NUMBER,
    embeddedRuns: T_NUMBER,
  }),
  profiling_report: objectSchema({
    enabled: T_BOOLEAN,
    format: T_STRING,
    traces: T_ARRAY,
    stats: T_OBJECT,
    bottleneck: T_NULLABLE_STRING,
  }),
  graph_edge_decay_run: objectSchema({ ranAt: T_STRING, disabled: T_BOOLEAN, reason: T_STRING, results: T_ARRAY }),
  live_connectors_run: objectSchema({
    ranAt: T_STRING,
    force: T_BOOLEAN,
    totalDocsImported: T_NUMBER,
    ranCount: T_NUMBER,
    skippedCount: T_NUMBER,
    errorCount: T_NUMBER,
    results: T_ARRAY,
  }),
  peer_list: objectSchema({ peers: T_ARRAY }),
  peer_get: objectSchema({ found: T_BOOLEAN, peer: T_NULLABLE_OBJECT }),
  peer_set: objectSchema({ ok: T_BOOLEAN, created: T_BOOLEAN, peer: T_OBJECT }),
  peer_delete: objectSchema({ ok: T_BOOLEAN, deleted: T_BOOLEAN }),
  peer_profile_get: objectSchema({
    found: T_BOOLEAN,
    profile: {
      type: "object",
      properties: {
        peerId: T_STRING,
        updatedAt: T_STRING,
        fields: { type: "object", additionalProperties: T_STRING },
        provenance: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                observedAt: T_STRING,
                signal: T_STRING,
                sourceSessionId: T_STRING,
                note: T_STRING,
              },
              required: ["observedAt", "signal"],
              additionalProperties: true,
            },
          },
        },
      },
      required: ["peerId", "updatedAt", "fields", "provenance"],
      additionalProperties: true,
    },
  }),
  peer_forget: objectSchema({ ok: T_BOOLEAN, purged: T_BOOLEAN }),
  console_state: objectSchema({
    capturedAt: T_STRING,
    bufferState: T_OBJECT,
    extractionQueue: T_OBJECT,
    dedupRecent: T_ARRAY,
    maintenanceLedgerTail: T_ARRAY,
    qmdProbe: T_OBJECT,
    daemon: T_OBJECT,
    errors: T_ARRAY,
  }),
  dreams_status: objectSchema({ phases: T_OBJECT, windowStart: T_STRING, windowEnd: T_STRING }),
  dreams_run: objectSchema({ phase: T_STRING, durationMs: T_NUMBER, itemsProcessed: T_NUMBER }),
  coding_decision: objectSchema({
    subcommand: T_STRING,
    records: T_ARRAY,
    count: T_NUMBER,
    found: T_BOOLEAN,
    memoryId: T_STRING,
    status: T_STRING,
    supersededMemoryId: T_STRING,
    replacementMemoryId: T_STRING,
  }),
  coding_architecture: objectSchema({
    subcommand: T_STRING,
    found: T_BOOLEAN,
    refreshed: T_BOOLEAN,
    memoryId: T_STRING,
  }),
  coding_delta: objectSchema({
    subcommand: T_STRING,
    ok: T_BOOLEAN,
    kind: T_STRING,
    delta: T_OBJECT,
    nextState: T_OBJECT,
  }),
  memory_correct_plan: objectSchema({
    planId: T_STRING,
    namespace: T_STRING,
    diff: T_STRING,
    actions: T_ARRAY,
    confidence: T_NUMBER,
  }),
  memory_correct_apply: objectSchema({
    planId: T_STRING,
    status: T_STRING,
    results: T_ARRAY,
    auditMemoryId: T_STRING,
    appliedAt: T_STRING,
  }),
  memory_chat: objectSchema({
    reply: T_STRING,
    chatSessionId: T_STRING,
    pendingPlan: {
      type: "object",
      properties: { planId: T_STRING, preview: T_STRING },
      required: ["planId", "preview"],
      additionalProperties: true,
    },
    skippedTools: { type: "array", items: T_STRING },
  }),
  codegraph_index: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_list_projects: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_delete_project: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_index_status: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_search_graph: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_trace_path: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_detect_changes: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_query_graph: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_get_schema: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_get_snippet: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_get_architecture: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_search_code: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_manage_adr: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
  codegraph_ingest_traces: objectSchema({ ok: T_BOOLEAN, result: T_OBJECT }),
};

/**
 * Apply outputSchema from the registry to every tool that lacks one.
 * Suffix resolution strips the canonical or legacy prefix so both
 * `remnic_*` and `engram.*` aliases inherit the same schema.
 * Tools that already have an explicit outputSchema are skipped.
 */
export function applyToolOutputSchemas<T extends { name: string; outputSchema?: unknown }>(
  tools: ReadonlyArray<T>,
  canonicalPrefix: string,
  legacyPrefix: string
): T[] {
  return tools.map((tool) => {
    if (tool.outputSchema) return tool;
    const name = tool.name as string;
    const suffix = name.startsWith(canonicalPrefix)
      ? name.slice(canonicalPrefix.length)
      : name.startsWith(legacyPrefix)
        ? name.slice(legacyPrefix.length)
        : name;
    return { ...tool, outputSchema: TOOL_OUTPUT_SCHEMAS[suffix] ?? { type: "object", additionalProperties: true } };
  });
}
