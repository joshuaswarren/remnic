import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PluginConfig } from "../src/types.js";
import { SharedContextManager } from "../src/shared-context/manager.js";

function tmpDir(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function minimalConfig(memoryDir: string, sharedContextDir: string): PluginConfig {
  // Tests only rely on a few config fields; fill required PluginConfig shape.
  return {
    openaiApiKey: undefined,
    model: "gpt-5.5",
    reasoningEffort: "low",
    triggerMode: "smart",
    bufferMaxTurns: 5,
    bufferMaxMinutes: 15,
    consolidateEveryN: 3,
    highSignalPatterns: [],
    maxMemoryTokens: 2000,
    qmdEnabled: false,
    qmdCollection: "openclaw-engram",
    qmdMaxResults: 8,
    memoryDir,
    debug: false,
    identityEnabled: false,
    identityContinuityEnabled: false,
    identityInjectionMode: "recovery_only",
    identityMaxInjectChars: 1200,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: false,
    injectQuestions: false,
    commitmentDecayDays: 90,
    workspaceDir: path.join(memoryDir, "workspace"),
    accessTrackingEnabled: false,
    accessTrackingBufferMaxSize: 100,
    recencyWeight: 0.2,
    boostAccessCount: true,
    queryExpansionEnabled: false,
    queryExpansionMaxQueries: 4,
    queryExpansionMinTokenLen: 3,
    rerankEnabled: false,
    rerankProvider: "local",
    rerankMaxCandidates: 10,
    rerankTimeoutMs: 1000,
    rerankCacheEnabled: true,
    rerankCacheTtlMs: 1000,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    negativeExamplesPenaltyPerHit: 0.05,
    negativeExamplesPenaltyCap: 0.25,
    chunkingEnabled: false,
    chunkingTargetTokens: 200,
    chunkingMinTokens: 150,
    chunkingOverlapSentences: 2,
    contradictionDetectionEnabled: false,
    contradictionSimilarityThreshold: 0.7,
    contradictionMinConfidence: 0.9,
    contradictionAutoResolve: true,
    memoryLinkingEnabled: false,
    threadingEnabled: false,
    threadingGapMinutes: 30,
    summarizationEnabled: false,
    summarizationTriggerCount: 1000,
    summarizationRecentToKeep: 300,
    summarizationImportanceThreshold: 0.3,
    summarizationProtectedTags: [],
    topicExtractionEnabled: false,
    topicExtractionTopN: 50,
    transcriptEnabled: false,
    transcriptRetentionDays: 7,
    transcriptSkipChannelTypes: ["cron"],
    transcriptRecallHours: 12,
    maxTranscriptTurns: 50,
    maxTranscriptTokens: 1000,
    checkpointEnabled: false,
    checkpointTurns: 15,
    hourlySummariesEnabled: false,
    hourlySummaryCronAutoRegister: false,
    summaryRecallHours: 24,
    maxSummaryCount: 6,
    summaryModel: "gpt-5.5",
    hourlySummariesExtendedEnabled: false,
    hourlySummariesIncludeToolStats: false,
    hourlySummariesIncludeSystemMessages: false,
    hourlySummariesMaxTurnsPerRun: 60,
    conversationIndexEnabled: false,
    conversationIndexBackend: "qmd",
    conversationIndexQmdCollection: "openclaw-engram-convo",
    conversationIndexRetentionDays: 14,
    conversationRecallTopK: 3,
    conversationRecallMaxChars: 2000,
    conversationRecallTimeoutMs: 500,
    localLlmEnabled: false,
    localLlmUrl: "http://localhost:1234/v1",
    localLlmModel: "local-model",
    localLlmFallback: true,
    localLlmTimeoutMs: 1000,
    slowLogEnabled: false,
    slowLogThresholdMs: 30_000,
    extractionDedupeEnabled: true,
    extractionDedupeWindowMs: 60_000,
    extractionMinChars: 20,
    extractionMinUserTurns: 1,
    extractionMaxTurnChars: 4000,
    extractionMaxFactsPerRun: 12,
    extractionMaxEntitiesPerRun: 6,
    extractionMaxQuestionsPerRun: 3,
    extractionMaxProfileUpdatesPerRun: 4,
    consolidationRequireNonZeroExtraction: true,
    consolidationMinIntervalMs: 60_000,
    qmdMaintenanceEnabled: true,
    qmdMaintenanceDebounceMs: 500,
    qmdAutoEmbedEnabled: false,
    qmdEmbedMinIntervalMs: 60_000,
    localLlmRetry5xxCount: 1,
    localLlmRetryBackoffMs: 50,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 10_000,
    namespacesEnabled: false,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [],
    namespacePolicies: [],
    defaultRecallNamespaces: ["self"],
    cronRecallMode: "all",
    cronRecallAllowlist: [],
    autoPromoteToSharedEnabled: false,
    autoPromoteToSharedCategories: ["correction"],
    autoPromoteMinConfidenceTier: "explicit",
    sharedContextEnabled: true,
    sharedContextDir,
    sharedContextMaxInjectChars: 4000,
    crossSignalsSemanticEnabled: false,
    crossSignalsSemanticTimeoutMs: 1000,
    compoundingEnabled: false,
    compoundingWeeklyCronEnabled: false,
    compoundingSemanticEnabled: false,
    compoundingSynthesisTimeoutMs: 1000,
    compoundingInjectEnabled: false,
  };
}

test("v4 shared context manager bootstraps structure and writes outputs", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  const priorities = await m.readPriorities();
  assert.match(priorities, /# Priorities/);

  const fp = await m.writeAgentOutput({
    agentId: "generalist",
    title: "Test Output",
    content: "Hello world",
  });
  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /kind: agent_output/);
  assert.match(raw, /Hello world/);
});

