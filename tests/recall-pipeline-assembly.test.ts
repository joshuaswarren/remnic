import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { Orchestrator } from "../src/orchestrator.js";
import { parseConfig } from "../src/config.js";
import { indexMemoryAsync as indexMemory } from "../packages/remnic-core/src/temporal-index.js";

// #1495 P1: the namespaced LCM `session_id` is framed with a reserved sentinel
// (U+001F UNIT SEPARATOR) — `\x1f<namespace>\x1f<sessionKey>` — kept in sync with
// `coding-namespace.ts:lcmSessionKeyForNamespace`. U+001F cannot occur in a
// route namespace (`[A-Za-z0-9._-]`) nor any legitimate session key, so the
// namespaced + default key-spaces are provably disjoint (unforgeable). Encoded
// locally here because `coding-namespace` is not exported from the package root
// (same reason `projectFallbackNamespace` reads the overlay back off the
// orchestrator instead of importing `combineNamespaces`).
const LCM_NS_SENTINEL = "\u001f";
function encodeNs(namespace: string, sessionKey: string): string {
  return `${LCM_NS_SENTINEL}${namespace}${LCM_NS_SENTINEL}${sessionKey}`;
}

/**
 * Derive the exact PROJECT-scope overlay namespace the orchestrator would use as
 * a branch session's read fallback, WITHOUT depending on `combineNamespaces`
 * (not exported from the package root). Binds a project-only coding context
 * (branch: null) to a throwaway session and reads back the orchestrator's own
 * `applyCodingNamespaceOverlay` result — the same source of truth the recall path
 * uses to build `codingOverlay.readFallbacks`.
 */
function projectFallbackNamespace(
  orchestrator: Orchestrator,
  base: string,
  projectId: string,
): string {
  const probeSession = `__probe__:${projectId}`;
  orchestrator.setCodingContextForSession(probeSession, {
    projectId,
    branch: null,
    rootPath: projectId,
    defaultBranch: null,
  });
  const ns = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(probeSession, base);
  orchestrator.setCodingContextForSession(probeSession, null);
  return ns;
}

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

test("event-order recall injects an ingest-indexed timeline across source sessions", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-cross-session-timeline-"));
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
    lcmEnabled: false,
    eventOrderRecallEnabled: true,
    recallPipeline: [
      { id: "event-order", enabled: true, maxChars: 2_400, maxResults: 8 },
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);
  const rome = await orchestrator.storage.writeMemory("fact", "Visited Rome in spring.", {
    validAt: "2026-05-10T00:00:00.000Z",
    observedAt: "2026-07-02T00:00:00.000Z",
    eventTimeSource: "extracted",
    sources: [{
      sessionKey: "session-b",
      observedAt: "2026-07-02T00:00:00.000Z",
      quote: "I visited Rome in spring.",
    }],
  });
  const paris = await orchestrator.storage.writeMemory("fact", "Visited Paris in winter.", {
    validAt: "2026-03-04T00:00:00.000Z",
    observedAt: "2026-07-03T00:00:00.000Z",
    eventTimeSource: "extracted",
    sources: [{
      sessionKey: "session-a",
      observedAt: "2026-07-03T00:00:00.000Z",
      quote: "I visited Paris in winter.",
    }],
  });
  await (orchestrator as any).updateTemporalTagIndexes(
    orchestrator.storage,
    [rome.id, paris.id],
  );

  const context = await (orchestrator as any).recallInternal(
    "Which trip happened first, Paris or Rome?",
    "session-current",
  );

  assert.match(context, /## Cross-session temporal timeline/);
  assert.ok(context.indexOf("Visited Paris") < context.indexOf("Visited Rome"));
  assert.match(context, /session=session-a/);
  assert.match(context, /session=session-b/);
});

