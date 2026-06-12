import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

function createFakeService(): EngramAccessService {
  return {
    recall: async ({ query }) => ({
      query,
      namespace: "global",
      context: "ctx",
      count: 1,
      memoryIds: ["fact-1"],
      results: [],
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd", "memories"],
    }),
    recallExplain: async () => ({
      found: true,
      snapshot: {
        sessionKey: "sess-1",
        recordedAt: "2026-03-08T00:00:00.000Z",
        queryHash: "hash",
        queryLen: 4,
        memoryIds: ["fact-1"],
      },
      intent: null,
      graph: null,
    }),
    recallXray: async ({ query }) => ({
      snapshotFound: true,
      snapshot: {
        schemaVersion: "1" as const,
        query,
        snapshotId: "snap-1",
        capturedAt: 1_700_000_000_000,
        tierExplain: null,
        results: [],
        filters: [],
        budget: { chars: 4096, used: 0 },
      },
    }),
    memoryGet: async (memoryId) => ({
      found: true,
      namespace: "global",
      memory: {
        id: memoryId,
        path: "/tmp/fact-1.md",
        category: "fact",
        content: "hello",
        frontmatter: {
          id: memoryId,
          category: "fact",
          created: "2026-03-08T00:00:00.000Z",
          updated: "2026-03-08T00:00:00.000Z",
          source: "test",
          confidence: 0.9,
          confidenceTier: "implied",
          tags: [],
        },
      },
    }),
    memoryTimeline: async (memoryId) => ({
      found: true,
      namespace: "global",
      count: 1,
      timeline: [{
        eventId: "evt-1",
        memoryId,
        eventType: "created",
        timestamp: "2026-03-08T00:00:00.000Z",
        eventOrder: 1,
        actor: "engram",
        ruleVersion: "1",
      }],
    }),
    memoryStore: async ({ dryRun }) => ({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: false,
      status: dryRun === true ? "validated" : "stored",
      memoryId: "fact-new",
    }),
    memoryActionApply: async (request) => ({
      recorded: true,
      event: {
        action: request.action,
        outcome: request.outcome ?? "skipped",
        inputSummary: [
          request.category ? `category=${request.category}` : undefined,
          typeof request.execute === "boolean" ? `execute=${request.execute}` : undefined,
        ].filter(Boolean).join(" | "),
      },
    }),
    suggestionSubmit: async ({ dryRun }) => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: true,
      status: dryRun === true ? "validated" : "queued_for_review",
      memoryId: "fact-review",
    }),
    entityGet: async (name) => ({
      found: true,
      namespace: "global",
      entity: {
        name,
        type: "person",
        updated: "2026-03-08T00:00:00.000Z",
        summary: "Owns ops",
        facts: ["Maintains Engram"],
        relationships: [],
        activity: [],
        aliases: ["Alex Ops"],
      },
    }),
    governanceRun: async ({ mode }) => ({
      namespace: "global",
      runId: "gov-1",
      traceId: "trace-1",
      mode: mode === "apply" ? "apply" : "shadow",
      reviewQueueCount: 1,
      proposedActionCount: 1,
      appliedActionCount: 0,
      summaryPath: "/tmp/summary.json",
      reportPath: "/tmp/report.md",
    }),
    liveConnectorsRun: async ({ force }) => ({
      ranAt: "2026-04-28T00:00:00.000Z",
      force: force === true,
      totalDocsImported: 2,
      ranCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [{
        id: "google-drive",
        displayName: "Google Drive",
        enabled: true,
        ran: true,
        docsImported: 2,
        lastSyncAt: "2026-04-28T00:00:00.000Z",
        nextDueAt: "2026-04-28T00:05:00.000Z",
      }],
    }),
    reviewQueue: async () => ({
      found: true,
      runId: "gov-1",
      reviewQueue: [{ memoryId: "fact-1", reasonCode: "disputed_memory" }],
    }),
    capsuleExport: async ({ name, namespace, includeKinds, peerIds, includeTranscripts, encrypt }) => ({
      archivePath: `/tmp/remnic/.capsules/${name}.capsule.json.gz${encrypt === true ? ".enc" : ""}`,
      manifestPath: `/tmp/remnic/.capsules/${name}.manifest.json`,
      encryptedArchivePath: encrypt === true ? `/tmp/remnic/.capsules/${name}.capsule.json.gz.enc` : null,
      manifest: {
        format: "openclaw-engram-export",
        schemaVersion: 2,
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "test",
        includesTranscripts: includeTranscripts === true,
        files: [{ path: "facts/2026-04-28/fact-a.md", sha256: "abc123", bytes: 42 }],
        capsule: {
          id: name,
          version: "1.0.0",
          schemaVersion: "test",
          parentCapsule: null,
          parent: null,
          description: `namespace=${namespace ?? "default"} kinds=${(includeKinds ?? []).join(",")} peers=${(peerIds ?? []).join(",")}`,
          retrievalPolicy: { directAnswerEnabled: false, tierWeights: {} },
          includes: {
            taxonomy: false,
            identityAnchors: false,
            peerProfiles: false,
            procedural: false,
          },
        },
      },
    }),
    capsuleImport: async ({ archivePath, mode }) => ({
      imported: [{
        sourcePath: "facts/2026-04-28/fact-a.md",
        targetPath: "facts/2026-04-28/fact-a.md",
        snapshotted: mode === "overwrite",
        rewroteId: false,
      }],
      skipped: [],
      manifest: {
        format: "openclaw-engram-export",
        schemaVersion: 2,
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "test",
        includesTranscripts: false,
        files: [{ path: "facts/2026-04-28/fact-a.md", sha256: "abc123", bytes: 42 }],
        capsule: {
          id: String(archivePath).split("/").pop()?.replace(/\.capsule\.json\.gz(?:\.enc)?$/, "") ?? "imported",
          version: "1.0.0",
          schemaVersion: "test",
          parentCapsule: null,
          parent: null,
          description: "MCP import test capsule",
          retrievalPolicy: { directAnswerEnabled: false, tierWeights: {} },
          includes: {
            taxonomy: false,
            identityAnchors: false,
            peerProfiles: false,
            procedural: false,
          },
        },
      },
    }),
    capsuleList: async () => ({
      namespace: "global",
      capsulesDir: "/tmp/remnic/.capsules",
      capsules: [{
        id: "daily-ops",
        archivePath: "/tmp/remnic/.capsules/daily-ops.capsule.json.gz",
        manifestPath: "/tmp/remnic/.capsules/daily-ops.manifest.json",
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "test",
        fileCount: 1,
        description: "Daily ops capsule",
      }],
    }),
    briefingEnabled: true,
    peerList: async () => ({
      peers: [
        {
          id: "alice",
          kind: "human",
          displayName: "Alice",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    }),
    peerGet: async (id: string) => ({
      found: true,
      peer: {
        id,
        kind: "human",
        displayName: "Alice",
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    }),
    peerSet: async ({ id }: { id: string }) => ({
      ok: true,
      created: true,
      peer: {
        id,
        kind: "human",
        displayName: id,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    }),
    peerDelete: async () => ({ ok: true, deleted: true }),
    peerProfileGet: async () => ({ found: false }),
    consoleState: async () => ({
      capturedAt: "2026-04-27T00:00:00.000Z",
      bufferState: { turnsCount: 0, byteCount: 0 },
      extractionQueue: { depth: 0, recentVerdicts: [] },
      dedupRecent: [],
      maintenanceLedgerTail: [],
      qmdProbe: { available: false, daemonMode: false, debug: "" },
      daemon: { uptimeMs: 0, version: "test" },
      errors: [],
    }),
  } as unknown as EngramAccessService;
}

function parseMcpBodies(raw: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let remaining = raw;
  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    assert.notEqual(headerEnd, -1, "expected MCP header terminator");
    const header = remaining.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    assert.ok(match, "expected Content-Length header");
    const contentLength = Number.parseInt(match[1] ?? "0", 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)) as Record<string, unknown>);
    remaining = remaining.slice(bodyEnd);
  }
  return messages;
}