test("shared context output path encodes agent ids that contain traversal", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  const fp = await m.writeAgentOutput({
    agentId: "../../escape",
    title: "Traversal Attempt",
    content: "Hello world",
    createdAt: new Date("2026-05-19T10:11:12.000Z"),
  });

  const outputsRoot = path.join(sharedDir, "agent-outputs");
  const relativePath = path.relative(outputsRoot, fp);
  assert.equal(path.isAbsolute(relativePath), false);
  assert.notEqual(relativePath.split(path.sep)[0], "..");
  assert.match(relativePath, /^\.\.%2F\.\.%2Fescape\/2026-05-19\/101112-traversal-attempt\.md$/);

  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /agent: "\.\.\/\.\.\/escape"/);
});

test("shared context output rejects agent ids with line breaks", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  await assert.rejects(
    () => m.writeAgentOutput({
      agentId: "team\nred",
      title: "Invalid Agent",
      content: "Hello world",
    }),
    /agentId must not contain line breaks/,
  );
});

test("shared context output writes do not overwrite same-second same-title files", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();
  const createdAt = new Date("2026-05-19T10:11:12.000Z");

  const first = await m.writeAgentOutput({
    agentId: "generalist",
    title: "Same Title",
    content: "first",
    createdAt,
  });
  const second = await m.writeAgentOutput({
    agentId: "generalist",
    title: "Same Title",
    content: "second",
    createdAt,
  });

  assert.notEqual(first, second);
  assert.equal(await readFile(first, "utf-8"), [
    "---",
    "kind: agent_output",
    'agent: "generalist"',
    "createdAt: 2026-05-19T10:11:12.000Z",
    'title: "Same Title"',
    "---",
    "",
    "first",
    "",
  ].join("\n"));
  assert.match(await readFile(second, "utf-8"), /\nsecond\n$/);

  const files = await readdir(path.dirname(first));
  assert.deepEqual(files.sort(), ["101112-same-title-2.md", "101112-same-title.md"]);
});

test("shared context frontmatter preserves literal quote-wrapped agent ids and titles", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  const fp = await m.writeAgentOutput({
    agentId: '"research bot"',
    title: '"Quoted Title"',
    content: "quote boundary topic",
    createdAt: new Date("2026-05-19T10:11:12.000Z"),
  });

  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /agent: "\\"research bot\\""/);
  assert.match(raw, /title: "\\"Quoted Title\\""/);

  const result = await m.synthesizeCrossSignals({ date: "2026-05-19" });
  assert.deepEqual(result.report.sources.map((source) => source.agent), ['"research bot"']);
  assert.deepEqual(result.report.sources.map((source) => source.title), ['"Quoted Title"']);
});

