import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { EngramAccessHttpServer } from "../src/access-http.js";
import { EngramAccessInputError, EngramAccessService } from "../src/access-service.js";
import { StorageManager } from "../src/storage.js";

function createFakeService(): EngramAccessService {
  return {
    health: async () => ({
      ok: true,
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledgeEnabled: false,
      projectionAvailable: true,
    }),
    recall: async ({ query, sessionKey }) => ({
      query,
      sessionKey,
      namespace: "global",
      context: "memory context",
      count: 1,
      memoryIds: ["fact-1"],
      results: [{
        id: "fact-1",
        path: "/tmp/engram/facts/fact-1.md",
        category: "fact",
        status: "active",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T00:00:00.000Z",
        tags: ["ops"],
        preview: "hello",
      }],
      recordedAt: "2026-03-08T00:00:00.000Z",
      traceId: "trace-1",
      plannerMode: "full",
      fallbackUsed: false,
      sourcesUsed: ["hot_qmd", "memories"],
      budgetsApplied: {
        appliedTopK: 1,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
      },
      latencyMs: 12,
    }),
    recallExplain: async ({ sessionKey }) => ({
      found: true,
      snapshot: {
        sessionKey: sessionKey ?? "default",
        recordedAt: "2026-03-08T00:00:00.000Z",
        queryHash: "hash",
        queryLen: 12,
        memoryIds: ["fact-1"],
      },
      intent: null,
      graph: null,
    }),
    memoryGet: async (memoryId) => ({
      found: true,
      namespace: "global",
      memory: {
        id: memoryId,
        path: "/tmp/engram/facts/fact-1.md",
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
    memoryTimeline: async (memoryId, _namespace, limit) => ({
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
    memoryBrowse: async () => ({
      namespace: "global",
      sort: "updated_desc",
      total: 1,
      count: 1,
      limit: 50,
      offset: 0,
      memories: [{
        id: "fact-1",
        path: "/tmp/engram/facts/fact-1.md",
        category: "fact",
        status: "pending_review",
        created: "2026-03-08T00:00:00.000Z",
        updated: "2026-03-08T00:00:00.000Z",
        tags: ["ops"],
        preview: "hello",
      }],
    }),
    entityList: async () => ({
      namespace: "global",
      total: 1,
      count: 1,
      limit: 50,
      offset: 0,
      entities: [{
        name: "person-alex",
        type: "person",
        updated: "2026-03-08T00:00:00.000Z",
        summary: "Owns ops",
        aliases: ["Alex Ops"],
      }],
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
    reviewQueue: async () => ({
      found: true,
      runId: "gov-1",
      summary: { runId: "gov-1", mode: "shadow" },
      metrics: { reviewReasons: { disputed_memory: 1 }, proposedStatuses: { pending_review: 1 } },
      reviewQueue: [{ memoryId: "fact-1", reasonCode: "disputed_memory" }],
      appliedActions: [],
      report: "# report",
    }),
    peekMemoryStoreIdempotency: async () => "miss",
    peekSuggestionSubmitIdempotency: async () => "miss",
    memoryStore: async ({ dryRun, idempotencyKey }) => ({
      schemaVersion: 1,
      operation: "memory_store",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: false,
      status: dryRun === true ? "validated" : "stored",
      memoryId: dryRun === true ? undefined : "fact-new",
      idempotencyKey,
    }),
    suggestionSubmit: async ({ dryRun, idempotencyKey }) => ({
      schemaVersion: 1,
      operation: "suggestion_submit",
      namespace: "global",
      dryRun: dryRun === true,
      accepted: true,
      queued: true,
      status: dryRun === true ? "validated" : "queued_for_review",
      memoryId: dryRun === true ? undefined : "fact-review",
      idempotencyKey,
    }),
    maintenance: async () => ({
      health: {
        ok: true,
        memoryDir: "/tmp/engram",
        namespacesEnabled: true,
        defaultNamespace: "global",
        searchBackend: "qmd",
        qmdEnabled: true,
        nativeKnowledgeEnabled: false,
        projectionAvailable: true,
      },
      latestGovernanceRun: {
        found: true,
        runId: "gov-1",
      },
    }),
    quality: async () => ({
      namespace: "global",
      totalMemories: 1,
      statusCounts: { pending_review: 1 },
      categoryCounts: { fact: 1 },
      confidenceTierCounts: { implied: 1 },
      ageBucketCounts: { "0_7_days": 1 },
      archivePressure: {
        pendingReview: 1,
        quarantined: 0,
        archived: 0,
        staleActive: 0,
        lowConfidenceActive: 0,
      },
      latestGovernanceRun: {
        found: true,
        runId: "gov-1",
        qualityScore: {
          score: 92,
          maxScore: 100,
          grade: "excellent",
          deductions: [],
        },
        reviewQueueCount: 1,
      },
    }),
    trustZoneStatus: async () => ({
      namespace: "global",
      status: {
        enabled: true,
        promotionEnabled: true,
        poisoningDefenseEnabled: true,
        rootDir: "/tmp/engram/state/trust-zones",
        zonesDir: "/tmp/engram/state/trust-zones/zones",
        records: {
          total: 3,
          valid: 3,
          invalid: 0,
          byZone: { quarantine: 1, working: 1, trusted: 1 },
          byKind: { external: 1, state: 1, memory: 1 },
          latestRecordId: "tz-1",
          latestRecordedAt: "2026-03-08T00:00:00.000Z",
          latestZone: "working",
          averageTrustScore: 0.75,
          byTrustBand: { medium: 2, high: 1 },
        },
      },
    }),
    trustZoneBrowse: async () => ({
      namespace: "global",
      total: 1,
      count: 1,
      limit: 25,
      offset: 0,
      records: [{
        recordId: "tz-1",
        filePath: "/tmp/engram/state/trust-zones/zones/working/2026-03-08/tz-1.json",
        zone: "working",
        recordedAt: "2026-03-08T00:00:00.000Z",
        kind: "state",
        summary: "Anchored tool output awaiting promotion.",
        sourceClass: "tool_output",
        evidenceHashPresent: true,
        anchored: true,
        entityRefs: ["deploy:42"],
        tags: ["trust-zone-demo"],
        trustScore: {
          total: 0.9,
          band: "high",
          anchored: true,
          sourceClassWeight: 0.55,
          sourceIdBonus: 0.1,
          evidenceHashBonus: 0.2,
          sessionKeyBonus: 0.05,
        },
        nextPromotionTarget: "trusted",
        nextPromotionAllowed: false,
        nextPromotionReasons: ["trusted promotion requires corroboration from an independent non-quarantine source"],
        corroborationCount: 0,
        corroborationSourceClasses: [],
      }],
    }),
    trustZonePromote: async ({ recordId, targetZone, dryRun }) => ({
      namespace: "global",
      dryRun: dryRun === true,
      plan: {
        allowed: true,
        reasons: [],
        sourceRecordId: recordId,
        sourceZone: "working",
        targetZone,
        provenanceAnchored: true,
      },
      wroteRecord: dryRun !== true,
      record: {
        schemaVersion: 1,
        recordId: `${recordId}-${targetZone}`,
        zone: targetZone,
        recordedAt: "2026-03-08T00:05:00.000Z",
        kind: "state",
        summary: "Promoted trust-zone record.",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "2026-03-08T00:00:00.000Z",
          sourceId: "tool:deploy",
          evidenceHash: "sha256:deploy",
        },
        promotedFromZone: "working",
      },
      sourceRecord: {
        schemaVersion: 1,
        recordId,
        zone: "working",
        recordedAt: "2026-03-08T00:00:00.000Z",
        kind: "state",
        summary: "Source trust-zone record.",
        provenance: {
          sourceClass: "tool_output",
          observedAt: "2026-03-08T00:00:00.000Z",
          sourceId: "tool:deploy",
          evidenceHash: "sha256:deploy",
        },
      },
      filePath: dryRun === true ? undefined : "/tmp/engram/state/trust-zones/zones/trusted/2026-03-08/tz-1-trusted.json",
    }),
    trustZoneDemoSeed: async ({ dryRun }) => ({
      namespace: "global",
      scenario: "enterprise-buyer-v1",
      dryRun: dryRun === true,
      recordsWritten: dryRun === true ? 0 : 5,
      records: [{
        schemaVersion: 1,
        recordId: "tz-demo-1",
        zone: "quarantine",
        recordedAt: "2026-03-08T00:00:00.000Z",
        kind: "external",
        summary: "Demo trust-zone record.",
        provenance: {
          sourceClass: "web_content",
          observedAt: "2026-03-07T23:59:00.000Z",
        },
      }],
      filePaths: dryRun === true ? [] : ["/tmp/engram/state/trust-zones/zones/quarantine/2026-03-08/tz-demo-1.json"],
    }),
    reviewDisposition: async ({ memoryId, status }) => ({
      ok: true,
      namespace: "global",
      memoryId,
      status,
      previousStatus: "pending_review",
    }),
    consoleState: async () => ({
      capturedAt: "2026-04-27T00:00:00.000Z",
      bufferState: { turnsCount: 2, byteCount: 128 },
      extractionQueue: { depth: 0, recentVerdicts: [] },
      dedupRecent: [],
      maintenanceLedgerTail: [],
      qmdProbe: { available: true, daemonMode: false, debug: "ok" },
      daemon: { uptimeMs: 5000, version: "9.3.230" },
      errors: [],
    }),
    procedureStats: async (request: { namespace?: string } = {}) => ({
      namespace: request.namespace ?? "global",
      schemaVersion: 1,
      generatedAt: "2026-04-20T12:00:00.000Z",
      counts: {
        total: 4,
        active: 2,
        pending_review: 1,
        rejected: 0,
        quarantined: 0,
        superseded: 1,
        archived: 0,
        other: 0,
      },
      recent: {
        lastWriteAt: "2026-04-20T11:59:59.000Z",
        writesLast7Days: 3,
        minerSourced: 2,
      },
      config: {
        enabled: true,
        minOccurrences: 3,
        successFloor: 0.75,
        autoPromoteOccurrences: 8,
        autoPromoteEnabled: false,
        lookbackDays: 14,
        recallMaxProcedures: 2,
      },
    }),
    capsuleExport: async ({ name }) => ({
      archivePath: `/tmp/engram/.capsules/${name}.capsule.json.gz`,
      manifestPath: `/tmp/engram/.capsules/${name}.manifest.json`,
      encryptedArchivePath: null,
      manifest: {
        format: "remnic-capsule",
        schemaVersion: 2,
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "9.3.243",
        includesTranscripts: false,
        files: [{ path: "facts/2026-04-28/fact-a.md", sha256: "abc123", bytes: 42 }],
        capsule: {
          id: name,
          version: "1.0.0",
          createdAt: "2026-04-28T00:00:00.000Z",
          parentCapsule: null,
          description: "HTTP test capsule",
          retrievalPolicy: {
            directAnswerEnabled: false,
            tierWeights: {},
          },
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
        format: "remnic-capsule",
        schemaVersion: 2,
        createdAt: "2026-04-28T00:00:00.000Z",
        pluginVersion: "9.3.243",
        includesTranscripts: false,
        files: [{ path: "facts/2026-04-28/fact-a.md", sha256: "abc123", bytes: 42 }],
        capsule: {
          id: path.basename(String(archivePath)).replace(/\.capsule\.json\.gz(?:\.enc)?$/, ""),
          version: "1.0.0",
          createdAt: "2026-04-28T00:00:00.000Z",
          parentCapsule: null,
          description: "HTTP import test capsule",
          retrievalPolicy: {
            directAnswerEnabled: false,
            tierWeights: {},
          },
          includes: {
            taxonomy: false,
            identityAnchors: false,
            peerProfiles: false,
            procedural: false,
          },
        },
      },
    }),
  } as unknown as EngramAccessService;
}

test("access HTTP server enforces bearer auth and serves phase 1 routes", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const denied = await fetch(`${base}/engram/v1/health`);
    assert.equal(denied.status, 401);

    const headers = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

    const healthRes = await fetch(`${base}/engram/v1/health`, { headers });
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { ok: boolean; projectionAvailable: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.projectionAvailable, true);

    const recallRes = await fetch(`${base}/engram/v1/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "what did we decide?", sessionKey: "sess-1" }),
    });
    assert.equal(recallRes.status, 200);
    const recall = await recallRes.json() as { context: string; memoryIds: string[] };
    assert.equal(recall.context, "memory context");
    assert.deepEqual(recall.memoryIds, ["fact-1"]);
    assert.equal((recall as { traceId?: string }).traceId, "trace-1");

    const explainRes = await fetch(`${base}/engram/v1/recall/explain`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionKey: "sess-1", namespace: "global" }),
    });
    assert.equal(explainRes.status, 200);
    const explain = await explainRes.json() as { found: boolean; snapshot: { sessionKey: string } };
    assert.equal(explain.found, true);
    assert.equal(explain.snapshot.sessionKey, "sess-1");

    const memoryRes = await fetch(`${base}/engram/v1/memories/fact-1`, { headers });
    assert.equal(memoryRes.status, 200);
    const memory = await memoryRes.json() as { found: boolean; memory: { id: string } };
    assert.equal(memory.found, true);
    assert.equal(memory.memory.id, "fact-1");

    const timelineRes = await fetch(`${base}/engram/v1/memories/fact-1/timeline?limit=5`, { headers });
    assert.equal(timelineRes.status, 200);
    const timeline = await timelineRes.json() as { count: number };
    assert.equal(timeline.count, 1);

    const browseRes = await fetch(`${base}/engram/v1/memories?q=hello`, { headers });
    assert.equal(browseRes.status, 200);
    const browse = await browseRes.json() as { total: number; sort: string };
    assert.equal(browse.total, 1);
    assert.equal(browse.sort, "updated_desc");

    const storeRes = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "store-1",
        content: "A durable explicit memory for the access API.",
        category: "fact",
      }),
    });
    assert.equal(storeRes.status, 201);
    const storePayload = await storeRes.json() as { operation: string; status: string; idempotencyKey: string };
    assert.equal(storePayload.operation, "memory_store");
    assert.equal(storePayload.status, "stored");
    assert.equal(storePayload.idempotencyKey, "store-1");

    const suggestionRes = await fetch(`${base}/engram/v1/suggestions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "This should be queued for review.",
        category: "fact",
      }),
    });
    assert.equal(suggestionRes.status, 201);
    const suggestionPayload = await suggestionRes.json() as { operation: string; status: string; queued: boolean };
    assert.equal(suggestionPayload.operation, "suggestion_submit");
    assert.equal(suggestionPayload.status, "queued_for_review");
    assert.equal(suggestionPayload.queued, true);

    const entitiesRes = await fetch(`${base}/engram/v1/entities?q=alex`, { headers });
    assert.equal(entitiesRes.status, 200);
    const entities = await entitiesRes.json() as { total: number };
    assert.equal(entities.total, 1);

    const entityRes = await fetch(`${base}/engram/v1/entities/person-alex`, { headers });
    assert.equal(entityRes.status, 200);
    const entity = await entityRes.json() as { found: boolean; entity: { name: string } };
    assert.equal(entity.found, true);
    assert.equal(entity.entity.name, "person-alex");

    const queueRes = await fetch(`${base}/engram/v1/review-queue`, { headers });
    assert.equal(queueRes.status, 200);
    const queue = await queueRes.json() as { found: boolean; runId: string };
    assert.equal(queue.found, true);
    assert.equal(queue.runId, "gov-1");

    const maintenanceRes = await fetch(`${base}/engram/v1/maintenance`, { headers });
    assert.equal(maintenanceRes.status, 200);
    const maintenance = await maintenanceRes.json() as { latestGovernanceRun: { runId: string } };
    assert.equal(maintenance.latestGovernanceRun.runId, "gov-1");

    const qualityRes = await fetch(`${base}/engram/v1/quality`, { headers });
    assert.equal(qualityRes.status, 200);
    const quality = await qualityRes.json() as {
      totalMemories: number;
      latestGovernanceRun: { qualityScore: { score: number } };
    };
    assert.equal(quality.totalMemories, 1);
    assert.equal(quality.latestGovernanceRun.qualityScore.score, 92);

    const trustZoneStatusRes = await fetch(`${base}/engram/v1/trust-zones/status`, { headers });
    assert.equal(trustZoneStatusRes.status, 200);
    const trustZoneStatus = await trustZoneStatusRes.json() as { status: { records: { valid: number } } };
    assert.equal(trustZoneStatus.status.records.valid, 3);

    // Procedural stats (issue #567 PR 5/5). Namespace is optional.
    const proceduralStatsRes = await fetch(
      `${base}/engram/v1/procedural/stats`,
      { headers },
    );
    assert.equal(proceduralStatsRes.status, 200);
    const proceduralStats = (await proceduralStatsRes.json()) as {
      schemaVersion: number;
      counts: { total: number; active: number; pending_review: number };
      config: { enabled: boolean; recallMaxProcedures: number };
    };
    assert.equal(proceduralStats.schemaVersion, 1);
    assert.equal(proceduralStats.counts.total, 4);
    assert.equal(proceduralStats.counts.active, 2);
    assert.equal(proceduralStats.counts.pending_review, 1);
    assert.equal(proceduralStats.config.enabled, true);
    assert.equal(proceduralStats.config.recallMaxProcedures, 2);

    const capsuleDenied = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "daily-ops" }),
    });
    assert.equal(capsuleDenied.status, 401);

    const capsuleExportRes = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "daily-ops",
        namespace: "global",
        includeKinds: ["facts"],
        includeTranscripts: true,
      }),
    });
    assert.equal(capsuleExportRes.status, 200);
    const capsuleExport = await capsuleExportRes.json() as {
      archivePath: string;
      manifestPath: string;
      encryptedArchivePath: string | null;
      manifest: { capsule: { id: string }; files: Array<{ path: string }> };
    };
    assert.equal(capsuleExport.archivePath, "/tmp/engram/.capsules/daily-ops.capsule.json.gz");
    assert.equal(capsuleExport.manifestPath, "/tmp/engram/.capsules/daily-ops.manifest.json");
    assert.equal(capsuleExport.encryptedArchivePath, null);
    assert.equal(capsuleExport.manifest.capsule.id, "daily-ops");
    assert.deepEqual(capsuleExport.manifest.files.map((file) => file.path), ["facts/2026-04-28/fact-a.md"]);

    const capsuleImportDenied = await fetch(`${base}/engram/v1/capsules/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archivePath: "/tmp/daily-ops.capsule.json.gz" }),
    });
    assert.equal(capsuleImportDenied.status, 401);

    const capsuleImportRes = await fetch(`${base}/engram/v1/capsules/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        archivePath: "/tmp/daily-ops.capsule.json.gz",
        namespace: "global",
        mode: "overwrite",
      }),
    });
    assert.equal(capsuleImportRes.status, 200);
    const capsuleImport = await capsuleImportRes.json() as {
      imported: Array<{ sourcePath: string; targetPath: string; snapshotted: boolean }>;
      skipped: unknown[];
      manifest: { capsule: { id: string } };
    };
    assert.equal(capsuleImport.imported.length, 1);
    assert.equal(capsuleImport.imported[0]?.sourcePath, "facts/2026-04-28/fact-a.md");
    assert.equal(capsuleImport.imported[0]?.snapshotted, true);
    assert.deepEqual(capsuleImport.skipped, []);
    assert.equal(capsuleImport.manifest.capsule.id, "daily-ops");

    // Operator console state (issue #688 PR 2/3).
    const consoleStateRes = await fetch(`${base}/engram/v1/console/state`, { headers });
    assert.equal(consoleStateRes.status, 200);
    const consoleState = await consoleStateRes.json() as {
      capturedAt: string;
      bufferState: { turnsCount: number; byteCount: number };
      qmdProbe: { available: boolean };
      errors: string[];
    };
    assert.ok(typeof consoleState.capturedAt === "string");
    assert.equal(consoleState.bufferState.turnsCount, 2);
    assert.equal(consoleState.bufferState.byteCount, 128);
    assert.equal(consoleState.qmdProbe.available, true);
    assert.deepEqual(consoleState.errors, []);

    // Auth required — no token.
    const consoleStateNoAuth = await fetch(`${base}/engram/v1/console/state`);
    assert.equal(consoleStateNoAuth.status, 401);

    const trustZoneBrowseRes = await fetch(`${base}/engram/v1/trust-zones/records?zone=working`, { headers });
    assert.equal(trustZoneBrowseRes.status, 200);
    const trustZoneBrowse = await trustZoneBrowseRes.json() as { count: number; records: Array<{ recordId: string }> };
    assert.equal(trustZoneBrowse.count, 1);
    assert.equal(trustZoneBrowse.records[0]?.recordId, "tz-1");

    const trustZonePromoteRes = await fetch(`${base}/engram/v1/trust-zones/promote`, {
      method: "POST",
      headers,
      body: JSON.stringify({ recordId: "tz-1", targetZone: "trusted", promotionReason: "Operator approved", dryRun: true }),
    });
    assert.equal(trustZonePromoteRes.status, 200);
    const trustZonePromote = await trustZonePromoteRes.json() as { dryRun: boolean; wroteRecord: boolean };
    assert.equal(trustZonePromote.dryRun, true);
    assert.equal(trustZonePromote.wroteRecord, false);

    const trustZoneSeedRes = await fetch(`${base}/engram/v1/trust-zones/demo-seed`, {
      method: "POST",
      headers,
      body: JSON.stringify({ scenario: "enterprise-buyer-v1", dryRun: true }),
    });
    assert.equal(trustZoneSeedRes.status, 200);
    const trustZoneSeed = await trustZoneSeedRes.json() as { dryRun: boolean; scenario: string };
    assert.equal(trustZoneSeed.dryRun, true);
    assert.equal(trustZoneSeed.scenario, "enterprise-buyer-v1");

    const dispositionRes = await fetch(`${base}/engram/v1/review-disposition`, {
      method: "POST",
      headers,
      body: JSON.stringify({ memoryId: "fact-1", status: "active", reasonCode: "operator_confirmed" }),
    });
    assert.equal(dispositionRes.status, 200);
    const disposition = await dispositionRes.json() as { ok: boolean; status: string };
    assert.equal(disposition.ok, true);
    assert.equal(disposition.status, "active");
  } finally {
    await server.stop();
  }
});