function toolCallErrorMessage(resp: unknown): string {
  const r = resp as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  if (!r?.result?.isError) return "";
  return r.result.content?.[0]?.text ?? "";
}

test("MCP server advertises tools and dispatches recall", async () => {
  const server = new EngramMcpServer(createFakeService());

  const init = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(init?.jsonrpc, "2.0");
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2024-11-05");

  const tools = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
  const legacyListed = [
    "engram.recall",
    "engram.recall_explain",
    "engram.set_coding_context",
    "engram.recall_tier_explain",
    "engram.recall_xray",
    "engram.wearables_status",
    "engram.wearables_sync",
    "engram.transcript_day",
    "engram.transcript_search",
    "engram.transcript_memories",
    "engram.action_confidence",
    "engram.chatgpt_memory_inspector",
    "engram.day_summary",
    "engram.capsule_export",
    "engram.capsule_import",
    "engram.capsule_list",
    "engram.memory_governance_run",
    "engram.procedure_mining_run",
    "engram.pattern_reinforcement_run",
    "engram.procedural_stats",
    "engram.memory_get",
    "engram.memory_timeline",
    "engram.memory_store",
    "engram.suggestion_submit",
    "engram.entity_get",
    "engram.review_queue_list",
    "engram.observe",
    "engram.lcm_search",
    "engram.lcm_compaction_flush",
    "engram.lcm_compaction_record",
    "engram.continuity_audit_generate",
    "engram.continuity_incident_open",
    "engram.continuity_incident_close",
    "engram.continuity_incident_list",
    "engram.continuity_loop_add_or_update",
    "engram.continuity_loop_review",
    "engram.identity_anchor_get",
    "engram.identity_anchor_update",
    "engram.memory_identity",
    "engram.work_task",
    "engram.work_project",
    "engram.work_board",
    "engram.shared_context_write_output",
    "engram.shared_feedback_record",
    "engram.shared_priorities_append",
    "engram.shared_context_cross_signals_run",
    "engram.shared_context_curate_daily",
    "engram.compounding_weekly_synthesize",
    "engram.compounding_promote_candidate",
    "engram.compression_guidelines_optimize",
    "engram.compression_guidelines_activate",
    "engram.memory_search",
    "engram.memory_profile",
    "engram.memory_entities_list",
    "engram.memory_questions",
    "engram.memory_last_recall",
    "engram.memory_intent_debug",
    "engram.memory_qmd_debug",
    "engram.memory_graph_explain",
    "engram.graph_snapshot",
    "engram.memory_feedback",
    "engram.memory_promote",
    "engram.memory_outcome",
    "engram.memory_action_apply",
    "engram.context_checkpoint",
    "engram.briefing",
    "engram.review_list",
    "engram.review_resolve",
    "engram.contradiction_scan_run",
    "engram.memory_summarize_hourly",
    "engram.conversation_index_update",
    "engram.profiling_report",
    "engram.graph_edge_decay_run",
    "engram.live_connectors_run",
    "engram.peer_list",
    "engram.peer_get",
    "engram.peer_set",
    "engram.peer_delete",
    "engram.peer_profile_get",
    "engram.peer_forget",
    "engram.console_state",
    "engram.dreams_status",
    "engram.dreams_run",
  ];
  const canonicalListed = legacyListed.map((name) => name.replace(/^engram\./, "remnic."));
  assert.deepEqual(listed, legacyListed.flatMap((name, index) => [canonicalListed[index], name]));

  const recall = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "engram.recall",
      arguments: { query: "hello" },
    },
  });
  const recallResult = recall?.result as { structuredContent: { context: string; memoryIds: string[] } };
  assert.equal(recallResult.structuredContent.context, "ctx");
  assert.deepEqual(recallResult.structuredContent.memoryIds, ["fact-1"]);

  const store = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "engram.memory_store",
      arguments: { schemaVersion: 1, content: "A durable access-layer memory." },
    },
  });
  const storeResult = store?.result as { structuredContent: { status: string } };
  assert.equal(storeResult.structuredContent.status, "stored");

  const memoryAction = await server.handleRequest({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: {
      name: "engram.memory_action_apply",
      arguments: {
        action: "store_note",
        content: "Keep the category.",
        category: "fact",
        execute: true,
      },
    },
  });
  const memoryActionResult = memoryAction?.result as {
    structuredContent: { event: { outcome: string; inputSummary: string } };
  };
  assert.equal(memoryActionResult.structuredContent.event.outcome, "skipped");
  assert.match(memoryActionResult.structuredContent.event.inputSummary, /category=fact/);
  assert.match(memoryActionResult.structuredContent.event.inputSummary, /execute=true/);

  const governance = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "engram.memory_governance_run",
      arguments: { recentDays: 2, maxMemories: 100, batchSize: 25 },
    },
  });
  const governanceResult = governance?.result as { structuredContent: { runId: string; mode: string } };
  assert.equal(governanceResult.structuredContent.runId, "gov-1");
  assert.equal(governanceResult.structuredContent.mode, "shadow");

  const capsuleExport = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "remnic.capsule_export",
      arguments: {
        name: "daily-ops",
        namespace: "global",
        includeKinds: ["facts"],
        peerIds: ["alice"],
        includeTranscripts: true,
      },
    },
  });
  const capsuleExportResult = capsuleExport?.result as {
    structuredContent: { archivePath: string; manifest: { capsule: { id: string; description: string } } };
  };
  assert.equal(capsuleExportResult.structuredContent.archivePath, "/tmp/remnic/.capsules/daily-ops.capsule.json.gz");
  assert.equal(capsuleExportResult.structuredContent.manifest.capsule.id, "daily-ops");
  assert.match(capsuleExportResult.structuredContent.manifest.capsule.description, /kinds=facts/);
  assert.match(capsuleExportResult.structuredContent.manifest.capsule.description, /peers=alice/);

  const capsuleImport = await server.handleRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "engram.capsule_import",
      arguments: {
        archivePath: "/tmp/remnic/.capsules/daily-ops.capsule.json.gz",
        mode: "overwrite",
      },
    },
  });
  const capsuleImportResult = capsuleImport?.result as {
    structuredContent: { imported: Array<{ targetPath: string; snapshotted: boolean }> };
  };
  assert.equal(capsuleImportResult.structuredContent.imported[0]?.targetPath, "facts/2026-04-28/fact-a.md");
  assert.equal(capsuleImportResult.structuredContent.imported[0]?.snapshotted, true);

  const capsuleList = await server.handleRequest({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "remnic.capsule_list",
      arguments: {},
    },
  });
  const capsuleListResult = capsuleList?.result as {
    structuredContent: { capsules: Array<{ id: string; fileCount: number | null }> };
  };
  assert.equal(capsuleListResult.structuredContent.capsules[0]?.id, "daily-ops");
  assert.equal(capsuleListResult.structuredContent.capsules[0]?.fileCount, 1);

  const liveConnectors = await server.handleRequest({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "engram.live_connectors_run",
      arguments: { force: true },
    },
  });
  const liveConnectorsResult = liveConnectors?.result as {
    structuredContent: { force: boolean; totalDocsImported: number };
  };
  assert.equal(liveConnectorsResult.structuredContent.force, true);
  assert.equal(liveConnectorsResult.structuredContent.totalDocsImported, 2);

  const entity = await server.handleRequest({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "engram.entity_get",
      arguments: { name: "person-alex" },
    },
  });
  const entityResult = entity?.result as { structuredContent: { entity: { name: string } } };
  assert.equal(entityResult.structuredContent.entity.name, "person-alex");
});

