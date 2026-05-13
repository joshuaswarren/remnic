import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../packages/remnic-core/src/config.ts";

test("parseConfig defaults the new OpenClaw runtime-surface settings", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });

  assert.deepEqual(cfg.slotBehavior, {
    requireExclusiveMemorySlot: true,
    onSlotMismatch: "error",
  });
  assert.equal(cfg.beforeResetTimeoutMs, 2000);
  assert.equal(cfg.flushOnResetEnabled, true);
  assert.equal(cfg.commandsListEnabled, true);
  assert.equal(cfg.openclawToolsEnabled, true);
  assert.equal(cfg.openclawToolSnippetMaxChars, 600);
  assert.equal(cfg.sessionTogglesEnabled, true);
  assert.equal(cfg.verboseRecallVisibility, true);
  assert.equal(cfg.recallTranscriptsEnabled, false);
  assert.equal(cfg.recallTranscriptRetentionDays, 30);
  assert.equal(cfg.respectBundledActiveMemoryToggle, true);
  assert.equal(cfg.activeRecallEnabled, false);
  assert.equal(cfg.activeRecallAgents, null);
  assert.deepEqual(cfg.activeRecallAllowedChatTypes, ["direct", "group", "channel"]);
  assert.equal(cfg.activeRecallQueryMode, "recent");
  assert.equal(cfg.activeRecallPromptStyle, "balanced");
  assert.equal(cfg.activeRecallCustomInstruction, null);
  assert.equal(cfg.activeRecallPromptAppend, null);
  assert.equal(cfg.activeRecallMaxSummaryChars, 220);
  assert.equal(cfg.activeRecallRecentUserTurns, 2);
  assert.equal(cfg.activeRecallRecentAssistantTurns, 1);
  assert.equal(cfg.activeRecallRecentUserChars, 600);
  assert.equal(cfg.activeRecallRecentAssistantChars, 400);
  assert.equal(cfg.activeRecallThinking, "low");
  assert.equal(cfg.activeRecallTimeoutMs, 15000);
  assert.equal(cfg.activeRecallCacheTtlMs, 15000);
  assert.equal(cfg.activeRecallModel, null);
  assert.equal(cfg.activeRecallModelFallbackPolicy, "default-remote");
  assert.equal(cfg.activeRecallPersistTranscripts, false);
  assert.equal(cfg.activeRecallTranscriptDir, "active-recall");
  assert.equal(cfg.activeRecallEntityGraphDepth, 1);
  assert.equal(cfg.activeRecallIncludeCausalTrajectories, false);
  assert.equal(cfg.activeRecallIncludeDaySummary, false);
  assert.equal(cfg.activeRecallAttachRecallExplain, false);
  assert.equal(cfg.activeRecallAllowChainedActiveMemory, false);
  assert.deepEqual(cfg.dreaming, {
    enabled: false,
    journalPath: "DREAMS.md",
    maxEntries: 500,
    injectRecentCount: 3,
    minIntervalMinutes: 120,
    narrativeModel: null,
    narrativePromptStyle: "reflective",
    watchFile: true,
  });
  assert.deepEqual(cfg.heartbeat, {
    enabled: false,
    journalPath: "HEARTBEAT.md",
    maxPreviousRuns: 5,
    watchFile: true,
    detectionMode: "auto",
    gateExtractionDuringHeartbeat: true,
  });
  assert.deepEqual(cfg.codexCompat, {
    enabled: false,
    threadIdBufferKeying: true,
    compactionFlushMode: "auto",
    fingerprintDedup: true,
  });
});