test("access HTTP server serves admin console shell without auth and rejects invalid dispositions", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const uiRes = await fetch(`${base}/engram/ui/`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /Remnic Admin Console/);
    assert.match(html, /Quality Dashboard/);
    assert.match(html, /Trust Zones/);

    const badDispositionRes = await fetch(`${base}/engram/v1/review-disposition`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ memoryId: "fact-1", status: "bogus", reasonCode: "operator_confirmed" }),
    });
    assert.equal(badDispositionRes.status, 400);
  } finally {
    await server.stop();
  }
});

test("access HTTP capsule export validates input and surfaces ACL errors", async () => {
  let captured: Record<string, unknown> | null = null;
  const service = {
    ...createFakeService(),
    capsuleExport: async (request: Record<string, unknown>) => {
      captured = request;
      if (request.namespace === "private") {
        throw new EngramAccessInputError("namespace is not readable");
      }
      return {
        archivePath: "/tmp/engram/.capsules/remnic-alias.capsule.json.gz",
        manifestPath: "/tmp/engram/.capsules/remnic-alias.manifest.json",
        encryptedArchivePath: null,
        manifest: {
          capsule: { id: request.name },
          files: [],
        },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "principal-1",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

  try {
    const invalidName = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "bad name" }),
    });
    assert.equal(invalidName.status, 400);
    const invalidNamePayload = await invalidName.json() as { code: string; details: Array<{ field: string }> };
    assert.equal(invalidNamePayload.code, "validation_error");
    assert.equal(invalidNamePayload.details[0]?.field, "name");

    const invalidKind = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "good-name", includeKinds: ["../facts"] }),
    });
    assert.equal(invalidKind.status, 400);

    const invalidSince = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "good-name", since: "2026-02-31" }),
    });
    assert.equal(invalidSince.status, 400);

    const deniedNamespace = await fetch(`${base}/engram/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "good-name", namespace: "private" }),
    });
    assert.equal(deniedNamespace.status, 400);
    const deniedPayload = await deniedNamespace.json() as { code: string; error: string };
    assert.equal(deniedPayload.code, "input_error");
    assert.equal(deniedPayload.error, "namespace is not readable");

    const aliasResponse = await fetch(`${base}/remnic/v1/capsules/export`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "remnic-alias",
        namespace: "team-a",
        since: "2026-04-28T00:00:00Z",
        peerIds: ["peer-a"],
        encrypt: true,
      }),
    });
    assert.equal(aliasResponse.status, 200);
    assert.deepEqual(captured, {
      name: "remnic-alias",
      namespace: "team-a",
      principal: "principal-1",
      since: "2026-04-28T00:00:00Z",
      includeKinds: undefined,
      peerIds: ["peer-a"],
      includeTranscripts: undefined,
      encrypt: true,
    });
  } finally {
    await server.stop();
  }
});

test("access HTTP capsule import validates input and surfaces ACL errors", async () => {
  let captured: Record<string, unknown> | null = null;
  const service = {
    ...createFakeService(),
    capsuleImport: async (request: Record<string, unknown>) => {
      captured = request;
      if (request.namespace === "private") {
        throw new EngramAccessInputError("namespace is not writable");
      }
      return {
        imported: [],
        skipped: [{ path: "facts/2026-04-28/fact-a.md", reason: "exists" }],
        manifest: {
          format: "remnic-capsule",
          schemaVersion: 2,
          createdAt: "2026-04-28T00:00:00.000Z",
          pluginVersion: "9.3.243",
          includesTranscripts: false,
          files: [],
          capsule: {
            id: "import-alias",
            version: "1.0.0",
            createdAt: "2026-04-28T00:00:00.000Z",
            parentCapsule: null,
            description: null,
            retrievalPolicy: null,
          },
        },
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "principal-1",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

  try {
    const missingArchivePath = await fetch(`${base}/engram/v1/capsules/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "overwrite" }),
    });
    assert.equal(missingArchivePath.status, 400);
    const missingArchivePayload = await missingArchivePath.json() as { code: string; details: Array<{ field: string }> };
    assert.equal(missingArchivePayload.code, "validation_error");
    assert.equal(missingArchivePayload.details[0]?.field, "archivePath");

    const invalidMode = await fetch(`${base}/engram/v1/capsules/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ archivePath: "/tmp/import-alias.capsule.json.gz", mode: "merge" }),
    });
    assert.equal(invalidMode.status, 400);

    const deniedNamespace = await fetch(`${base}/engram/v1/capsules/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ archivePath: "/tmp/import-alias.capsule.json.gz", namespace: "private" }),
    });
    assert.equal(deniedNamespace.status, 400);
    const deniedPayload = await deniedNamespace.json() as { code: string; error: string };
    assert.equal(deniedPayload.code, "input_error");
    assert.equal(deniedPayload.error, "namespace is not writable");

    const aliasResponse = await fetch(`${base}/remnic/v1/capsules/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        archivePath: "~/import-alias.capsule.json.gz",
        namespace: "team-a",
        mode: "fork",
      }),
    });
    assert.equal(aliasResponse.status, 200);
    const aliasPayload = await aliasResponse.json() as {
      skipped: Array<{ path: string; reason: string }>;
      manifest: { capsule: { id: string } };
    };
    assert.deepEqual(aliasPayload.skipped, [{ path: "facts/2026-04-28/fact-a.md", reason: "exists" }]);
    assert.equal(aliasPayload.manifest.capsule.id, "import-alias");
    assert.deepEqual(captured, {
      archivePath: path.join(os.homedir(), "import-alias.capsule.json.gz"),
      namespace: "team-a",
      principal: "principal-1",
      mode: "fork",
      passphrase: undefined,
    });
  } finally {
    await server.stop();
  }
});

test("access HTTP dreams run rejects non-boolean dryRun without invoking service", async () => {
  let calls = 0;
  const service = {
    ...createFakeService(),
    dreamsRun: async () => {
      calls += 1;
      return {
        phase: "rem",
        dryRun: false,
        durationMs: 0,
        itemsProcessed: 0,
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/dreams/run`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phase: "rem", dryRun: "false" }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, /dryRun must be a boolean/);
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("access HTTP dreams run rejects non-string namespace without invoking service", async () => {
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
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/dreams/run`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ phase: "deepSleep", namespace: 123 }),
    });

    assert.equal(response.status, 400);
    const payload = await response.json() as { error: string };
    assert.match(payload.error, /namespace must be a string/);
    assert.equal(calls, 0);
  } finally {
    await server.stop();
  }
});

test("access HTTP dreams run consumes the write rate limit for live runs", async () => {
  const service = {
    ...createFakeService(),
    dreamsRun: async ({ phase, dryRun }: { phase: string; dryRun?: boolean }) => ({
      phase,
      dryRun: dryRun === true,
      durationMs: 1,
      itemsProcessed: 1,
    }),
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  };

  try {
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/dreams/run`, {
        method: "POST",
        headers,
        body: JSON.stringify({ phase: "lightSleep" }),
      });
      assert.equal(response.status, 200);
    }

    const preview = await fetch(`${base}/engram/v1/dreams/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "lightSleep", dryRun: true }),
    });
    assert.equal(preview.status, 200);

    const limited = await fetch(`${base}/engram/v1/dreams/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ phase: "lightSleep" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server rejects invalid trust-zone browse filters", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = { Authorization: "Bearer secret-token" };

  try {
    const cases = [
      {
        query: "zone=bogus",
        error: "zone must be one of quarantine|working|trusted",
      },
      {
        query: "kind=bogus",
        error: "kind must be one of memory|artifact|state|trajectory|external",
      },
      {
        query: "sourceClass=bogus",
        error: "sourceClass must be one of tool_output|web_content|subagent_trace|system_memory|user_input|manual",
      },
    ];

    for (const testCase of cases) {
      const res = await fetch(`${base}/engram/v1/trust-zones/records?${testCase.query}`, { headers });
      assert.equal(res.status, 400);
      const payload = await res.json() as { error: string };
      assert.equal(payload.error, testCase.error);
    }
  } finally {
    await server.stop();
  }
});

