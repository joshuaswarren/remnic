import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";

test("custom recallPipeline reorders sections and can disable transcript injection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: false,
    knowledgeIndexEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: true,
    hourlySummariesEnabled: true,
    injectQuestions: true,
    recallPipeline: [
      { id: "questions", enabled: true },
      { id: "profile", enabled: true },
      { id: "summaries", enabled: true },
      { id: "transcript", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).storageRouter = {
    storageFor: async () => ({
      readProfile: async () => "Prefers concise, direct responses.",
      readQuestions: async () => [
        {
          id: "q-1",
          question: "Should we split this into smaller PR slices?",
          context: "Recent review cadence has been slow.",
          priority: 0.9,
          created: new Date().toISOString(),
          status: "open",
        },
      ],
    }),
  };

  (orchestrator as any).summarizer = {
    readRecent: async () => [{ summary: "Summary body", hour: "2026-02-28T19:00:00.000Z" }],
    formatForRecall: () => "## Hourly Summaries\n\n- Summary body",
  };

  (orchestrator as any).transcript = {
    loadCheckpoint: async () => ({ turns: [{ role: "user", content: "TRANSCRIPT_SHOULD_NOT_APPEAR" }] }),
    clearCheckpoint: async () => undefined,
    readRecent: async () => [{ role: "user", content: "TRANSCRIPT_SHOULD_NOT_APPEAR" }],
    formatForRecall: () => "TRANSCRIPT_SHOULD_NOT_APPEAR",
  };

  const context = await (orchestrator as any).recallInternal(
    "What did we decide about slicing PRs?",
    "user:test:recall-pipeline",
  );

  const qIndex = context.indexOf("## Open Question");
  const pIndex = context.indexOf("## User Profile");
  const sIndex = context.indexOf("## Hourly Summaries");

  assert.equal(qIndex >= 0, true);
  assert.equal(pIndex >= 0, true);
  assert.equal(sIndex >= 0, true);
  assert.equal(qIndex < pIndex, true);
  assert.equal(pIndex < sIndex, true);
  assert.equal(context.includes("TRANSCRIPT_SHOULD_NOT_APPEAR"), false);
});

test("disabled explicit-cue pipeline section skips LCM cue retrieval work", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: false,
    knowledgeIndexEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    explicitCueRecallEnabled: true,
    lcmEnabled: true,
    recallPipeline: [
      { id: "explicit-cue", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async () => {
      throw new Error("explicit cue search should not run");
    },
    expandContext: async () => {
      throw new Error("explicit cue expansion should not run");
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What happened at Turn 450?",
    "user:test:recall-pipeline",
  );

  assert.equal(context, "");
});

test("event-order and response-guidance pipeline sections are assembled from LCM", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const sessionId = "user:test:specialized-recall";
  const messages = [
    {
      turn_index: 10,
      role: "user",
      content:
        "My culinary journey started with Turkish, Greek, and Lebanese cuisines, then I practiced knife techniques, dough kneading, sauce emulsification, Italian and Indian dishes, and spice blend mastery.",
    },
    {
      turn_index: 20,
      role: "assistant",
      content:
        "A structured month-by-month cooking plan emphasized research, ingredient preparation, cooking practice, feedback gathering, and documentation.",
    },
  ];
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    sharedContextEnabled: false,
    knowledgeIndexEnabled: false,
    identityContinuityEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    lcmEnabled: true,
    recallPipeline: [
      { id: "event-order", enabled: true, maxChars: 2_400, maxResults: 8, maxTurns: 16, maxTokens: 6_000 },
      { id: "response-guidance", enabled: true, maxChars: 2_400, maxResults: 8, maxTurns: 16, maxTokens: 6_000 },
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_query: string, limit: number, requestedSessionId?: string) =>
      requestedSessionId === sessionId
        ? messages.slice(0, limit).map((message, index) => ({
            id: index,
            session_id: sessionId,
            turn_index: message.turn_index,
            role: message.role,
            content: message.content,
            score: 100 - index,
          }))
        : [],
    expandContext: async (
      requestedSessionId: string,
      fromTurn: number,
      toTurn: number,
    ) =>
      requestedSessionId === sessionId
        ? messages.filter(
            (message) =>
              message.turn_index >= fromTurn && message.turn_index <= toTurn,
          )
        : [],
    getStats: async (requestedSessionId?: string) =>
      requestedSessionId === sessionId
        ? { totalMessages: messages.length, maxTurnIndex: 20 }
        : { totalMessages: 0, maxTurnIndex: -1 },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "Can you walk me through in chronological order how my culinary journey has progressed, highlighting key milestones, skill developments, and strategies I've used to stay on track?",
    sessionId,
  );

  const eventIndex = context.indexOf("## Chronological event evidence");
  const guidanceIndex = context.indexOf("## Response guidance evidence");
  assert.equal(eventIndex >= 0, true);
  assert.equal(guidanceIndex >= 0, true);
  assert.equal(eventIndex < guidanceIndex, true);
  assert.match(context, /culinary journey started with Turkish, Greek, and Lebanese cuisines/);
  assert.match(context, /structured month-by-month plan/);
});