test("event-order recall bounds large-index memory reads before injection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-bounded-timeline-"));
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
    lcmEnabled: false,
    eventOrderRecallEnabled: true,
    recallPipeline: [
      { id: "event-order", enabled: true, maxChars: 2_400, maxResults: 1 },
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);
  for (let i = 0; i < 600; i += 1) {
    const day = String((i % 28) + 1).padStart(2, "0");
    await indexMemory(
      memoryDir,
      path.join(memoryDir, "facts", `event-${String(i).padStart(4, "0")}.md`),
      `2026-03-${day}T00:00:00.000Z`,
      [],
      { validAt: `2026-03-${day}T00:00:00.000Z`, searchText: `routine event ${i}` },
    );
  }

  let readCalls = 0;
  (orchestrator.storage as any).readMemoryByPath = async (memoryPath: string) => {
    readCalls += 1;
    const id = path.basename(memoryPath, ".md");
    return {
      path: memoryPath,
      content: `Timeline body ${id}`,
      frontmatter: {
        id,
        category: "fact",
        created: "2026-03-01T00:00:00.000Z",
        updated: "2026-03-01T00:00:00.000Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
      },
    };
  };

  const context = await (orchestrator as any).recallInternal(
    "What happened first or last?",
    "session-current",
  );

  assert.match(context, /## Cross-session temporal timeline/);
  assert.equal(readCalls, 48, "maxResults=1 uses the bounded 48-row oversample, not all 600 rows");
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
  scopedKey = encodeNs(overlayNs, sessionId);

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

test("#1505 fallback: branch-scoped recall reads LCM evidence archived at PROJECT (fallback) scope", async () => {
  // Round 5 left the LCM read path targeting a SINGLE overlay key
  // (`${branch-ns}:${sessionKey}`). Normal QMD/file recall, however, also
  // searches `codingOverlay.readFallbacks` (project → root) so a branch-scoped
  // session still sees project/root memories. A session whose LCM rows were
  // archived at PROJECT scope (then later recalled from a branch) therefore had
  // its LCM-backed sections MISS that fallback transcript evidence even though
  // QMD/file recall would surface it. This pins that the LCM read now queries the
  // SAME ordered readable namespace set (primary overlay → project fallback), so
  // the project-scope evidence is found.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-fallback-"));
  const sessionId = "alice:branch-session";
  const projectId = "origin:proj9999";

  const lcmQueriedSessionIds: string[] = [];
  // Evidence is returned ONLY for the PROJECT-fallback key — never the branch
  // overlay key. A single-key (branch-only) LCM read would MISS it (fail-before);
  // querying across the readable set (branch → project fallback) finds it.
  let projectFallbackKey = "";
  let branchOverlayKey = "";
  const evidenceFor = (requestedSessionId?: string, limit = 8) => {
    lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
    return requestedSessionId === projectFallbackKey
      ? [
          {
            id: 0,
            session_id: projectFallbackKey,
            turn_index: 7,
            role: "user",
            content:
              "FALLBACK_EVIDENCE: my culinary journey started with Turkish, Greek, and Lebanese cuisines.",
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
    // Branch scope ON → project namespace becomes a read fallback.
    codingMode: { projectScope: true, branchScope: true },
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

  // Bind a coding context WITH a branch so the overlay is branch-scoped and the
  // project namespace becomes a read fallback.
  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/cuisines",
    rootPath: projectId,
    defaultBranch: "main",
  });
  // Derive the branch overlay key + project fallback key from the orchestrator's
  // own overlay (source of truth): the principal self base (alice) overlaid with
  // the branch namespace, and the project fallback combined with the same base.
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  assert.notEqual(branchOverlayNs, "alice", "branch overlay must change the namespace");
  const projectFallbackNs = projectFallbackNamespace(orchestrator, "alice", projectId);
  assert.notEqual(
    projectFallbackNs,
    branchOverlayNs,
    "project fallback namespace must differ from the branch overlay namespace",
  );
  branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  projectFallbackKey = encodeNs(projectFallbackNs, sessionId);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_q: string, limit: number, requestedSessionId?: string) =>
      evidenceFor(requestedSessionId, limit),
    expandContext: async (requestedSessionId: string) =>
      requestedSessionId === projectFallbackKey
        ? [
            {
              turn_index: 7,
              role: "user",
              content: "FALLBACK_EVIDENCE: chronological milestone",
            },
          ]
        : [],
    getStats: async (requestedSessionId?: string) => {
      lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
      return requestedSessionId === projectFallbackKey
        ? { totalMessages: 4, maxTurnIndex: 7 }
        : { totalMessages: 0, maxTurnIndex: -1 };
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "Remember when you told me to list, in chronological order, the cuisines I started my culinary journey with?",
    sessionId,
  );

  // The branch overlay key was tried FIRST (primary), then the project fallback
  // key — and the project-fallback evidence made it into the assembled context.
  assert.ok(
    lcmQueriedSessionIds.includes(branchOverlayKey),
    `expected the branch overlay key ${branchOverlayKey} to be queried first; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  assert.ok(
    lcmQueriedSessionIds.includes(projectFallbackKey),
    `expected the project fallback key ${projectFallbackKey} to be queried; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  // The raw (un-prefixed) sessionId must NOT be queried — only namespaced keys.
  assert.ok(
    !lcmQueriedSessionIds.includes(sessionId),
    `no LCM section may query the RAW sessionId ${sessionId}; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  assert.match(
    context,
    /FALLBACK_EVIDENCE/,
    "branch-scoped recall must surface LCM evidence archived at the project fallback scope",
  );
});

test("#1505 fallback read-auth: an unreadable principal self/overlay namespace is NEVER queried by the LCM read path", async () => {
  // The unification reuses `recallNamespaces`, which already gates the overlay by
  // read-authorization (`recallNamespacesForPrincipal` only includes the self
  // base when `defaultRecallNamespaces` includes "self" AND `canReadNamespace`).
  // When the self base is NOT in the readable recall set, the overlay key
  // (`${principal}-project-*`) must NEVER be searched by the LCM read path — no
  // cross-tenant read leak. Here `defaultRecallNamespaces` OMITS "self", so the
  // self base / its overlay are unreadable; only the explicitly-shared namespace
  // is readable, and the LCM read collapses to the default store (raw key).
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-readauth-"));
  const sessionId = "alice:writeonly-session";
  const projectId = "origin:secret1234";

  const lcmQueriedSessionIds: string[] = [];
  const evidenceFor = (requestedSessionId?: string, limit = 8) => {
    lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
    // Never serve overlay evidence — the point is to prove the overlay key is
    // never even QUERIED.
    return [] as Array<{
      id: number;
      session_id: string;
      turn_index: number;
      role: string;
      content: string;
      score: number;
    }>;
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
      // shared is readable by alice and included in recall by default.
      {
        name: "shared",
        readPrincipals: ["alice"],
        writePrincipals: ["alice"],
        includeInRecallByDefault: true,
      },
    ],
    // OMIT "self" — the principal self base (and so its project-* overlay) is NOT
    // in the readable recall set.
    defaultRecallNamespaces: ["shared"],
    codingMode: { projectScope: true, branchScope: true },
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

  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/secret",
    rootPath: projectId,
    defaultBranch: "main",
  });
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  const branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  const projectFallbackKey = encodeNs(projectFallbackNamespace(orchestrator, "alice", projectId), sessionId);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_q: string, limit: number, requestedSessionId?: string) =>
      evidenceFor(requestedSessionId, limit),
    expandContext: async () => [],
    getStats: async (requestedSessionId?: string) => {
      lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
      return { totalMessages: 0, maxTurnIndex: -1 };
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  await (orchestrator as any).recallInternal(
    "Remember when you told me to list, in chronological order, the cuisines I started my culinary journey with?",
    sessionId,
  );

  // Neither the branch overlay key nor the project-* overlay fallback may be
  // queried — the self base is unreadable, so `recallNamespaces` excludes them
  // and the LCM read path must too (no `<principal>-project-*` leak).
  assert.ok(
    !lcmQueriedSessionIds.includes(branchOverlayKey),
    `unreadable branch overlay key ${branchOverlayKey} must NEVER be queried; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  assert.ok(
    !lcmQueriedSessionIds.includes(projectFallbackKey),
    `unreadable project overlay key ${projectFallbackKey} must NEVER be queried; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  // No queried key may carry the `alice-project-` overlay prefix at all.
  for (const queried of lcmQueriedSessionIds) {
    assert.ok(
      !queried.includes("alice-project-"),
      `no LCM read may target an alice-project-* overlay namespace; saw ${queried}`,
    );
  }
});

test("#1505 codex P2: a WEAK branch-key hit must NOT mask stronger project-fallback LCM evidence (merge, don't short-circuit)", async () => {
  // Round 6 read the ordered LCM key set but STOPPED at the first non-empty key
  // (`firstNonEmptyLcmRead`). So if the primary BRANCH overlay key has ANY
  // matching evidence — even a single weak hit — the project/root fallback keys
  // are NEVER queried, and stronger project-scope evidence is silently dropped.
  // This diverges from QMD/file recall, which searches the primary namespace PLUS
  // `codingOverlay.readFallbacks` and MERGES. This pins the merge: each
  // query-matched LCM section must query EVERY authorized read key and merge +
  // dedupe results under its existing budget, so the project-fallback evidence
  // surfaces even when the branch key already returned a (weaker) hit.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-merge-"));
  const sessionId = "alice:branch-session";
  const projectId = "origin:proj7777";

  const lcmQueriedSessionIds: string[] = [];
  let branchOverlayKey = "";
  let projectFallbackKey = "";
  // The BRANCH key returns a non-empty but WEAK hit (turn 5, low score); the
  // PROJECT fallback key returns STRONGER, distinct evidence (turn 7, high
  // score). first-non-empty surfaces ONLY the weak branch hit (fail-before);
  // merging across the readable set surfaces BOTH (pass-after).
  const branchHit = {
    turn_index: 5,
    role: "user",
    content:
      "WEAK_BRANCH_EVIDENCE: my culinary journey jotted a quick note about Thai food.",
  };
  const projectHit = {
    turn_index: 7,
    role: "user",
    content:
      "STRONG_PROJECT_EVIDENCE: my culinary journey started with Turkish, Greek, and Lebanese cuisines.",
  };
  const evidenceFor = (requestedSessionId?: string, limit = 8) => {
    lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
    if (requestedSessionId === branchOverlayKey) {
      return [
        {
          id: 0,
          session_id: branchOverlayKey,
          turn_index: branchHit.turn_index,
          role: branchHit.role,
          content: branchHit.content,
          score: 10,
        },
      ].slice(0, limit);
    }
    if (requestedSessionId === projectFallbackKey) {
      return [
        {
          id: 1,
          session_id: projectFallbackKey,
          turn_index: projectHit.turn_index,
          role: projectHit.role,
          content: projectHit.content,
          score: 100,
        },
      ].slice(0, limit);
    }
    return [] as Array<{
      id: number;
      session_id: string;
      turn_index: number;
      role: string;
      content: string;
      score: number;
    }>;
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
    codingMode: { projectScope: true, branchScope: true },
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

  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/cuisines",
    rootPath: projectId,
    defaultBranch: "main",
  });
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  assert.notEqual(branchOverlayNs, "alice", "branch overlay must change the namespace");
  const projectFallbackNs = projectFallbackNamespace(orchestrator, "alice", projectId);
  assert.notEqual(
    projectFallbackNs,
    branchOverlayNs,
    "project fallback namespace must differ from the branch overlay namespace",
  );
  branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  projectFallbackKey = encodeNs(projectFallbackNs, sessionId);

  const expandFor = (requestedSessionId: string) => {
    if (requestedSessionId === branchOverlayKey) return [branchHit];
    if (requestedSessionId === projectFallbackKey) return [projectHit];
    return [] as Array<{ turn_index: number; role: string; content: string }>;
  };

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_q: string, limit: number, requestedSessionId?: string) =>
      evidenceFor(requestedSessionId, limit),
    expandContext: async (
      requestedSessionId: string,
      fromTurn: number,
      toTurn: number,
    ) =>
      expandFor(requestedSessionId).filter(
        (m) => m.turn_index >= fromTurn && m.turn_index <= toTurn,
      ),
    getStats: async (requestedSessionId?: string) => {
      lcmQueriedSessionIds.push(requestedSessionId ?? "<undefined>");
      if (requestedSessionId === branchOverlayKey) {
        return { totalMessages: 6, maxTurnIndex: branchHit.turn_index };
      }
      if (requestedSessionId === projectFallbackKey) {
        return { totalMessages: 8, maxTurnIndex: projectHit.turn_index };
      }
      return { totalMessages: 0, maxTurnIndex: -1 };
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "Remember when you told me to list, in chronological order, the cuisines I started my culinary journey with?",
    sessionId,
  );

  // Both the primary branch key AND the project fallback key must be queried —
  // the merge must NOT short-circuit on the weak branch hit.
  assert.ok(
    lcmQueriedSessionIds.includes(branchOverlayKey),
    `expected the branch overlay key ${branchOverlayKey} to be queried; queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  assert.ok(
    lcmQueriedSessionIds.includes(projectFallbackKey),
    `expected the project fallback key ${projectFallbackKey} to ALSO be queried (merge, not short-circuit); queried: ${JSON.stringify(lcmQueriedSessionIds)}`,
  );
  // The stronger project-fallback evidence must surface even though the branch
  // key already returned a (weaker) hit — this is the codex P2 fix.
  assert.match(
    context,
    /STRONG_PROJECT_EVIDENCE/,
    "merged recall must surface project-fallback evidence even when the branch key has a weak hit",
  );
  // The weak branch hit is still included (the merge unions, it does not drop the
  // primary key's evidence).
  assert.match(
    context,
    /WEAK_BRANCH_EVIDENCE/,
    "merged recall must still include the primary branch-key evidence",
  );
});

test("#1505 codex P2: structured message-parts merge across branch + project fallback keys (dedupe by part)", async () => {
  // The structured message-parts section is query-SCORED evidence, so it too must
  // MERGE across the ordered LCM read key set instead of short-circuiting on the
  // first non-empty key. A weak branch-key part must not mask stronger
  // project-fallback parts; parts are deduped by session_id+turn_index+part_id.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-parts-"));
  const sessionId = "alice:branch-session";
  const projectId = "origin:proj5555";

  const partsQueriedSessionIds: string[] = [];
  let branchOverlayKey = "";
  let projectFallbackKey = "";
  const partsFor = (requestedSessionId: string) => {
    partsQueriedSessionIds.push(requestedSessionId);
    if (requestedSessionId === branchOverlayKey) {
      return [
        {
          part_id: 1,
          session_id: branchOverlayKey,
          turn_index: 5,
          role: "user",
          kind: "text",
          content: "WEAK_BRANCH_PART",
          score: 10,
        },
      ];
    }
    if (requestedSessionId === projectFallbackKey) {
      return [
        {
          part_id: 2,
          session_id: projectFallbackKey,
          turn_index: 7,
          role: "user",
          kind: "text",
          content: "STRONG_PROJECT_PART",
          score: 100,
        },
      ];
    }
    return [];
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
    codingMode: { projectScope: true, branchScope: true },
    recallPipeline: [
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/cuisines",
    rootPath: projectId,
    defaultBranch: "main",
  });
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  projectFallbackKey = encodeNs(projectFallbackNamespace(orchestrator, "alice", projectId), sessionId);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async () => [],
    expandContext: async () => [],
    getStats: async () => ({ totalMessages: 0, maxTurnIndex: -1 }),
    searchStructuredParts: async (requestedSessionId: string) =>
      partsFor(requestedSessionId),
    // Render the matches it receives so the test can assert on merged content.
    formatStructuredRecall: (matches: Array<{ content: string }>) =>
      matches.length > 0
        ? `## Structured Session Matches\n\n${matches.map((m) => m.content).join("\n")}`
        : "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What did we cover earlier?",
    sessionId,
  );

  assert.ok(
    partsQueriedSessionIds.includes(branchOverlayKey),
    `expected structured parts to query the branch overlay key; queried: ${JSON.stringify(partsQueriedSessionIds)}`,
  );
  assert.ok(
    partsQueriedSessionIds.includes(projectFallbackKey),
    `expected structured parts to ALSO query the project fallback key (merge, not short-circuit); queried: ${JSON.stringify(partsQueriedSessionIds)}`,
  );
  assert.match(context, /STRONG_PROJECT_PART/);
  assert.match(context, /WEAK_BRANCH_PART/);
});

test("#1505 codex P2: a failing fallback structured-parts read must NOT discard the other key's parts or the compressed-history section", async () => {
  // Fault isolation: the structured-parts merge reads every key, but one key's
  // search throwing (e.g. a SqliteError on a corrupt/locked fallback index) must
  // not reject the whole batch. With `Promise.all` it would, and — because the
  // structured-parts read and the compressed-history read share one try block —
  // BOTH sections would be silently dropped even though the primary key is
  // healthy. This pins `Promise.allSettled` semantics: the surviving key's parts
  // AND the compressed-history section still appear.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-parts-fail-"));
  const sessionId = "alice:branch-session";
  const projectId = "origin:proj4242";

  let branchOverlayKey = "";
  let projectFallbackKey = "";

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
    codingMode: { projectScope: true, branchScope: true },
    recallPipeline: [
      { id: "profile", enabled: false },
      { id: "memories", enabled: false },
    ],
  });
  const orchestrator = new Orchestrator(cfg);

  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/cuisines",
    rootPath: projectId,
    defaultBranch: "main",
  });
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  projectFallbackKey = encodeNs(projectFallbackNamespace(orchestrator, "alice", projectId), sessionId);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async () => [],
    expandContext: async () => [],
    getStats: async () => ({ totalMessages: 0, maxTurnIndex: -1 }),
    // The PRIMARY (branch) key's structured read throws; the project fallback
    // key returns a healthy part.
    searchStructuredParts: async (requestedSessionId: string) => {
      if (requestedSessionId === branchOverlayKey) {
        throw new Error("simulated SqliteError on branch index");
      }
      if (requestedSessionId === projectFallbackKey) {
        return [
          {
            part_id: 7,
            session_id: projectFallbackKey,
            turn_index: 3,
            role: "user",
            kind: "text",
            content: "SURVIVING_PROJECT_PART",
            score: 100,
          },
        ];
      }
      return [];
    },
    formatStructuredRecall: (matches: Array<{ content: string }>) =>
      matches.length > 0
        ? `## Structured Session Matches\n\n${matches.map((m) => m.content).join("\n")}`
        : "",
    // Compressed history is healthy for the primary key — it must survive a
    // structured-parts failure on a fallback key.
    assembleRecall: async (requestedSessionId: string) =>
      requestedSessionId ? "## Compressed History\n\nCOMPRESSED_HISTORY_BODY" : "",
  };

  const context = await (orchestrator as any).recallInternal(
    "What did we cover earlier?",
    sessionId,
  );

  assert.match(
    context,
    /SURVIVING_PROJECT_PART/,
    "a fallback key's structured read failure must not discard the other key's parts",
  );
  assert.match(
    context,
    /COMPRESSED_HISTORY_BODY/,
    "a structured-parts failure must not discard the sibling compressed-history section",
  );
});