test("access HTTP server rejects invalid trust-zone promote payloads without consuming the write rate limit", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    const invalidPayloads = [
      { targetZone: "trusted", promotionReason: "Operator approved" },
      { recordId: "tz-1", targetZone: "bogus", promotionReason: "Operator approved" },
      { recordId: "tz-1", targetZone: "trusted" },
    ];
    for (let index = 0; index < 40; index += 1) {
      const payload = invalidPayloads[index % invalidPayloads.length];
      const response = await fetch(`${base}/engram/v1/trust-zones/promote`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
    }

    const write = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A real write should still fit after invalid trust-zone promotions.",
        category: "fact",
      }),
    });
    assert.equal(write.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server resolves the admin console shell independently of cwd", async () => {
  const originalCwd = process.cwd();
  const tempCwd = await mkdtemp(path.join(os.tmpdir(), "engram-access-http-cwd-"));
  process.chdir(tempCwd);

  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });

  try {
    const started = await server.start();
    const base = `http://${started.host}:${started.port}`;
    const uiRes = await fetch(`${base}/engram/ui/`);
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.match(html, /Remnic Admin Console/);
  } finally {
    await server.stop();
    process.chdir(originalCwd);
    await rm(tempCwd, { recursive: true, force: true });
  }
});

test("access HTTP server returns an empty review queue payload with 200", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      reviewQueue: async () => ({ found: false }),
    } as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/review-queue`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { found: boolean };
    assert.equal(payload.found, false);
  } finally {
    await server.stop();
  }
});

test("access HTTP server forwards namespace query params to governance endpoints", async () => {
  const calls: Array<{ method: "reviewQueue" | "maintenance"; namespace?: string; runId?: string }> = [];
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      reviewQueue: async (runId?: string, namespace?: string) => {
        calls.push({ method: "reviewQueue", runId, namespace });
        return { found: true, namespace, runId: runId ?? "gov-1" };
      },
      maintenance: async (namespace?: string) => {
        calls.push({ method: "maintenance", namespace });
        return {
          namespace: namespace ?? "global",
          health: await createFakeService().health(),
          latestGovernanceRun: { found: true, namespace, runId: "gov-1" },
        };
      },
    } as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = { Authorization: "Bearer secret-token" };
    const queueResponse = await fetch(`${base}/engram/v1/review-queue?runId=gov-9&namespace=project-alpha`, { headers });
    assert.equal(queueResponse.status, 200);
    const maintenanceResponse = await fetch(`${base}/engram/v1/maintenance?namespace=project-alpha`, { headers });
    assert.equal(maintenanceResponse.status, 200);
    assert.deepEqual(calls, [
      { method: "reviewQueue", runId: "gov-9", namespace: "project-alpha" },
      { method: "maintenance", namespace: "project-alpha" },
    ]);
  } finally {
    await server.stop();
  }
});

test("access HTTP recall forwards include_low_confidence query flag", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const server = new EngramAccessHttpServer({
    service: {
      recall: async (request: Record<string, unknown>) => {
        captured.push(request);
        return {
          query: request.query,
          namespace: "global",
          context: "",
          count: 0,
          memoryIds: [],
          results: [],
          recordedAt: "2026-03-08T00:00:00.000Z",
          fallbackUsed: false,
          sourcesUsed: [],
          disclosure: "chunk",
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(
      `${base}/engram/v1/recall?include_low_confidence=true`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "diagnose graph traversal" }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.includeLowConfidence, true);
  } finally {
    await server.stop();
  }
});

test("access HTTP recall body includeLowConfidence wins over query flag", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const server = new EngramAccessHttpServer({
    service: {
      recall: async (request: Record<string, unknown>) => {
        captured.push(request);
        return {
          query: request.query,
          namespace: "global",
          context: "",
          count: 0,
          memoryIds: [],
          results: [],
          recordedAt: "2026-03-08T00:00:00.000Z",
          fallbackUsed: false,
          sourcesUsed: [],
          disclosure: "chunk",
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(
      `${base}/engram/v1/recall?include_low_confidence=true`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: "diagnose graph traversal",
          includeLowConfidence: false,
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.includeLowConfidence, undefined);
  } finally {
    await server.stop();
  }
});

test("access HTTP recall rejects invalid include_low_confidence query flag", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      recall: async () => ({
        query: "unused",
        namespace: "global",
        context: "",
        count: 0,
        memoryIds: [],
        results: [],
        recordedAt: "2026-03-08T00:00:00.000Z",
        fallbackUsed: false,
        sourcesUsed: [],
        disclosure: "chunk",
      }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(
      `${base}/engram/v1/recall?include_low_confidence=1`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "diagnose graph traversal" }),
      },
    );

    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /include_low_confidence/);
  } finally {
    await server.stop();
  }
});

test("access HTTP server rejects oversized JSON bodies", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 32,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/recall`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "x".repeat(200) }),
    });
    assert.equal(response.status, 413);
  } finally {
    await server.stop();
  }
});