test("MCP capsule tools reject invalid arguments before calling service", async () => {
  let exportCalls = 0;
  let importCalls = 0;
  let listCalls = 0;
  const service = {
    ...createFakeService(),
    capsuleExport: async () => {
      exportCalls += 1;
      return {};
    },
    capsuleImport: async () => {
      importCalls += 1;
      return {};
    },
    capsuleList: async () => {
      listCalls += 1;
      return {};
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const badExport = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.capsule_export",
      arguments: { name: "../bad" },
    },
  });
  assert.match(toolCallErrorMessage(badExport), /name: name must be alphanumeric/);
  assert.equal(exportCalls, 0);

  const badImport = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "remnic.capsule_import",
      arguments: { archivePath: "/tmp/bad.capsule.json.gz", mode: "merge" },
    },
  });
  assert.match(toolCallErrorMessage(badImport), /mode: Invalid enum value/);
  assert.equal(importCalls, 0);

  const badList = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "engram.capsule_list",
      arguments: { namespace: 42 },
    },
  });
  assert.match(toolCallErrorMessage(badList), /namespace: Expected string/);
  assert.equal(listCalls, 0);

  const typoList = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "engram.capsule_list",
      arguments: { namespce: "global" },
    },
  });
  assert.match(toolCallErrorMessage(typoList), /Unrecognized key/);
  assert.equal(listCalls, 0);

  const stringArguments = await server.handleRequest({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "engram.capsule_list",
      arguments: "oops",
    },
  });
  assert.match(toolCallErrorMessage(stringArguments), /arguments must be an object/);
  assert.equal(listCalls, 0);

  const nullArguments = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "engram.capsule_list",
      arguments: null,
    },
  });
  assert.match(toolCallErrorMessage(nullArguments), /arguments must be an object/);
  assert.equal(listCalls, 0);
});

