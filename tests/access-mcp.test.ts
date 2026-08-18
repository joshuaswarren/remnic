import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Ajv } from "ajv";
import { EngramMcpServer } from "../src/access-mcp.js";
import type { EngramAccessService } from "../src/access-service.js";

function createFakeService(): EngramAccessService {
  return {
    recall: async ({ query }: Parameters<EngramAccessService["recall"]>[0]) => ({
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
    recallXray: async ({ query }: Parameters<EngramAccessService["recallXray"]>[0]) => ({
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
    memoryGet: async (memoryId: Parameters<EngramAccessService["memoryGet"]>[0]) => ({
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
    memoryTimeline: async (memoryId: Parameters<EngramAccessService["memoryTimeline"]>[0]) => ({
      found: true,
      namespace: "global",
      count: 1,
      timeline: [
        {
          eventId: "evt-1",
          memoryId,
          eventType: "created",
          timestamp: "2026-03-08T00:00:00.000Z",
          eventOrder: 1,
          actor: "engram",
          ruleVersion: "1",
        },
      ],
    }),
    memoryStore: async ({ dryRun }: Parameters<EngramAccessService["memoryStore"]>[0]) => ({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: false,
      status: dryRun === true ? "validated" : "stored",
      memoryId: "fact-new",
    }),
    memoryActionApply: async (request: Parameters<EngramAccessService["memoryActionApply"]>[0]) => ({
      recorded: true,
      event: {
        action: request.action,
        outcome: request.outcome ?? "skipped",
        inputSummary: [
          request.category ? `category=${request.category}` : undefined,
          typeof request.execute === "boolean" ? `execute=${request.execute}` : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
      },
    }),
    suggestionSubmit: async ({ dryRun }: Parameters<EngramAccessService["suggestionSubmit"]>[0]) => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: true,
      status: dryRun === true ? "validated" : "queued_for_review",
      memoryId: "fact-review",
    }),
    entityGet: async (name: Parameters<EngramAccessService["entityGet"]>[0]) => ({
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
    governanceRun: async ({ mode }: Parameters<EngramAccessService["governanceRun"]>[0]) => ({
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
    liveConnectorsRun: async ({ force }: NonNullable<Parameters<EngramAccessService["liveConnectorsRun"]>[0]>) => ({
      ranAt: "2026-04-28T00:00:00.000Z",
      force: force === true,
      totalDocsImported: 2,
      ranCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          id: "google-drive",
          displayName: "Google Drive",
          enabled: true,
          ran: true,
          docsImported: 2,
          lastSyncAt: "2026-04-28T00:00:00.000Z",
          nextDueAt: "2026-04-28T00:05:00.000Z",
        },
      ],
    }),
    reviewQueue: async () => ({
      found: true,
      runId: "gov-1",
      reviewQueue: [{ memoryId: "fact-1", reasonCode: "disputed_memory" }],
    }),
    capsuleExport: async ({ name, namespace, includeKinds, peerIds, includeTranscripts, encrypt }: Parameters<EngramAccessService["capsuleExport"]>[0]) => ({
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
    capsuleImport: async ({ archivePath, mode }: Parameters<EngramAccessService["capsuleImport"]>[0]) => ({
      imported: [
        {
          sourcePath: "facts/2026-04-28/fact-a.md",
          targetPath: "facts/2026-04-28/fact-a.md",
          snapshotted: mode === "overwrite",
          rewroteId: false,
        },
      ],
      skipped: [],
      manifest: {
        format: "openclaw-engram-export",
        schemaVersion: 2,
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "test",
        includesTranscripts: false,
        files: [{ path: "facts/2026-04-28/fact-a.md", sha256: "abc123", bytes: 42 }],
        capsule: {
          id:
            String(archivePath)
              .split("/")
              .pop()
              ?.replace(/\.capsule\.json\.gz(?:\.enc)?$/, "") ?? "imported",
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
      capsules: [
        {
          id: "daily-ops",
          archivePath: "/tmp/remnic/.capsules/daily-ops.capsule.json.gz",
          manifestPath: "/tmp/remnic/.capsules/daily-ops.manifest.json",
          createdAt: "2026-04-28T00:00:00.000Z",
          pluginVersion: "test",
          fileCount: 1,
          description: "Daily ops capsule",
        },
      ],
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
    wearablesSync: async () => [
      {
        source: "limitless",
        days: ["2026-07-11"],
        conversations: 1,
        segmentsKept: 1,
        segmentsDropped: 0,
        redactions: 0,
        correctionsApplied: 0,
        transcriptsWritten: ["2026-07-11"],
        memoriesCreated: 1,
        memoriesPromoted: 0,
        memoriesDemoted: 0,
        memoriesSkipped: 0,
        memoriesBlocked: 0,
        nativeMemoriesImported: 0,
        warnings: [],
      },
    ],
    wearablesTranscriptDay: async (request: Parameters<EngramAccessService["wearablesTranscriptDay"]>[0]) => {
      assert.equal(request.date, "2026-07-11");
      return [
        {
          source: "limitless",
          date: "2026-07-11",
          meta: null,
          body: "A test transcript.",
          overlapsWith: [],
        },
      ];
    },
    wearablesTranscriptSearch: async (request: Parameters<EngramAccessService["wearablesTranscriptSearch"]>[0]) => {
      assert.equal(request.query, "meeting");
      return [
        { source: "limitless", date: "2026-07-11", score: 0.9, snippet: "test transcript", backend: "scan" as const },
      ];
    },
    wearablesTranscriptMemories: async () => [
      {
        id: "memory-1",
        source: "limitless",
        date: "2026-07-11",
        content: "A test memory.",
        created: "2026-07-11T12:00:00.000Z",
      },
    ],
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

test("MCP initialize negotiates the protocol version per spec", async () => {
  const server = new EngramMcpServer(createFakeService());

  // Every supported version is echoed back verbatim.
  for (const version of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
    const init = await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: version },
    });
    const result = init?.result;
    assert.ok(result && typeof result === "object" && "protocolVersion" in result);
    assert.equal(result.protocolVersion, version, `supported version ${version} must be echoed`);
  }

  // A well-formed but unsupported version gets the spec counter-offer:
  // the newest version the server supports.
  const future = await server.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { protocolVersion: "2099-01-01" },
  });
  const futureResult = future?.result;
  assert.ok(futureResult && typeof futureResult === "object" && "protocolVersion" in futureResult);
  assert.equal(futureResult.protocolVersion, "2025-06-18");

  // Missing / mistyped / empty protocolVersion is invalid params, not a
  // silent default (rule: reject invalid inputs explicitly).
  for (const params of [{}, { protocolVersion: 42 }, { protocolVersion: "" }]) {
    const bad = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: params as Record<string, unknown>,
    });
    const error = bad?.error;
    assert.ok(error && typeof error === "object" && "code" in error, "expected JSON-RPC error");
    assert.equal(error.code, -32602);
    assert.match(String((error as { message?: unknown }).message ?? ""), /protocolVersion/);
  }
});

test("MCP tools/list marks read-only tools with readOnlyHint and leaves write tools unmarked", async () => {
  const server = new EngramMcpServer(createFakeService());
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const listed = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const result = listed?.result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
  const byName = new Map(result.tools.map((tool) => [tool.name, tool]));

  // Pure reads carry the hint in both naming forms.
  for (const name of ["remnic.recall", "engram.recall", "remnic.memory_get", "engram.memory_search"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be listed`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} must carry readOnlyHint`);
  }

  // Mutating tools must NOT carry it — ChatGPT treats unannotated tools as
  // write actions requiring confirmation, which is the safe default.
  for (const name of ["remnic.memory_store", "engram.memory_store", "remnic.wearables_sync", "engram.observe"]) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be listed`);
    assert.notEqual(tool.annotations?.readOnlyHint, true, `${name} must not be marked read-only`);
  }
});

test("MCP server advertises tools and dispatches recall", async () => {
  const server = new EngramMcpServer(createFakeService());

  const init = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.equal(init?.jsonrpc, "2.0");
  // Requested version is supported → server echoes it back.
  assert.equal((init?.result as { protocolVersion: string }).protocolVersion, "2025-06-18");

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
    "engram.meetings_list",
    "engram.meetings_get",
    "engram.meetings_build",
    "engram.who_knows",
    "engram.action_confidence",
    "engram.chatgpt_memory_inspector",
    "engram.day_summary",
    "engram.capsule_export",
    "engram.capsule_import",
    "engram.capsule_list",
    "engram.memory_governance_run",
    "engram.entity_synthesis_run",
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
    "engram.extraction_force_flush",
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
    "engram.external_wiki_search",
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
    "engram.memory_correct_plan",
    "engram.memory_correct_apply",
  ];
  const canonicalListed = legacyListed.map((name) => name.replace(/^engram\./, "remnic."));
  assert.deepEqual(
    listed,
    legacyListed.flatMap((name, index) => [canonicalListed[index], name])
  );
  for (const tool of ["who_knows"]) {
    assert.ok(listed.includes(`engram.${tool}`), `engram.${tool} must be advertised`);
    assert.ok(listed.includes(`remnic.${tool}`), `remnic.${tool} must be advertised`);
  }

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

test("MCP day_summary tolerates injected git context keys", async () => {
  let request: unknown;
  const service = {
    ...createFakeService(),
    daySummary: async (body: unknown) => {
      request = body;
      return {
        summary: "done",
        bullets: [],
        next_actions: [],
        risks_or_open_loops: [],
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.day_summary",
      arguments: {
        namespace: "global",
        timeZone: "America/Chicago",
        cwd: "/tmp/project",
        projectTag: "acme-webshop",
      },
    },
  });

  const result = response?.result as { isError?: boolean };
  assert.equal(result?.isError, false);
  assert.deepEqual(request, {
    namespace: "global",
    timeZone: "America/Chicago",
  });
});

test("MCP day_summary returns an object sentinel when the service returns null", async () => {
  const service = createFakeService();
  service.daySummary = async () => null;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.day_summary",
      arguments: {
        namespace: "global",
        timeZone: "America/Chicago",
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text: string }>;
  };
  assert.equal(result?.isError, false);
  assert.deepEqual(result?.structuredContent, {});
  assert.equal(result?.content?.[0]?.text, "{}");
});
test("MCP day_summary returns an object sentinel for undefined service results", async () => {
  const service = {
    ...createFakeService(),
    daySummary: async () => undefined,
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "engram.day_summary",
      arguments: {
        namespace: "global",
        timeZone: "America/Chicago",
      },
    },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text: string }>;
  };
  assert.equal(result?.isError, false);
  assert.deepEqual(result?.structuredContent, {});
  assert.equal(result?.content?.[0]?.text, "{}");
});

test("MCP preserves nullish results from operations without a no-data sentinel", async () => {
  const service = {
    ...createFakeService(),
    capsuleList: async () => null,
  } as unknown as EngramAccessService;
  const server = new EngramMcpServer(service);

  const response = await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "engram.capsule_list", arguments: {} },
  });

  const result = response?.result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type: string; text: string }>;
  };
  assert.equal(result?.isError, false);
  assert.equal("structuredContent" in (result ?? {}), false);
  assert.equal(result?.content?.[0]?.text, "null");
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
          lightSleep: {
            phase: "lightSleep",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
          rem: {
            phase: "rem",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
          deepSleep: {
            phase: "deepSleep",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
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
          lightSleep: {
            phase: "lightSleep",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
          rem: {
            phase: "rem",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
          deepSleep: {
            phase: "deepSleep",
            runCount: 0,
            totalDurationMs: 0,
            totalItemsProcessed: 0,
            lastRunAt: null,
            lastDurationMs: null,
          },
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
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });

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
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal((firstInit?.result as { serverInfo: { version: string } }).serverInfo.version, "9.9.1");

    process.env.OPENCLAW_ENGRAM_VERSION = "9.9.2";
    const secondServer = new EngramMcpServer(createFakeService());
    const secondInit = await secondServer.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    assert.equal((secondInit?.result as { serverInfo: { version: string } }).serverInfo.version, "9.9.2");
  } finally {
    if (originalVersion === undefined) {
      process.env.OPENCLAW_ENGRAM_VERSION = undefined;
    } else {
      process.env.OPENCLAW_ENGRAM_VERSION = originalVersion;
    }
  }
});

test("MCP server binds write authorization to its configured principal", async () => {
  let capturedPrincipal: string | undefined;
  let capturedSessionKey: string | undefined;
  const server = new EngramMcpServer(
    {
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
    } as unknown as EngramAccessService,
    {
      principal: "secret-team",
    }
  );

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
    ["first", "second"]
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
    { sessionKeyOverride: "adapter-session" }
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
    { sessionKeyOverride: "adapter-session" }
  );
  const exactResult = exactSearch?.result as {
    structuredContent: { request: { sessionKey?: string; sessionPrefix?: string } };
  };
  assert.equal(exactResult.structuredContent.request.sessionKey, "adapter-session");
  assert.equal(exactResult.structuredContent.request.sessionPrefix, undefined);
});

// ---------------------------------------------------------------------------
// outputSchema coverage — every MCP tool must declare an outputSchema.
// Uses a small safe-access helper instead of inline casts (ts-no-inline-cast-access).
// ---------------------------------------------------------------------------

function fieldOf(value: unknown, key: string): unknown {
  if (value !== null && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

test("MCP tools/list: every tool (including engram.* aliases) declares an outputSchema", async () => {
  const server = new EngramMcpServer(createFakeService());
  const resp = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const result = fieldOf(resp, "result");
  const tools = fieldOf(result, "tools");
  assert.ok(Array.isArray(tools), "tools/list must return a tools array");
  assert.ok((tools as unknown[]).length > 0, "tools array must be non-empty");
  const missing: string[] = [];
  const invalidTypes: string[] = [];
  for (const tool of tools) {
    const name = fieldOf(tool, "name");
    if (typeof name === "string") {
      const outputSchema = fieldOf(tool, "outputSchema");
      if (outputSchema === undefined) {
        missing.push(name);
      } else if (fieldOf(outputSchema, "type") !== "object") {
        invalidTypes.push(name);
      }
    }
  }
  assert.deepEqual(missing, [], `every tool must declare outputSchema; missing on: ${missing.join(", ")}`);
  assert.deepEqual(
    invalidTypes,
    [],
    `every tool outputSchema.type must be the literal string 'object'; invalid on: ${invalidTypes.join(", ")}`,
  );
});

test("MCP tools/list: key tools have outputSchema with declared properties", async () => {
  const server = new EngramMcpServer(createFakeService());
  const resp = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tools = fieldOf(fieldOf(resp, "result"), "tools") as unknown as Array<Record<string, unknown>>;
  const keyTools = [
    "remnic.recall",
    "remnic.memory_store",
    "remnic.memory_get",
    "remnic.briefing",
    "remnic.action_confidence",
    "remnic.memory_search",
  ];
  for (const name of keyTools) {
    const tool = tools.find((t) => fieldOf(t, "name") === name);
    assert.ok(tool, `${name} must be listed`);
    const schema = fieldOf(tool, "outputSchema");
    assert.ok(schema !== undefined && typeof schema === "object", `${name} outputSchema must be an object`);
    const properties = fieldOf(schema, "properties");
    assert.ok(
      properties !== undefined &&
        typeof properties === "object" &&
        Object.keys(properties as Record<string, unknown>).length > 0,
      `${name} outputSchema must declare non-empty properties, not just {type:'object'}`
    );
  }
});

test("MCP tools/call: structuredContent typeof matches declared outputSchema type", async () => {
  const server = new EngramMcpServer(createFakeService());
  const listResp = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tools = fieldOf(fieldOf(listResp, "result"), "tools") as unknown as Array<Record<string, unknown>>;
  const schemaTypeByTool = new Map<string, unknown>();
  for (const tool of tools) {
    const name = fieldOf(tool, "name");
    if (typeof name === "string") {
      schemaTypeByTool.set(name, fieldOf(fieldOf(tool, "outputSchema"), "type"));
    }
  }
  const fixtures: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: "engram.recall", args: { query: "test" } },
    { name: "engram.memory_get", args: { memoryId: "fact-1" } },
    { name: "engram.memory_store", args: { category: "fact", content: "hello", dryRun: true } },
    { name: "engram.peer_list", args: {} },
    { name: "engram.capsule_list", args: {} },
  ];
  for (const { name, args } of fixtures) {
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = fieldOf(resp, "result");
    assert.ok(result !== null && typeof result === "object", `${name}: result must be an object`);
    assert.notEqual(fieldOf(result, "isError"), true, `${name}: must not return an error`);
    const sc = fieldOf(result, "structuredContent");
    const actualType = sc === null ? "null" : Array.isArray(sc) ? "array" : typeof sc;
    const declaredType = schemaTypeByTool.get(name);
    assert.equal(
      actualType,
      declaredType,
      `${name}: structuredContent typeof (${actualType}) must match outputSchema.type`
    );
  }
});

test("outputSchema: no tool falls through to the generic default (every schema has declared properties)", async () => {
  // Every tool's outputSchema must have `properties` with at least one key,
  // proving it's a precise registry/pre-existing schema — NOT the generic
  // { type: 'object', additionalProperties: true } fallback. This prevents
  // a newly added tool silently getting a vacuous schema that CI still passes.
  const server = new EngramMcpServer(createFakeService());
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const listed = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = fieldOf(fieldOf(listed, "result"), "tools") as Array<{
    name: string;
    outputSchema?: Record<string, unknown>;
  }>;
  const fallbacks: string[] = [];
  for (const tool of tools) {
    const props = tool.outputSchema?.properties;
    if (!props || typeof props !== "object" || Object.keys(props).length === 0) {
      fallbacks.push(tool.name);
    }
  }
  assert.deepEqual(
    fallbacks,
    [],
    `These tools have no declared properties (generic fallback): ${fallbacks.join(", ")}. Add them to TOOL_OUTPUT_SCHEMAS in access-mcp.ts.`
  );
});

// ---------------------------------------------------------------------------
// AJV outputSchema validation — representative tools validated against their
// declared JSON-Schema outputSchema. Catches field-level type mismatches
// (wrong field names, wrong types, phantom fields from fake stubs) that the
// loose typeof check above cannot detect.
// ---------------------------------------------------------------------------
test("MCP wearable wrapper schemas require their array result", async () => {
  const server = new EngramMcpServer(createFakeService());
  const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tools = fieldOf(fieldOf(response, "result"), "tools") as Array<Record<string, unknown>>;
  const expected: Record<string, string> = {
    "engram.wearables_sync": "summaries",
    "engram.transcript_day": "transcripts",
    "engram.transcript_search": "results",
    "engram.transcript_memories": "memories",
  };

  for (const tool of tools) {
    const expectedKey = expected[fieldOf(tool, "name") as string];
    if (!expectedKey) continue;
    const schema = fieldOf(tool, "outputSchema");
    assert.deepEqual(fieldOf(schema, "required"), [expectedKey]);
  }
});



test("AJV: structuredContent validates against declared outputSchema for representative tools", async () => {
  const ajv = new Ajv({ strict: false });

  // Service stubs that return data matching the REAL return types.
  // The fake service (createFakeService) was the source of the original
  // mismatches; these overrides fill in tools it never stubbed and whose
  // schemas were corrected.
  const service = {
    ...createFakeService(),
    wearablesStatus: async () => ({
      enabled: true,
      timezone: "UTC",
      sources: [],
      connectorsInstalled: [],
    }),
    patternReinforcementRun: async () => ({
      namespace: "global",
      ran: true,
      clustersFound: 5,
      canonicalsUpdated: 3,
      duplicatesSuperseded: 2,
    }),
    procedureStats: async () => ({
      schemaVersion: 1 as const,
      generatedAt: "2026-07-11T00:00:00.000Z",
      namespace: "global",
      counts: { total: 10, active: 8, superseded: 2 },
      recent: { total: 3, minerSourced: 1 },
      config: {
        enabled: true,
        minOccurrences: 3,
        successFloor: 0,
        autoPromoteOccurrences: 0,
        autoPromoteEnabled: false,
        lookbackDays: 7,
        recallMaxProcedures: 5,
      },
    }),
    actionConfidence: async () => ({
      schemaVersion: 1,
      decision: "proceed",
      confidence: 0.85,
      risk: "low",
      contextReadiness: "sufficient",
      intendedAction: "write memory",
      attentionPolicy: "standard",
      principle: "sufficient-context",
      reasons: [],
      blockers: [],
      factors: [],
      retrievedMemoryCount: 3,
      scopeMismatchCount: 0,
      safeToAct: true,
    }),
  } as unknown as EngramAccessService;

  const server = new EngramMcpServer(service);
  await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });

  // Collect outputSchema per tool from tools/list.
  const listResp = await server.handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = fieldOf(fieldOf(listResp, "result"), "tools") as Array<Record<string, unknown>>;
  const schemaByName = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    const name = fieldOf(tool, "name");
    if (typeof name === "string") {
      const schema = fieldOf(tool, "outputSchema") as Record<string, unknown>;
      if (schema && typeof schema === "object") schemaByName.set(name, schema);
    }
  }

  // Representative tools covering: read, write, list, nullable-object,
  // nullable-string, object-return, string-return, and corrected schemas
  // (phantom field removal, nullable union fixes).
  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    // Read + complex object
    { name: "engram.recall", args: { query: "test" } },
    // Nullable object (memory present)
    { name: "engram.memory_get", args: { memoryId: "fact-1" } },
    // Write response
    { name: "engram.memory_store", args: { category: "fact", content: "x", dryRun: true } },
    // Nullable object (entity present)
    { name: "engram.entity_get", args: { name: "Alice" } },
    // List shape
    { name: "engram.capsule_list", args: {} },
    // Nullable string (encryptedArchivePath null when encrypt=false)
    { name: "engram.capsule_export", args: { name: "cap-1" } },
    // Array-of-objects import result
    { name: "engram.capsule_import", args: { archivePath: "/tmp/a.capsule.json.gz" } },
    // Wrapped array results for wearables/transcript tools
    { name: "engram.wearables_sync", args: {} },
    { name: "engram.transcript_day", args: { date: "2026-07-11" } },
    { name: "engram.transcript_search", args: { query: "meeting" } },
    { name: "engram.transcript_memories", args: {} },
    // Complex governance object
    { name: "engram.memory_governance_run", args: {} },
    // Corrected schemas (phantom removal + type fixes)
    { name: "engram.wearables_status", args: {} },
    { name: "engram.pattern_reinforcement_run", args: {} },
    { name: "engram.procedural_stats", args: {} },
    // Nullable null fields (intent:null, graph:null — typeof-null bug guard)
    { name: "engram.recall_explain", args: {} },
    // Action confidence — corrected schema (matchedRules phantom removed)
    {
      name: "engram.action_confidence",
      args: { intendedAction: "write", confidence: 0.9, risk: "low", contextReadiness: "sufficient" },
    },
    // List shape (peers)
    { name: "engram.peer_list", args: {} },
    // Complex nested object (console state)
    { name: "engram.console_state", args: {} },
  ];
  const expectedWrapperResults: Record<string, { key: string; args: Record<string, unknown> }> = {
    "engram.wearables_sync": { key: "summaries", args: {} },
    "engram.transcript_day": { key: "transcripts", args: { date: "2026-07-11" } },
    "engram.transcript_search": { key: "results", args: { query: "meeting" } },
    "engram.transcript_memories": { key: "memories", args: {} },
  };

  for (const [name, { key, args }] of Object.entries(expectedWrapperResults)) {
    const response = await server.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = fieldOf(response, "result");
    assert.notEqual(fieldOf(result, "isError"), true, `${name}: must not return an error`);
    const structuredContent = fieldOf(result, "structuredContent");
    assert.deepEqual(Object.keys(structuredContent as Record<string, unknown>).sort(), [key]);
    const wrapped = fieldOf(structuredContent, key);
    assert.ok(Array.isArray(wrapped), `${name}: ${key} must be an array`);
    assert.ok(wrapped.length > 0, `${name}: ${key} must contain representative data`);
  }

  for (const { name, args } of cases) {
    const resp = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = fieldOf(resp, "result");
    assert.notEqual(fieldOf(result, "isError"), true, `${name}: must not return an error`);
    const sc = fieldOf(result, "structuredContent");
    const schema = schemaByName.get(name);
    assert.ok(schema, `${name}: no outputSchema found in tools/list`);
    const validate = ajv.compile(schema);
    const valid = validate(sc);
    assert.ok(valid, `${name}: structuredContent failed AJV validation: ${JSON.stringify(validate.errors)}`);
  }

  // memory_get with found=false: structuredContent.memory is absent (nullable),
  // validating the T_NULLABLE_OBJECT schema against the not-found code path.
  {
    const notFoundService = {
      ...createFakeService(),
      memoryGet: async (_id: string) => ({ found: false, namespace: "global" }),
    } as unknown as EngramAccessService;
    const nfServer = new EngramMcpServer(notFoundService);
    const resp = await nfServer.handleRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "engram.memory_get", arguments: { memoryId: "nonexistent" } },
    });
    const result = fieldOf(resp, "result");
    assert.notEqual(fieldOf(result, "isError"), true, "memory_get(not found): must not error");
    const sc = fieldOf(result, "structuredContent");
    const schema = schemaByName.get("engram.memory_get");
    assert.ok(schema, "engram.memory_get: no outputSchema found");
    const validate = ajv.compile(schema);
    const valid = validate(sc);
    assert.ok(
      valid,
      `memory_get(found=false): structuredContent failed AJV validation: ${JSON.stringify(validate.errors)}`
    );
  }
  // peer_profile_get: real schema from tools/list + exhaustive matrix
  {
    const ppSchema = schemaByName.get("engram.peer_profile_get");
    assert.ok(ppSchema, "engram.peer_profile_get: no outputSchema in tools/list");
    const validate = ajv.compile(ppSchema);
    const validProfile = {
      peerId: "alice",
      updatedAt: "2026-07-11T00:00:00Z",
      fields: { style: "direct" },
      provenance: { style: [{ observedAt: "2026-07-11T00:00:00Z", signal: "explicit_preference" }] },
    };
    const omit = (o: Record<string, unknown>, ...keys: string[]): Record<string, unknown> => {
      const r = { ...o };
      for (const k of keys) delete r[k];
      return r;
    };
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      { d: "found=true with full profile", v: { found: true, profile: validProfile }, pass: true },
      { d: "found=false (profile absent)", v: { found: false }, pass: true },
      { d: "profile missing peerId", v: { found: true, profile: omit(validProfile, "peerId") }, pass: false },
      { d: "profile missing updatedAt", v: { found: true, profile: omit(validProfile, "updatedAt") }, pass: false },
      { d: "profile missing fields", v: { found: true, profile: omit(validProfile, "fields") }, pass: false },
      { d: "profile missing provenance", v: { found: true, profile: omit(validProfile, "provenance") }, pass: false },
      { d: "profile null", v: { found: true, profile: null }, pass: false },
      {
        d: "fields with non-string value",
        v: { found: true, profile: { ...validProfile, fields: { x: 42 } } },
        pass: false,
      },
      {
        d: "provenance entry missing observedAt",
        v: { found: true, profile: { ...validProfile, provenance: { style: [{ signal: "x" }] } } },
        pass: false,
      },
      {
        d: "provenance entry missing signal",
        v: { found: true, profile: { ...validProfile, provenance: { style: [{ observedAt: "x" }] } } },
        pass: false,
      },
      {
        d: "provenance entries not an array",
        v: { found: true, profile: { ...validProfile, provenance: { style: "not-array" } } },
        pass: false,
      },
      {
        d: "provenance array with non-object entry",
        v: { found: true, profile: { ...validProfile, provenance: { style: ["bad"] } } },
        pass: false,
      },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(
        result,
        pass,
        `peer_profile_get "${desc}": expected ${pass ? "valid" : "invalid"}${validate.errors ? ` — ${JSON.stringify(validate.errors)}` : ""}`
      );
    }
  }

  // memory_chat: real schema from chatVisible=true server + exhaustive matrix
  {
    const chatServer = new EngramMcpServer(createFakeService(), { chatVisible: true });
    const chatList = await chatServer.handleRequest({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
    const chatTools = fieldOf(fieldOf(chatList, "result"), "tools") as Array<Record<string, unknown>>;
    const mcTool = chatTools.find((t) => fieldOf(t, "name") === "engram.memory_chat");
    assert.ok(mcTool, "engram.memory_chat not in tools/list with chatVisible=true");
    const mcSchema = fieldOf(mcTool, "outputSchema") as Record<string, unknown>;
    assert.ok(mcSchema, "engram.memory_chat has no outputSchema");
    const validate = ajv.compile(mcSchema);
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      {
        d: "with pendingPlan (required fields present)",
        v: { reply: "hi", chatSessionId: "s1", pendingPlan: { planId: "p1", preview: "do X" } },
        pass: true,
      },
      { d: "without pendingPlan (optional)", v: { reply: "hi", chatSessionId: "s1" }, pass: true },
      {
        d: "with skippedTools (string items)",
        v: { reply: "hi", chatSessionId: "s1", skippedTools: ["tool_a"] },
        pass: true,
      },
      {
        d: "pendingPlan missing planId",
        v: { reply: "hi", chatSessionId: "s1", pendingPlan: { preview: "no id" } },
        pass: false,
      },
      {
        d: "pendingPlan missing preview",
        v: { reply: "hi", chatSessionId: "s1", pendingPlan: { planId: "p1" } },
        pass: false,
      },
      { d: "pendingPlan null", v: { reply: "hi", chatSessionId: "s1", pendingPlan: null }, pass: false },
      { d: "pendingPlan empty object", v: { reply: "hi", chatSessionId: "s1", pendingPlan: {} }, pass: false },
      {
        d: "skippedTools with non-string item",
        v: { reply: "hi", chatSessionId: "s1", skippedTools: [42] },
        pass: false,
      },
      {
        d: "skippedTools scalar instead of array",
        v: { reply: "hi", chatSessionId: "s1", skippedTools: "tool_a" },
        pass: false,
      },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(result, pass, `memory_chat "${desc}": expected ${pass ? "valid" : "invalid"}`);
    }
  }
  // memory_identity: real schema from tools/list + snapshot/fallback cases
  {
    const idSchema = schemaByName.get("engram.memory_identity");
    assert.ok(idSchema, "engram.memory_identity: no outputSchema in tools/list");
    const validate = ajv.compile(idSchema);
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      {
        d: "found=true with identity string",
        v: { found: true, identity: "## Identity Reflections\n- Prefers concise output" },
        pass: true,
      },
      {
        d: "found=false with message fallback",
        v: { found: false, message: "No identity reflections found" },
        pass: true,
      },
      { d: "identity as number (invalid)", v: { found: true, identity: 42 }, pass: false },
      {
        d: "identity as object (invalid — the original bug)",
        v: { found: true, identity: { text: "reflections" } },
        pass: false,
      },
      { d: "found as string (invalid)", v: { found: "yes", identity: "x" }, pass: false },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(
        result,
        pass,
        `memory_identity "${desc}": expected ${pass ? "valid" : "invalid"}${validate.errors ? ` — ${JSON.stringify(validate.errors)}` : ""}`
      );
    }
  }

  // memory_last_recall: real schema, snapshot form vs message fallback
  {
    const lrSchema = schemaByName.get("engram.memory_last_recall");
    assert.ok(lrSchema, "engram.memory_last_recall: no outputSchema in tools/list");
    const validate = ajv.compile(lrSchema);
    const snapshot = {
      sessionKey: "s1",
      recordedAt: "2026-07-11T00:00:00Z",
      queryHash: "abc123",
      queryLen: 42,
      memoryIds: ["mem-1", "mem-2"],
    };
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      { d: "full snapshot", v: snapshot, pass: true },
      { d: "message fallback", v: { message: "No last recall snapshot" }, pass: true },
      { d: "queryLen as string (invalid)", v: { ...snapshot, queryLen: "42" }, pass: false },
      { d: "memoryIds as object (invalid)", v: { ...snapshot, memoryIds: {} }, pass: false },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(
        result,
        pass,
        `memory_last_recall "${desc}": expected ${pass ? "valid" : "invalid"}${validate.errors ? ` — ${JSON.stringify(validate.errors)}` : ""}`
      );
    }
  }

  // memory_intent_debug: real schema, snapshot form vs message fallback
  {
    const idSchema2 = schemaByName.get("engram.memory_intent_debug");
    assert.ok(idSchema2, "engram.memory_intent_debug: no outputSchema in tools/list");
    const validate = ajv.compile(idSchema2);
    const snapshot = {
      recordedAt: "2026-07-11T00:00:00Z",
      promptHash: "h1",
      promptLength: 100,
      retrievalQueryHash: "h2",
      retrievalQueryLength: 50,
      plannerEnabled: true,
      plannedMode: "full",
      effectiveMode: "full",
      recallResultLimit: 10,
      queryIntent: { type: "question" },
      graphExpandedIntentDetected: false,
      graphDecision: {
        status: "not_requested",
        shadowMode: false,
        qmdAvailable: true,
        graphRecallEnabled: false,
        multiGraphMemoryEnabled: false,
      },
    };
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      { d: "full snapshot", v: snapshot, pass: true },
      { d: "message fallback", v: { message: "No intent debug snapshot" }, pass: true },
      { d: "plannerEnabled as string (invalid)", v: { ...snapshot, plannerEnabled: "yes" }, pass: false },
      { d: "promptLength as string (invalid)", v: { ...snapshot, promptLength: "100" }, pass: false },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(result, pass, `memory_intent_debug "${desc}": expected ${pass ? "valid" : "invalid"}`);
    }
  }

  // memory_qmd_debug: real schema, snapshot form vs message fallback
  {
    const qdSchema = schemaByName.get("engram.memory_qmd_debug");
    assert.ok(qdSchema, "engram.memory_qmd_debug: no outputSchema in tools/list");
    const validate = ajv.compile(qdSchema);
    const snapshot = {
      recordedAt: "2026-07-11T00:00:00Z",
      queryHash: "h1",
      queryLength: 50,
      namespaces: ["default"],
      fetchLimit: 100,
      primaryResultCount: 10,
      hybridResultCount: 5,
      queryAwareSeedCount: 3,
      resultCount: 15,
      explainEnabled: false,
      hybridTopUpUsed: false,
      results: [],
    };
    const cases: Array<{ d: string; v: unknown; pass: boolean }> = [
      { d: "full snapshot", v: snapshot, pass: true },
      { d: "message fallback", v: { message: "No QMD debug snapshot" }, pass: true },
      { d: "fetchLimit as string (invalid)", v: { ...snapshot, fetchLimit: "100" }, pass: false },
      { d: "explainEnabled as number (invalid)", v: { ...snapshot, explainEnabled: 1 }, pass: false },
    ];
    for (const { d: desc, v, pass } of cases) {
      const result = validate(v);
      assert.equal(result, pass, `memory_qmd_debug "${desc}": expected ${pass ? "valid" : "invalid"}`);
    }
  }
});