test("access HTTP server rate-limits write endpoints", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: `A durable memory payload for write limiter coverage ${index}.`,
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }
    const limited = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A durable memory payload for rate-limit overflow.",
        category: "fact",
      }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for invalid requests", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      memoryStore: async ({ content }: { content: string }) => {
        if (content.trim().length === 0) {
          throw new EngramAccessInputError("content is required");
        }
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: false,
          accepted: true,
          queued: false,
          status: "stored",
          memoryId: "fact-new",
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: "   ",
          category: "fact",
        }),
      });
      assert.equal(response.status, 400);
    }

    const valid = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A durable explicit memory after invalid write attempts.",
        category: "fact",
      }),
    });
    assert.equal(valid.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for idempotency replays", async () => {
  const seenKeys = new Set<string>();
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      peekMemoryStoreIdempotency: async ({ idempotencyKey }: { idempotencyKey?: string }) =>
        idempotencyKey === "replay-key" ? "replay" : "miss",
      memoryStore: async ({ dryRun, idempotencyKey }: { dryRun?: boolean; idempotencyKey?: string }) => {
        const replay = Boolean(idempotencyKey && seenKeys.has(idempotencyKey));
        if (idempotencyKey) {
          seenKeys.add(idempotencyKey);
        }
        return {
          schemaVersion: 1,
          operation: "memory_store",
          namespace: "global",
          dryRun: dryRun === true,
          accepted: true,
          queued: false,
          status: dryRun === true ? "validated" : "stored",
          memoryId: dryRun === true ? undefined : "fact-new",
          idempotencyKey,
          idempotencyReplay: replay,
        };
      },
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: "replay-key",
          content: "A durable explicit memory retried with the same idempotency key.",
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }

    const freshWrite = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "fresh-key",
        content: "A fresh write should still fit inside the limiter budget after pure replays.",
        category: "fact",
      }),
    });
    assert.equal(freshWrite.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server allows idempotent replay writes even after the write limit is full", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      peekMemoryStoreIdempotency: async ({ idempotencyKey }: { idempotencyKey?: string }) =>
        idempotencyKey === "replay-key" ? "replay" : "miss",
      memoryStore: async ({ idempotencyKey }: { idempotencyKey?: string }) => ({
        schemaVersion: 1,
        operation: "memory_store",
        namespace: "global",
        dryRun: false,
        accepted: true,
        queued: false,
        status: "stored",
        memoryId: idempotencyKey === "replay-key" ? "fact-replay" : "fact-new",
        idempotencyKey,
        idempotencyReplay: idempotencyKey === "replay-key",
      }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          idempotencyKey: `fresh-${index}`,
          content: `A new write ${index}`,
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }

    const replay = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "replay-key",
        content: "This should bypass the pre-limit gate as a safe replay.",
        category: "fact",
      }),
    });
    assert.equal(replay.status, 201);

    const fresh = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        idempotencyKey: "fresh-overflow",
        content: "This should still be rate-limited.",
        category: "fact",
      }),
    });
    assert.equal(fresh.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for dry-run writes", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      peekMemoryStoreIdempotency: async () => "miss",
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 40; index += 1) {
      const preview = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          dryRun: true,
          content: `Preview ${index}`,
          category: "fact",
        }),
      });
      assert.equal(preview.status, 200);
    }

    const write = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A real write should still fit after repeated previews.",
        category: "fact",
      }),
    });
    assert.equal(write.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server allows dry-run writes even after the write limit is full", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      peekMemoryStoreIdempotency: async () => "miss",
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: `A new write ${index}`,
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }

    const preview = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        content: "This preview should bypass the full limiter window.",
        category: "fact",
      }),
    });
    assert.equal(preview.status, 200);

    const overflow = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "This real write should still be rate-limited.",
        category: "fact",
      }),
    });
    assert.equal(overflow.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server allows trust-zone dry runs even after the write limit is full", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService() as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(`${base}/engram/v1/memories`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          content: `A new write ${index}`,
          category: "fact",
        }),
      });
      assert.equal(response.status, 201);
    }

    const promotePreview = await fetch(`${base}/engram/v1/trust-zones/promote`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        recordId: "tz-1",
        targetZone: "trusted",
        promotionReason: "Preview after limiter saturation.",
        dryRun: true,
      }),
    });
    assert.equal(promotePreview.status, 200);

    const demoSeedPreview = await fetch(`${base}/engram/v1/trust-zones/demo-seed`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        scenario: "enterprise-buyer-v1",
        dryRun: true,
      }),
    });
    assert.equal(demoSeedPreview.status, 200);

    const overflow = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "This real write should still be rate-limited.",
        category: "fact",
      }),
    });
    assert.equal(overflow.status, 429);
  } finally {
    await server.stop();
  }
});

