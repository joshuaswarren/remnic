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

test("explicit response-guidance pipeline section recalls generic instructions for unclassified queries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const sessionId = "user:test:generic-response-guidance";
  const messages = [
    {
      turn_index: 4,
      role: "user",
      content:
        "User Instruction: Always answer espresso-code questions with short bullet points.",
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
      { id: "response-guidance", enabled: true, forceGeneric: true, maxChars: 1_500, maxResults: 4, maxTurns: 8, maxTokens: 2_000 },
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
        ? { totalMessages: messages.length, maxTurnIndex: 4 }
        : { totalMessages: 0, maxTurnIndex: -1 },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What do you remember about the espresso code?",
    sessionId,
  );

  assert.match(context, /## Response guidance evidence/);
  assert.match(context, /Always answer espresso-code questions with short bullet points/);
});

test("top-level response-guidance enable remains query-gated for unclassified queries", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-pipeline-"));
  const sessionId = "user:test:top-level-response-guidance";
  let searchCalls = 0;
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
    responseGuidanceRecallEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async () => {
      searchCalls += 1;
      return [];
    },
    expandContext: async () => [],
    getStats: async (requestedSessionId?: string) =>
      requestedSessionId === sessionId
        ? { totalMessages: 1, maxTurnIndex: 4 }
        : { totalMessages: 0, maxTurnIndex: -1 },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What do you remember about the espresso code?",
    sessionId,
  );

  assert.doesNotMatch(context, /## Response guidance evidence/);
  assert.equal(searchCalls, 0);
});

test("#1505 thread 3: ALL LCM recall sections read under the SCOPED (overlay) session key", async () => {
  // Round 1 wired only targeted-facts / structured / compressed-history to the
  // namespaced LCM read key (`lcmReadSessionId`). The explicit-cue, focused-list,
  // response-guidance, and event-order sections still passed the RAW `sessionKey`
  // to their LCM helpers, so a project-scoped session whose evidence is archived
  // under `${overlayNs}:${sessionKey}` would NEVER surface it through those
  // sections. This pins that EVERY LCM-backed section reads under the scoped key
  // (CLAUDE.md rule 39: identical across all paths).
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-thread3-"));
  const sessionId = "alice:proj-session";
  const projectId = "origin:abcd1234";

  const lcmQueriedSessionIds: string[] = [];
  // Resolved AFTER the orchestrator is constructed (the overlay namespace is
  // derived from the orchestrator's own `applyCodingNamespaceOverlay`, the source
  // of truth). Evidence is returned ONLY for the SCOPED key — if any section
  // queries the raw sessionId, that evidence is MISSING and the asserts fail.
  let scopedKey = "";
  const evidenceFor = (requestedSessionId?: string, limit = 8) => {
    lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
    return requestedSessionId === scopedKey
      ? [
          {
            id: 0,
            session_id: scopedKey,
            turn_index: 10,
            role: "user",
            content:
              "SCOPED_EVIDENCE: my culinary journey started with Turkish, Greek, and Lebanese cuisines.",
            score: 100,
          },
        ].slice(0, limit)
      : [];
  };

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
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    principalFromSessionKeyMode: "prefix",
    principalFromSessionKeyRules: [{ match: "alice:", principal: "alice" }],
    namespacePolicies: [
      { name: "alice", readPrincipals: ["alice"], writePrincipals: ["alice"] },
    ],
    defaultRecallNamespaces: ["self"],
    codingMode: { projectScope: true },
    // Enable the four sections that round 1 left on the raw key.
    explicitCueRecallEnabled: true,
    focusedListRecallEnabled: true,
    eventOrderRecallEnabled: true,
    recallPipeline: [
      { id: "event-order", enabled: true, maxChars: 2_400, maxResults: 8, maxTurns: 16, maxTokens: 6_000 },
      { id: "focused-list", enabled: true, maxChars: 2_400, maxResults: 8, maxTurns: 16, maxTokens: 6_000 },
      { id: "explicit-cue", enabled: true, maxChars: 2_400, maxResults: 8 },
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  // Bind the project coding context so the recall path overlays the namespace
  // exactly as a same-session project-scoped recall would.
  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: null,
    rootPath: projectId,
    defaultBranch: null,
  });
  // Derive the SCOPED LCM read key from the orchestrator's own overlay (source
  // of truth): the principal self base (alice) overlaid with the project.
  const overlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  assert.notEqual(overlayNs, "alice", "coding overlay must change the namespace");
  scopedKey = `${overlayNs}:${sessionId}`;

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_q: string, limit: number, requestedSessionId?: string) =>
      evidenceFor(requestedSessionId, limit),
    expandContext: async (requestedSessionId: string) =>
      requestedSessionId === scopedKey
        ? [
            {
              turn_index: 10,
              role: "user",
              content: "SCOPED_EVIDENCE: chronological milestone",
            },
          ]
        : [],
    getStats: async (requestedSessionId?: string) => {
      lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
      return requestedSessionId === scopedKey
        ? { totalMessages: 4, maxTurnIndex: 10 }
        : { totalMessages: 0, maxTurnIndex: -1 };
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  // A prompt that triggers the explicit-cue / focused-list / event-order gates
  // (chronological + list-shaped + cue phrasing).
  const context = await (orchestrator as any).recallInternal(
    "Remember when you told me to list, in chronological order, the cuisines I started my culinary journey with?",
    sessionId,
  );

  // The scoped key was queried, and the raw (un-prefixed) sessionId was NOT used
  // by any LCM section (otherwise evidence would be missing).
  assert.ok(
    lcmQueriedSessionIds.includes(scopedKey),
    `expected at least one LCM section to query the scoped key ${scopedKey}; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  assert.ok(
    !lcmQueriedSessionIds.includes(sessionId),
    `no LCM section may query the RAW sessionId ${sessionId}; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  // Evidence (only returned for the scoped key) made it into the assembled
  // context, proving the sections read under the scoped key.
  assert.match(context, /SCOPED_EVIDENCE/);
});