test("engram.dreams_status rejects invalid windowHours without calling service", async () => {
  let capturedWindowHours: number | undefined;
  let calls = 0;
  const service = {
    ...createFakeService(),
    dreamsStatus: async ({ windowHours }: { windowHours: number }) => {
      calls += 1;
      capturedWindowHours = windowHours;
      return {
        windowStart: "2026-04-01T00:00:00.000Z",
        windowEnd: "2026-04-02T00:00:00.000Z",
        phases: {
          lightSleep: { phase: "lightSleep", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
          rem: { phase: "rem", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
          deepSleep: { phase: "deepSleep", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
        },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const invalid = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.dreams_status", arguments: { windowHours: 0 } },
  });
  assert.match(toolCallErrorMessage(invalid), /windowHours must be a positive integer/);
  assert.equal(calls, 0);

  const fractional = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "engram.dreams_status", arguments: { windowHours: 1.5 } },
  });
  assert.match(toolCallErrorMessage(fractional), /windowHours must be a positive integer/);
  assert.equal(calls, 0);

  const valid = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "engram.dreams_status", arguments: { windowHours: 3 } },
  });
  const result = valid?.result as { structuredContent?: { windowEnd?: string } };
  assert.equal(result.structuredContent?.windowEnd, "2026-04-02T00:00:00.000Z");
  assert.equal(capturedWindowHours, 3);
  assert.equal(calls, 1);
});