test("access HTTP server does not consume the write rate limit for replayed review dispositions", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      reviewDisposition: async ({ memoryId, status }: { memoryId: string; status: string }) => ({
        ok: true,
        namespace: "global",
        memoryId,
        status,
        previousStatus: "pending_review",
        idempotencyReplay: true,
      }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };
    for (let index = 0; index < 40; index += 1) {
      const response = await fetch(`${base}/engram/v1/review-disposition`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          memoryId: "fact-1",
          status: "active",
          reasonCode: `replay-${index}`,
        }),
      });
      assert.equal(response.status, 200);
    }

    const write = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        content: "A real write should still fit after replayed review dispositions.",
        category: "fact",
      }),
    });
    assert.equal(write.status, 201);
  } finally {
    await server.stop();
  }
});

test("access HTTP server binds namespace write authorization to its configured principal", async () => {
  const service = new EngramAccessService({
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: true,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [
        {
          name: "project-x",
          readPrincipals: ["project-x"],
          writePrincipals: ["project-x"],
        },
        {
          name: "secret-team",
          readPrincipals: ["secret-team"],
          writePrincipals: ["secret-team"],
        },
      ],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({
      getMemoryById: async () => null,
      getMemoryTimeline: async () => [],
    }),
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);

  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  };

  const rejectServer = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "project-x",
    maxBodyBytes: 1024,
  });
  const rejectStarted = await rejectServer.start();
  const rejectBase = `http://${rejectStarted.host}:${rejectStarted.port}`;

  try {
    const rejected = await fetch(`${rejectBase}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        sessionKey: "agent:secret-team:chat",
        namespace: "secret-team",
        content: "Body sessionKey should not grant secret-team writes.",
        category: "fact",
      }),
    });
    assert.equal(rejected.status, 400);
    const payload = await rejected.json() as { error: string };
    assert.equal(payload.error, "namespace is not writable: secret-team");
  } finally {
    await rejectServer.stop();
  }

  const allowServer = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "secret-team",
    maxBodyBytes: 1024,
  });
  const allowStarted = await allowServer.start();
  const allowBase = `http://${allowStarted.host}:${allowStarted.port}`;

  try {
    const allowed = await fetch(`${allowBase}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        schemaVersion: 1,
        dryRun: true,
        sessionKey: "agent:project-x:chat",
        namespace: "secret-team",
        content: "Configured transport principal should authorize this dry run.",
        category: "fact",
      }),
    });
    assert.equal(allowed.status, 200);
    const payload = await allowed.json() as { status: string; namespace: string };
    assert.equal(payload.status, "validated");
    assert.equal(payload.namespace, "secret-team");
  } finally {
    await allowServer.stop();
  }
});

test("access HTTP server binds namespace browse authorization to its configured principal", async () => {
  let capturedNamespace: unknown;
  let capturedPrincipal: unknown;
  const service = {
    ...createFakeService(),
    memoryBrowse: async (request: Record<string, unknown>) => {
      capturedNamespace = request.namespace;
      capturedPrincipal = request.authenticatedPrincipal;
      return {
        namespace: request.namespace ?? "global",
        sort: "updated_desc",
        total: 0,
        count: 0,
        limit: request.limit,
        offset: request.offset,
        memories: [],
      };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    principal: "secret-team",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/memories?namespace=secret-team&limit=3`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(capturedNamespace, "secret-team");
    assert.equal(capturedPrincipal, "secret-team");
  } finally {
    await server.stop();
  }
});

test("access HTTP server returns 400 for empty recall query", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      recall: async ({ query }: { query: string }) => {
        if (query.trim().length === 0) throw new EngramAccessInputError("query is required");
        return { query, context: "ctx", count: 0, memoryIds: [] };
      },
      health: async () => ({ ok: true }),
      recallExplain: async () => ({ found: false }),
      memoryGet: async () => ({ found: false, namespace: "global" }),
      memoryTimeline: async () => ({ found: false, namespace: "global", count: 0, timeline: [] }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const response = await fetch(`${base}/engram/v1/recall`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "   " }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.equal(body.error, "query is required");
  } finally {
    await server.stop();
  }
});