test("shared context frontmatter preserves JSON-escaped control characters", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  const fp = await m.writeAgentOutput({
    agentId: "research\tbot",
    title: "Tabbed\tTitle",
    content: "control character topic",
    createdAt: new Date("2026-05-19T10:11:12.000Z"),
  });

  const raw = await readFile(fp, "utf-8");
  assert.match(raw, /agent: "research\\tbot"/);
  assert.match(raw, /title: "Tabbed\\tTitle"/);

  const result = await m.synthesizeCrossSignals({ date: "2026-05-19" });
  assert.deepEqual(result.report.sources.map((source) => source.agent), ["research\tbot"]);
  assert.deepEqual(result.report.sources.map((source) => source.title), ["Tabbed\tTitle"]);
});

test("cross signals preserve original agent ids from encoded output paths", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();
  const createdAt = new Date("2026-05-19T10:11:12.000Z");

  await m.writeAgentOutput({
    agentId: "research bot",
    title: "Encoded Path",
    content: "alignment topic",
    createdAt,
  });

  const legacyDir = path.join(sharedDir, "agent-outputs", "research bot", "2026-05-19");
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    path.join(legacyDir, "101113-legacy-path.md"),
    [
      "---",
      "kind: agent_output",
      'agent: "research bot"',
      "createdAt: 2026-05-19T10:11:13.000Z",
      "title: Legacy Path",
      "---",
      "",
      "alignment topic",
      "",
    ].join("\n"),
    "utf-8",
  );
  const encodedDir = path.join(sharedDir, "agent-outputs", "research%20bot", "2026-05-19");
  await writeFile(
    path.join(encodedDir, "101114-no-frontmatter.md"),
    "agent: spoofed body value\nalignment topic\n",
    "utf-8",
  );

  const result = await m.synthesizeCrossSignals({ date: "2026-05-19" });

  assert.deepEqual(
    result.report.sources.map((source) => source.agent).sort(),
    ["research bot", "research bot", "research bot"],
  );
  assert.equal(result.report.overlaps.length, 0);
});

test("cross signals collapse feedback markdown control text to one rendered line", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();

  await m.appendFeedback({
    agent: "reviewer\n## injected-agent",
    decision: "rejected",
    reason: "bad output\n## injected-heading\n- injected-list",
    date: "2026-05-19T12:00:00.000Z",
    refs: ["file-a.md\n- injected-ref"],
    severity: "high",
  });

  const result = await m.synthesizeCrossSignals({ date: "2026-05-19" });
  const markdown = await readFile(result.crossSignalsMarkdownPath, "utf-8");

  assert.doesNotMatch(markdown, /^## injected/m);
  assert.doesNotMatch(markdown, /^- injected/m);
  assert.match(
    markdown,
    /\[reviewer ## injected-agent\] rejected: bad output ## injected-heading - injected-list/,
  );
  assert.match(markdown, /refs: file-a\.md - injected-ref/);
});

test("cross signals process agent outputs in stable agent/path order", async () => {
  const memoryDir = tmpDir("engram-sc-mem");
  const sharedDir = tmpDir("engram-shared");
  await mkdir(memoryDir, { recursive: true });

  const cfg = minimalConfig(memoryDir, sharedDir);
  cfg.sharedCrossSignalSemanticEnabled = true;
  cfg.sharedCrossSignalSemanticMaxCandidates = 4;
  const m = new SharedContextManager(cfg);
  await m.ensureStructure();
  const createdAt = new Date("2026-05-19T10:11:12.000Z");

  await m.writeAgentOutput({
    agentId: "zeta",
    title: "Output",
    content: "planning",
    createdAt,
  });
  await m.writeAgentOutput({
    agentId: "alpha",
    title: "Output",
    content: "planner",
    createdAt,
  });

  const result = await m.synthesizeCrossSignals({ date: "2026-05-19" });

  assert.deepEqual(result.report.sources.map((source) => source.agent), ["alpha", "zeta"]);
  assert.ok(result.report.semantic.candidateCount <= 4);
  assert.ok(result.report.overlaps.some((overlap) => overlap.token.startsWith("semantic:")));
});