test("engram.dreams_status rejects non-string namespace without calling service", async () => {
  let calls = 0;
  const service = {
    ...createFakeService(),
    dreamsStatus: async () => {
      calls += 1;
      return {
        windowStart: "2026-04-01T00:00:00.000Z",
        windowEnd: "2026-04-02T00:00:00.000Z",
        phases: {
          lightSleep: { phase: "lightSleep", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
          rem: { phase: "rem", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
          deepSleep: { phase: "deepSleep", runCount: 0, totalDurationMs: 0, totalItemsProcessed: 0, lastRunAt: null, lastDurationMs: null },
        },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const invalid = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.dreams_status",
      arguments: { windowHours: 24, namespace: 123 },
    },
  });

  assert.match(toolCallErrorMessage(invalid), /namespace must be a string/);
  assert.equal(calls, 0);
});

test("engram.dreams_run rejects non-boolean dryRun without calling service", async () => {
  let calls = 0;
  const service = {
    ...createFakeService(),
    dreamsRun: async () => {
      calls += 1;
      return {
        phase: "deepSleep",
        dryRun: false,
        durationMs: 0,
        itemsProcessed: 0,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const invalid = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.dreams_run",
      arguments: { phase: "deepSleep", dryRun: "true" },
    },
  });

  assert.match(toolCallErrorMessage(invalid), /dryRun must be a boolean/);
  assert.equal(calls, 0);
});

test("engram.dreams_run rejects non-string namespace without calling service", async () => {
  let calls = 0;
  const service = {
    ...createFakeService(),
    dreamsRun: async () => {
      calls += 1;
      return {
        phase: "deepSleep",
        dryRun: false,
        durationMs: 0,
        itemsProcessed: 0,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const invalid = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.dreams_run",
      arguments: { phase: "deepSleep", namespace: 123 },
    },
  });

  assert.match(toolCallErrorMessage(invalid), /namespace must be a string/);
  assert.equal(calls, 0);
});

test("engram.peer_set rejects non-string kind/displayName/notes (Codex P2 PR #756 round 2)", async () => {
  // Surface-symmetry test: HTTP rejects non-string field types with
  // 400; MCP must reject the same payloads with a tools/call error
  // rather than silently coercing to `undefined` and letting
  // peerSet fall back to its "human" default.
  let lastSetArgs: unknown = null;
  const baseFake = createFakeService();
  const fakeService = {
    ...baseFake,
    peerSet: async (input: { id: string; kind?: string; displayName?: string; notes?: string }) => {
      lastSetArgs = input;
      return {
        ok: true as const,
        created: true,
        peer: {
          id: input.id,
          kind: "human" as const,
          displayName: input.displayName ?? input.id,
          createdAt: "t",
          updatedAt: "t",
        },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(fakeService);

  // Non-string kind → error.
  const r1 = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.peer_set", arguments: { id: "bob", kind: 123 } },
  });
  assert.match(toolCallErrorMessage(r1), /kind must be a string/);

  // Non-string displayName → error.
  const r2 = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "engram.peer_set", arguments: { id: "bob", displayName: 42 } },
  });
  assert.match(toolCallErrorMessage(r2), /displayName must be a string/);

  // Non-string notes → error.
  const r3 = await server.handleRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "engram.peer_set", arguments: { id: "bob", notes: { x: 1 } } },
  });
  assert.match(toolCallErrorMessage(r3), /notes must be a string/);

  // Service.peerSet must NOT have been invoked for any of the rejected payloads.
  assert.equal(lastSetArgs, null);

  // A valid payload still works.
  const ok = await server.handleRequest({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "engram.peer_set", arguments: { id: "bob", kind: "human", displayName: "Bob" } },
  });
  const okResult = ok as { result?: { isError?: boolean } };
  assert.equal(okResult?.result?.isError, false, "expected valid payload to succeed");
  assert.deepEqual(lastSetArgs, { id: "bob", kind: "human", displayName: "Bob", notes: undefined });
});