test("access HTTP server exposes MCP JSON-RPC endpoint at /mcp", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
    citationsEnabled: false,
    citationsAutoDetect: false,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };

    // initialize handshake
    const initRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "codex-test", version: "0.1.0" },
        },
      }),
    });
    assert.equal(initRes.status, 200);
    const initPayload = await initRes.json() as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    assert.equal(initPayload.jsonrpc, "2.0");
    assert.equal(initPayload.id, 1);
    assert.equal(initPayload.result.protocolVersion, "2024-11-05");
    assert.equal(initPayload.result.serverInfo.name, "remnic");

    // list tools
    const toolsRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });
    assert.equal(toolsRes.status, 200);
    const toolsPayload = await toolsRes.json() as {
      result: { tools: Array<{ name: string }> };
    };
    const toolNames = toolsPayload.result.tools.map((t) => t.name);
    assert.ok(toolNames.includes("remnic.recall"));
    assert.ok(toolNames.includes("remnic.memory_store"));
    assert.ok(toolNames.includes("remnic.entity_get"));
    assert.ok(toolNames.includes("engram.recall"));

    // call remnic.recall tool
    const callRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "remnic.recall",
          arguments: { query: "what did we decide?" },
        },
      }),
    });
    assert.equal(callRes.status, 200);
    const callPayload = await callRes.json() as {
      result: { isError: boolean; structuredContent: { context: string } };
    };
    assert.equal(callPayload.result.isError, false);
    assert.equal(callPayload.result.structuredContent.context, "memory context");

    // notifications return 202 (no response body)
    const notifRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    assert.equal(notifRes.status, 202);

    // requires auth
    const noAuthRes = await fetch(`${base}/mcp`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" }),
    });
    assert.equal(noAuthRes.status, 401);
  } finally {
    await server.stop();
  }
});