test("#1505 codex review: a fallback read-key failure must NOT discard the PRIMARY key's section evidence", async () => {
  // cursor[bot] Medium: the merged builders read every key in one call. If the
  // PRIMARY overlay key already gathered evidence but a later FALLBACK key throws
  // (e.g. a corrupt/locked fallback index), a bare `for...await` loop would
  // propagate and lose the whole section — discarding the primary's evidence the
  // old first-non-empty read would have returned. This pins per-key fault
  // isolation: the primary key's evidence still surfaces when a fallback read
  // throws.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-recall-keyfail-"));
  const sessionId = "alice:branch-session";
  const projectId = "origin:proj3131";

  let branchOverlayKey = "";
  let projectFallbackKey = "";
  const primaryEvidence = {
    turn_index: 9,
    role: "user",
    content:
      "PRIMARY_SURVIVES: my culinary journey started with Turkish, Greek, and Lebanese cuisines.",
  };
  // The PRIMARY (branch) key returns evidence; every read for the FALLBACK
  // (project) key throws, simulating a corrupt/locked fallback index.
  const failIfFallback = (requestedSessionId?: string) => {
    if (requestedSessionId === projectFallbackKey) {
      throw new Error("simulated corrupt fallback index");
    }
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
    codingMode: { projectScope: true, branchScope: true },
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

  orchestrator.setCodingContextForSession(sessionId, {
    projectId,
    branch: "feature/cuisines",
    rootPath: projectId,
    defaultBranch: "main",
  });
  const branchOverlayNs = (
    orchestrator as unknown as {
      applyCodingNamespaceOverlay: (sk: string, base: string) => string;
    }
  ).applyCodingNamespaceOverlay(sessionId, "alice");
  branchOverlayKey = encodeNs(branchOverlayNs, sessionId);
  projectFallbackKey = encodeNs(projectFallbackNamespace(orchestrator, "alice", projectId), sessionId);

  (orchestrator as any).lcmEngine = {
    enabled: true,
    searchContextFull: async (_q: string, limit: number, requestedSessionId?: string) => {
      failIfFallback(requestedSessionId);
      return requestedSessionId === branchOverlayKey
        ? [
            {
              id: 0,
              session_id: branchOverlayKey,
              turn_index: primaryEvidence.turn_index,
              role: primaryEvidence.role,
              content: primaryEvidence.content,
              score: 100,
            },
          ].slice(0, limit)
        : [];
    },
    expandContext: async (requestedSessionId: string, fromTurn: number, toTurn: number) => {
      failIfFallback(requestedSessionId);
      return requestedSessionId === branchOverlayKey &&
        primaryEvidence.turn_index >= fromTurn &&
        primaryEvidence.turn_index <= toTurn
        ? [primaryEvidence]
        : [];
    },
    getStats: async (requestedSessionId?: string) => {
      failIfFallback(requestedSessionId);
      return requestedSessionId === branchOverlayKey
        ? { totalMessages: 10, maxTurnIndex: primaryEvidence.turn_index }
        : { totalMessages: 0, maxTurnIndex: -1 };
    },
    searchStructuredParts: async () => [],
    formatStructuredRecall: () => "",
    assembleRecall: async () => "",
  };

  const context = await (orchestrator as any).recallInternal(
    "Remember when you told me to list, in chronological order, the cuisines I started my culinary journey with?",
    sessionId,
  );

  assert.match(
    context,
    /PRIMARY_SURVIVES/,
    "a fallback read-key failure must not discard the primary key's already-gathered evidence",
  );
});