test("engram.console_state and remnic.console_state return a ConsoleStateSnapshot", async () => {
  const server = new EngramMcpServer(createFakeService());
  await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  for (const toolName of ["engram.console_state", "remnic.console_state"]) {
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: {} },
    });
    const result = (resp as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }).result;
    assert.equal(result?.isError, false, `${toolName} should not return isError=true`);
    const text = result?.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as {
      capturedAt: string;
      bufferState: { turnsCount: number };
      errors: string[];
    };
    assert.ok(typeof parsed.capturedAt === "string", `${toolName}: capturedAt must be a string`);
    assert.deepEqual(parsed.errors, [], `${toolName}: errors must be empty`);
    assert.equal(parsed.bufferState.turnsCount, 0, `${toolName}: turnsCount must be 0`);
  }
});

test("MCP initialize re-reads the server version for each server instance", async () => {
  const originalVersion = process.env.OPENCLAW_ENGRAM_VERSION;
  try {
    process.env.OPENCLAW_ENGRAM_VERSION = "9.9.1";
    const firstServer = new EngramMcpServer(createFakeService());
    const firstInit = await firstServer.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    assert.equal((firstInit?.result as { serverInfo: { version: string } }).serverInfo.version, "9.9.1");

    process.env.OPENCLAW_ENGRAM_VERSION = "9.9.2";
    const secondServer = new EngramMcpServer(createFakeService());
    const secondInit = await secondServer.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {},
    });
    assert.equal((secondInit?.result as { serverInfo: { version: string } }).serverInfo.version, "9.9.2");
  } finally {
    if (originalVersion === undefined) {
      delete process.env.OPENCLAW_ENGRAM_VERSION;
    } else {
      process.env.OPENCLAW_ENGRAM_VERSION = originalVersion;
    }
  }
});