test("parseConfig preserves explicit disables, rejects invalid dreaming minima, and clamps timeout bounds", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    slotBehavior: {
      requireExclusiveMemorySlot: false,
      onSlotMismatch: "silent",
    },
    beforeResetTimeoutMs: 25,
    flushOnResetEnabled: false,
    commandsListEnabled: false,
    openclawToolsEnabled: false,
    openclawToolSnippetMaxChars: 40,
    sessionTogglesEnabled: false,
    verboseRecallVisibility: false,
    recallTranscriptsEnabled: true,
    recallTranscriptRetentionDays: 1000,
    respectBundledActiveMemoryToggle: false,
    activeRecallEnabled: true,
    activeRecallAgents: ["main", "", "researcher"],
    activeRecallAllowedChatTypes: ["group", "invalid", "direct"],
    activeRecallQueryMode: "full",
    activeRecallPromptStyle: "precision-heavy",
    activeRecallCustomInstruction: "  always cite memories  ",
    activeRecallPromptAppend: "  append this  ",
    activeRecallMaxSummaryChars: 10,
    activeRecallRecentUserTurns: 99,
    activeRecallRecentAssistantTurns: -1,
    activeRecallRecentUserChars: 10,
    activeRecallRecentAssistantChars: 5000,
    activeRecallThinking: "xhigh",
    activeRecallTimeoutMs: 100,
    activeRecallCacheTtlMs: 999999,
    activeRecallModel: "  gpt-5.2-mini  ",
    activeRecallModelFallbackPolicy: "resolved-only",
    activeRecallPersistTranscripts: true,
    activeRecallTranscriptDir: "  nested/active-recall  ",
    activeRecallEntityGraphDepth: 99,
    activeRecallIncludeCausalTrajectories: true,
    activeRecallIncludeDaySummary: true,
    activeRecallAttachRecallExplain: true,
    activeRecallAllowChainedActiveMemory: true,
    dreaming: {
      enabled: true,
      journalPath: "notes/DREAMS.md",
      maxEntries: 5,
      injectRecentCount: 99,
      minIntervalMinutes: 0,
      narrativeModel: "  gpt-5.2-mini  ",
      narrativePromptStyle: "diary",
      watchFile: false,
    },
    heartbeat: {
      enabled: true,
      journalPath: "ops/HEARTBEAT.md",
      maxPreviousRuns: 99,
      watchFile: false,
      detectionMode: "heuristic",
      gateExtractionDuringHeartbeat: false,
    },
    codexCompat: {
      enabled: false,
      threadIdBufferKeying: false,
      compactionFlushMode: "heuristic",
      fingerprintDedup: false,
    },
  });

  assert.deepEqual(cfg.slotBehavior, {
    requireExclusiveMemorySlot: false,
    onSlotMismatch: "silent",
  });
  assert.equal(cfg.beforeResetTimeoutMs, 100);
  assert.equal(cfg.flushOnResetEnabled, false);
  assert.equal(cfg.commandsListEnabled, false);
  assert.equal(cfg.openclawToolsEnabled, false);
  assert.equal(cfg.openclawToolSnippetMaxChars, 80);
  assert.equal(cfg.sessionTogglesEnabled, false);
  assert.equal(cfg.verboseRecallVisibility, false);
  assert.equal(cfg.recallTranscriptsEnabled, true);
  assert.equal(cfg.recallTranscriptRetentionDays, 365);
  assert.equal(cfg.respectBundledActiveMemoryToggle, false);
  assert.equal(cfg.activeRecallEnabled, true);
  assert.deepEqual(cfg.activeRecallAgents, ["main", "researcher"]);
  assert.deepEqual(cfg.activeRecallAllowedChatTypes, ["group", "direct"]);
  assert.equal(cfg.activeRecallQueryMode, "full");
  assert.equal(cfg.activeRecallPromptStyle, "precision-heavy");
  assert.equal(cfg.activeRecallCustomInstruction, "always cite memories");
  assert.equal(cfg.activeRecallPromptAppend, "append this");
  assert.equal(cfg.activeRecallMaxSummaryChars, 40);
  assert.equal(cfg.activeRecallRecentUserTurns, 4);
  assert.equal(cfg.activeRecallRecentAssistantTurns, 0);
  assert.equal(cfg.activeRecallRecentUserChars, 40);
  assert.equal(cfg.activeRecallRecentAssistantChars, 1000);
  assert.equal(cfg.activeRecallThinking, "xhigh");
  assert.equal(cfg.activeRecallTimeoutMs, 250);
  assert.equal(cfg.activeRecallCacheTtlMs, 120000);
  assert.equal(cfg.activeRecallModel, "gpt-5.2-mini");
  assert.equal(cfg.activeRecallModelFallbackPolicy, "resolved-only");
  assert.equal(cfg.activeRecallPersistTranscripts, true);
  assert.equal(cfg.activeRecallTranscriptDir, "nested/active-recall");
  assert.equal(cfg.activeRecallEntityGraphDepth, 3);
  assert.equal(cfg.activeRecallIncludeCausalTrajectories, true);
  assert.equal(cfg.activeRecallIncludeDaySummary, true);
  assert.equal(cfg.activeRecallAttachRecallExplain, true);
  assert.equal(cfg.activeRecallAllowChainedActiveMemory, true);
  assert.deepEqual(cfg.dreaming, {
    enabled: true,
    journalPath: "notes/DREAMS.md",
    maxEntries: 500,
    injectRecentCount: 20,
    minIntervalMinutes: 1,
    narrativeModel: "gpt-5.2-mini",
    narrativePromptStyle: "diary",
    watchFile: false,
  });
  assert.deepEqual(cfg.heartbeat, {
    enabled: true,
    journalPath: "ops/HEARTBEAT.md",
    maxPreviousRuns: 20,
    watchFile: false,
    detectionMode: "heuristic",
    gateExtractionDuringHeartbeat: false,
  });
  assert.deepEqual(cfg.codexCompat, {
    enabled: false,
    threadIdBufferKeying: false,
    compactionFlushMode: "heuristic",
    fingerprintDedup: false,
  });
});

test("parseConfig preserves legacy active-recall custom instruction config", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    activeRecallPromptOverride: "  legacy guidance  ",
  });

  assert.equal(cfg.activeRecallCustomInstruction, "legacy guidance");
});

test("parseConfig keeps explicit small positive cache ttls and rejects negative dream disables", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    activeRecallCacheTtlMs: 500,
    dreaming: {
      maxEntries: -5,
    },
  });

  assert.equal(cfg.activeRecallCacheTtlMs, 500);
  assert.equal(cfg.dreaming.maxEntries, 500);
});

test("parseConfig preserves disabled entity synthesis and clamps tiny positive budgets to the first usable range", () => {
  const disabled = parseConfig({
    openaiApiKey: "sk-test",
    entitySynthesisMaxTokens: 0,
  });
  const clamped = parseConfig({
    openaiApiKey: "sk-test",
    entitySynthesisMaxTokens: 5,
  });
  const preserved = parseConfig({
    openaiApiKey: "sk-test",
    entitySynthesisMaxTokens: 120,
  });

  assert.equal(disabled.entitySynthesisMaxTokens, 0);
  assert.equal(clamped.entitySynthesisMaxTokens, 10);
  assert.equal(preserved.entitySynthesisMaxTokens, 120);
});

test("parseConfig preserves explicit low active recall thinking mode", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    activeRecallThinking: "low",
  });

  assert.equal(cfg.activeRecallThinking, "low");
});