test("access HTTP MCP calls default to adapter namespace and session key", async () => {
  const captured: Array<{ namespace?: string; sessionKey?: string; principal?: string }> = [];
  const service = createFakeService();
  service.recall = async ({ query, namespace, sessionKey, authenticatedPrincipal }) => {
    captured.push({ namespace, sessionKey, principal: authenticatedPrincipal });
    return {
      query,
      sessionKey,
      namespace: namespace ?? "global",
      context: "memory context",
      count: 0,
      memoryIds: [],
      results: [],
      recordedAt: "2026-03-08T00:00:00.000Z",
      traceId: "trace-mcp-adapter-defaults",
      plannerMode: "full",
      fallbackUsed: false,
      sourcesUsed: [],
      budgetsApplied: {
        appliedTopK: 0,
        recallBudgetChars: 8000,
        maxMemoryTokens: 2000,
      },
      latencyMs: 1,
    };
  };
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
    citationsEnabled: false,
    citationsAutoDetect: false,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "Mcp-Session-Id": "mcp-session-123",
        "X-Engram-Client-Id": "replit",
        "X-Engram-Namespace": "project-a",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "remnic.recall",
          arguments: { query: "what did we decide?" },
        },
      }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(captured, [
      {
        namespace: "project-a",
        sessionKey: "mcp-session-123",
        principal: "replit-agent",
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("access HTTP server rate-limits MCP write tool calls", async () => {
  const server = new EngramAccessHttpServer({
    service: {
      ...createFakeService(),
      dreamsRun: async ({ phase, dryRun }: { phase: string; dryRun?: boolean }) => ({
        phase,
        dryRun: dryRun === true,
        durationMs: 1,
        itemsProcessed: 1,
      }),
      memoryActionApply: async ({ dryRun }: { dryRun?: boolean }) => ({
        recorded: dryRun !== true,
        dryRun: dryRun === true,
      }),
    } as unknown as EngramAccessService,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 4096,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;

  try {
    const headers = {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    };

    // Exhaust the write rate limit via MCP memory_store calls
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: i + 10,
          method: "tools/call",
          params: {
            name: "engram.memory_store",
            arguments: { content: `memory ${i}` },
          },
        }),
      });
      assert.equal(res.status, 200);
    }

    // 31st write should be rate-limited
    const limited = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "tools/call",
        params: {
          name: "engram.memory_store",
          arguments: { content: "overflow" },
        },
      }),
    });
    assert.equal(limited.status, 429);

    const previewDreamsRun = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1002,
        method: "tools/call",
        params: {
          name: "engram.dreams_run",
          arguments: { phase: "lightSleep", dryRun: true },
        },
      }),
    });
    assert.equal(previewDreamsRun.status, 200);
    const previewPayload = await previewDreamsRun.json() as {
      result: { structuredContent: { dryRun: boolean } };
    };
    assert.equal(previewPayload.result.structuredContent.dryRun, true);

    const previewMemoryAction = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1004,
        method: "tools/call",
        params: {
          name: "engram.memory_action_apply",
          arguments: { action: "store_note", dryRun: true },
        },
      }),
    });
    assert.equal(previewMemoryAction.status, 200);
    const previewMemoryActionPayload = await previewMemoryAction.json() as {
      result: { structuredContent: { dryRun: boolean } };
    };
    assert.equal(previewMemoryActionPayload.result.structuredContent.dryRun, true);

    const limitedMemoryAction = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1005,
        method: "tools/call",
        params: {
          name: "engram.memory_action_apply",
          arguments: { action: "store_note" },
        },
      }),
    });
    assert.equal(limitedMemoryAction.status, 429);

    const limitedDreamsRun = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1001,
        method: "tools/call",
        params: {
          name: "engram.dreams_run",
          arguments: { phase: "lightSleep" },
        },
      }),
    });
    assert.equal(limitedDreamsRun.status, 429);

    const limitedCapsuleExport = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1003,
        method: "tools/call",
        params: {
          name: "remnic.capsule_export",
          arguments: { name: "overflow-capsule" },
        },
      }),
    });
    assert.equal(limitedCapsuleExport.status, 429);

    // Read-only MCP calls should still work
    const recallRes = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1000,
        method: "tools/call",
        params: {
          name: "engram.recall",
          arguments: { query: "test" },
        },
      }),
    });
    assert.equal(recallRes.status, 200);
  } finally {
    await server.stop();
  }
});