test("MCP server binds write authorization to its configured principal", async () => {
  let capturedPrincipal: string | undefined;
  let capturedSessionKey: string | undefined;
  const server = new EngramMcpServer({
    ...createFakeService(),
    memoryStore: async ({
      authenticatedPrincipal,
      sessionKey,
    }: {
      authenticatedPrincipal?: string;
      sessionKey?: string;
    }) => {
      capturedPrincipal = authenticatedPrincipal;
      capturedSessionKey = sessionKey;
      return {
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "secret-team",
        dryRun: true,
        accepted: true,
        queued: false,
        status: "validated",
      };
    },
  } as unknown as EngramAccessService, {
    principal: "secret-team",
  });

  const store = await server.handleRequest({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "engram.memory_store",
      arguments: {
        schemaVersion: 1,
        dryRun: true,
        sessionKey: "agent:project-x:chat",
        namespace: "secret-team",
        content: "Configured MCP principal should be authoritative.",
      },
    },
  });

  const storeResult = store?.result as { structuredContent: { status: string } };
  assert.equal(storeResult.structuredContent.status, "validated");
  assert.equal(capturedPrincipal, "secret-team");
  assert.equal(capturedSessionKey, "agent:project-x:chat");
});

test("MCP server reports parse errors and keeps processing later messages", async () => {
  const server = new EngramMcpServer(createFakeService());
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf-8");
  });

  const run = server.runStdio(input, output);
  input.write("Content-Length: 9\r\n\r\nnot-json!");
  const valid = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  input.write(`Content-Length: ${Buffer.byteLength(valid, "utf-8")}\r\n\r\n${valid}`);
  input.end();
  await run;

  assert.match(raw, /"code":-32700/);
  assert.match(raw, /engram\.recall/);
});

test("MCP server drains buffered requests in arrival order across overlapping data events", async () => {
  const seen: string[] = [];
  const service = {
    recall: async ({ query }: { query: string }) => {
      seen.push(query);
      if (query === "first") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        query,
        context: query,
        count: 1,
        memoryIds: [query],
      };
    },
  } as EngramAccessService;
  const server = new EngramMcpServer(service);
  const input = new PassThrough();
  const output = new PassThrough();
  let raw = "";
  output.on("data", (chunk) => {
    raw += chunk.toString("utf-8");
  });

  const run = server.runStdio(input, output);
  const first = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.recall", arguments: { query: "first" } },
  });
  const second = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "engram.recall", arguments: { query: "second" } },
  });
  input.write(`Content-Length: ${Buffer.byteLength(first, "utf-8")}\r\n\r\n${first}`);
  input.write(`Content-Length: ${Buffer.byteLength(second, "utf-8")}\r\n\r\n${second}`);
  input.end();
  await run;

  assert.deepEqual(seen, ["first", "second"]);
  const responseBodies = parseMcpBodies(raw) as Array<{
    id?: number;
    result?: { structuredContent?: { query?: string } };
  }>;
  assert.deepEqual(
    responseBodies.map((body) => body.result?.structuredContent?.query),
    ["first", "second"],
  );
});

test("MCP session override preserves explicit LCM sessionPrefix searches", async () => {
  const service = {
    ...createFakeService(),
    lcmSearch: async (request: { sessionKey?: string; sessionPrefix?: string }) => ({
      request,
      results: [],
    }),
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const prefixSearch = await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "engram.lcm_search",
        arguments: { query: "handoff", sessionPrefix: "run-" },
      },
    },
    { sessionKeyOverride: "adapter-session" },
  );
  const prefixResult = prefixSearch?.result as {
    structuredContent: { request: { sessionKey?: string; sessionPrefix?: string } };
  };
  assert.equal(prefixResult.structuredContent.request.sessionKey, undefined);
  assert.equal(prefixResult.structuredContent.request.sessionPrefix, "run-");

  const exactSearch = await server.handleRequest(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "engram.lcm_search",
        arguments: { query: "handoff" },
      },
    },
    { sessionKeyOverride: "adapter-session" },
  );
  const exactResult = exactSearch?.result as {
    structuredContent: { request: { sessionKey?: string; sessionPrefix?: string } };
  };
  assert.equal(exactResult.structuredContent.request.sessionKey, "adapter-session");
  assert.equal(exactResult.structuredContent.request.sessionPrefix, undefined);
});