test("access HTTP server returns 400 for explicit-capture validation errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-access-http-validation-"));
  const storage = new StorageManager(memoryDir);
  const service = new EngramAccessService({
    config: {
      memoryDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => storage,
    getLastIntentSnapshot: async () => null,
    getLastGraphRecallSnapshot: async () => null,
  } as any);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
    maxBodyBytes: 1024,
  });
  const started = await server.start();
  const base = `http://${started.host}:${started.port}`;
  const headers = {
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  };

  try {
    const memoryResponse = await fetch(`${base}/engram/v1/memories`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Validation should fail on invalid confidence.",
        category: "fact",
        confidence: 2,
      }),
    });
    assert.equal(memoryResponse.status, 400);
    const memoryPayload = await memoryResponse.json() as { error: string; code: string; details?: Array<{ field: string; message: string }> };
    assert.equal(memoryPayload.code, "validation_error");
    assert.ok(memoryPayload.details?.some(d => d.field.includes("confidence")), `Expected confidence validation error, got: ${JSON.stringify(memoryPayload.details)}`);

    const suggestionResponse = await fetch(`${base}/engram/v1/suggestions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "Suggestion validation should also fail on invalid confidence.",
        category: "fact",
        confidence: 2,
      }),
    });
    assert.equal(suggestionResponse.status, 400);
    const suggestionPayload = await suggestionResponse.json() as { error: string; code: string; details?: Array<{ field: string; message: string }> };
    assert.equal(suggestionPayload.code, "validation_error");
    assert.ok(suggestionPayload.details?.some(d => d.field.includes("confidence")), `Expected confidence validation error, got: ${JSON.stringify(suggestionPayload.details)}`);
  } finally {
    await server.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
