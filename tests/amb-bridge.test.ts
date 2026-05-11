import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ambRecallBudgetForSessionCount,
  buildAmbMessages,
  buildAmbRecallDocuments,
  buildAmbRecallQuery,
  buildAmbSessionId,
  buildAmbStorageSessionId,
  joinAmbRecallChunks,
  loadRemnicAmbConfig,
  parseJsonlBridgeRequest,
  RemnicAmbBridge,
} from "../integrations/amb/remnic-bridge.mjs";

test("AMB bridge builds stable sanitized session ids", () => {
  const sessionId = buildAmbSessionId({ id: "doc one", user_id: "conv/42" }, 3);

  assert.match(sessionId, /^amb-conv-42-[a-f0-9]{12}-doc-one-[a-f0-9]{12}-3$/);
  assert.equal(sessionId, buildAmbSessionId({ id: "doc one", user_id: "conv/42" }, 3));
});

test("AMB bridge can use benchmark-specific session prefixes", () => {
  assert.match(
    buildAmbSessionId({ id: "doc one", user_id: "conv/42" }, 3, "beam"),
    /^beam-conv-42-[a-f0-9]{12}-doc-one-[a-f0-9]{12}-3$/,
  );
});

test("AMB bridge groups chunked documents by AMB user session by default", () => {
  assert.equal(
    buildAmbStorageSessionId({ id: "conv-1_s0_0", user_id: "conv-1" }, 0, "beam"),
    "beam-conv-1",
  );
  assert.equal(
    buildAmbStorageSessionId({ id: "conv-1_s0_1", user_id: "conv-1" }, 1, "beam"),
    "beam-conv-1",
  );
});

test("AMB bridge keeps sanitized grouped session ids collision-resistant", () => {
  const slashSession = buildAmbStorageSessionId({ id: "doc-1", user_id: "team/a" }, 0, "amb");
  const spaceSession = buildAmbStorageSessionId({ id: "doc-2", user_id: "team a" }, 0, "amb");

  assert.notEqual(slashSession, spaceSession);
  assert.match(slashSession, /^amb-team-a-[a-f0-9]{12}$/);
  assert.match(spaceSession, /^amb-team-a-[a-f0-9]{12}$/);
});

test("AMB bridge can keep document-specific sessions when grouping is disabled", () => {
  assert.equal(
    buildAmbStorageSessionId(
      { id: "conv-1_s0_1", user_id: "conv-1" },
      1,
      "beam",
      { groupDocumentsByUser: false },
    ),
    "beam-conv-1-conv-1_s0_1-1",
  );
});

test("AMB bridge preserves document metadata and parses formatted content", () => {
  const messages = buildAmbMessages({
    id: "doc-1",
    user_id: "user-1",
    timestamp: "2026-05-10T12:00:00Z",
    context: "Conversation user-1",
    content: "User: The launch date is June 3.",
  });

  assert.deepEqual(messages, [
    {
      role: "system",
      content:
        "AMB document metadata: document_id=doc-1; user_id=user-1; timestamp=2026-05-10T12:00:00Z; context=Conversation user-1",
    },
    {
      role: "user",
      content: "The launch date is June 3.",
      timestamp: "2026-05-10T12:00:00.000Z",
    },
  ]);
});

test("AMB bridge adds benchmark-visible anchors for BEAM turn ids", () => {
  const messages = buildAmbMessages({
    id: "conv-1_s0_0",
    user_id: "conv-1",
    context: "Conversation conv-1",
    content: [
      "[Turn 27] User: Marisol owns late referenced chat evidence.",
      "",
      "[2026-05-10T12:00:00Z | Turn 28] Assistant: Confirmed by the release note.",
    ].join("\n"),
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "user");
  assert.match(
    messages[1]?.content ?? "",
    /AMB turn anchors: document_id=conv-1_s0_0; turn_id=27; chat_id=27; source_chat_id=27; turn_marker=Turn 27/,
  );
  assert.match(messages[1]?.content ?? "", /Marisol owns late referenced chat evidence/);
  assert.equal(messages[2]?.role, "assistant");
  assert.match(messages[2]?.content ?? "", /chat_id=28/);
  assert.match(messages[2]?.content ?? "", /time_anchor=2026-05-10T12:00:00Z/);
  assert.match(messages[2]?.content ?? "", /date=2026-05-10/);
  assert.match(messages[2]?.content ?? "", /Confirmed by the release note/);
  assert.equal(messages[2]?.timestamp, "2026-05-10T12:00:00.000Z");
});

test("AMB bridge splits formatted content on single newlines", () => {
  const messages = buildAmbMessages({
    id: "doc-line-oriented",
    timestamp: "2026-05-10T12:00:00Z",
    content: [
      "User: The launch owner was Marisol.",
      "Assistant: Marisol approved the plan.",
      "[2026-05-10T13:00:00Z | Turn 3] System: Launch approval logged.",
    ].join("\n"),
  });

  assert.equal(messages.length, 4);
  assert.equal(messages[1]?.role, "user");
  assert.equal(messages[1]?.content, "The launch owner was Marisol.");
  assert.equal(messages[1]?.timestamp, "2026-05-10T12:00:00.000Z");
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[2]?.content, "Marisol approved the plan.");
  assert.equal(messages[2]?.timestamp, "2026-05-10T12:00:00.000Z");
  assert.equal(messages[3]?.role, "system");
  assert.match(messages[3]?.content ?? "", /chat_id=3/);
  assert.match(messages[3]?.content ?? "", /Launch approval logged/);
  assert.equal(messages[3]?.timestamp, "2026-05-10T13:00:00.000Z");
});

test("AMB bridge uses document timestamps as turn anchors when markers omit time", () => {
  const messages = buildAmbMessages({
    id: "doc-turn-time-fallback",
    timestamp: "2026-05-10T12:00:00Z",
    content: "[Turn 7] User: The deployment window starts at noon.",
  });

  assert.match(messages[1]?.content ?? "", /turn_id=7/);
  assert.match(messages[1]?.content ?? "", /time_anchor=2026-05-10T12:00:00\.000Z/);
  assert.match(messages[1]?.content ?? "", /date=2026-05-10/);
  assert.equal(messages[1]?.timestamp, "2026-05-10T12:00:00.000Z");
});

test("AMB bridge prefers structured document messages when present", () => {
  const messages = buildAmbMessages({
    id: "doc-structured",
    content: "Unstructured fallback should not be duplicated.",
    messages: [
      {
        id: 7,
        role: "user",
        timestamp: "2026-07-09T09:00:00Z",
        content: "Structured launch date is July 9.",
      },
      { role: "assistant", content: "Stored as structured assistant context." },
    ],
  });

  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "user");
  assert.match(messages[1]?.content ?? "", /chat_id=7/);
  assert.match(messages[1]?.content ?? "", /time_anchor=2026-07-09T09:00:00Z/);
  assert.match(messages[1]?.content ?? "", /date=2026-07-09/);
  assert.match(messages[1]?.content ?? "", /Structured launch date is July 9/);
  assert.equal(messages[1]?.timestamp, "2026-07-09T09:00:00.000Z");
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[2]?.content, "Stored as structured assistant context.");
});

test("AMB bridge carries document timestamps into raw message fallback", () => {
  assert.deepEqual(
    buildAmbMessages({
      id: "doc-raw-time",
      timestamp: "2026-08-01T13:14:15Z",
      content: "Plain timed document content without role markers.",
    }),
    [
      {
        role: "system",
        content: "AMB document metadata: document_id=doc-raw-time; timestamp=2026-08-01T13:14:15Z",
      },
      {
        role: "user",
        content: "Plain timed document content without role markers.",
        timestamp: "2026-08-01T13:14:15.000Z",
      },
    ],
  );
});

test("AMB bridge rejects overflowing document timestamps", () => {
  assert.throws(
    () =>
      buildAmbMessages({
        id: "doc-overflow-time",
        timestamp: "2026-02-30",
        content: "Invalid source timestamp.",
      }),
    /AMB source timestamp must be a valid ISO 8601 timestamp/,
  );
});

test("AMB bridge rejects invalid formatted turn marker timestamps", () => {
  assert.throws(
    () =>
      buildAmbMessages({
        id: "doc-marker-overflow-time",
        content: "[2026-02-30 | Turn 1] User: Invalid marker timestamp.",
      }),
    /AMB source timestamp must be a valid ISO 8601 timestamp/,
  );
});

test("AMB bridge falls back to raw content when no transcript markers exist", () => {
  assert.deepEqual(
    buildAmbMessages({
      id: "doc-raw",
      content: "Plain document content without role markers.",
    }),
    [
      {
        role: "system",
        content: "AMB document metadata: document_id=doc-raw",
      },
      {
        role: "user",
        content: "Plain document content without role markers.",
      },
    ],
  );
});

test("AMB bridge returns no retrieved documents for empty recall or non-positive k", () => {
  assert.deepEqual(buildAmbRecallDocuments("", { k: 10 }), []);
  assert.deepEqual(buildAmbRecallDocuments("memory", { k: 0 }), []);
});

test("AMB bridge wraps recalled text as an AMB document", () => {
  const [doc] = buildAmbRecallDocuments("The launch date is June 3.", {
    k: 10,
    user_id: "user-1",
  });

  assert.match(doc.id, /^remnic-recall-/);
  assert.equal(doc.content, "The launch date is June 3.");
  assert.equal(doc.user_id, "user-1");
});

test("AMB bridge divides recall budget across sessions", () => {
  assert.equal(ambRecallBudgetForSessionCount(9000, 3), 3000);
  assert.equal(ambRecallBudgetForSessionCount(9000, 0), 0);
  assert.equal(ambRecallBudgetForSessionCount(100, 10), 256);
});

test("AMB bridge caps combined recall context to the configured budget", () => {
  const joined = joinAmbRecallChunks([
    "## Remnic session one\n" + "A".repeat(40),
    "## Remnic session two\n" + "B".repeat(40),
  ], 72);

  assert.equal(joined.length <= 72, true);
  assert.match(joined, /Remnic session one/);
  assert.match(joined, /A+/);
  assert.doesNotMatch(joined, /Remnic session two/);
});

test("AMB bridge threads query timestamps into recall anchors", () => {
  const query = buildAmbRecallQuery(
    "Who owned the launch decision?",
    "2026-05-10T12:00:00Z",
  );

  assert.match(query, /Who owned the launch decision\?/);
  assert.match(query, /query_timestamp=2026-05-10T12:00:00Z/);
  assert.match(query, /query_date=2026-05-10/);
});

test("AMB bridge rejects invalid query timestamps", () => {
  assert.match(
    buildAmbRecallQuery("What happened?", "2026-05-10"),
    /query_timestamp=2026-05-10/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "not-a-date"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "2026-02-30"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "2026-05-10T25:00:00Z"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "2026-05-10T12:00+23:00"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "2026-05-10T12:00+14:30"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "2026-05-10T12:00:00"),
    /query_timestamp must be a valid ISO 8601 timestamp/,
  );
});

test("AMB bridge JSONL request parser rejects non-object JSON", () => {
  assert.deepEqual(
    parseJsonlBridgeRequest('{"id":"1","method":"cleanup"}'),
    { id: "1", method: "cleanup" },
  );
  assert.throws(
    () => parseJsonlBridgeRequest("null"),
    /request must be a JSON object/,
  );
  assert.throws(
    () => parseJsonlBridgeRequest("42"),
    /request must be a JSON object/,
  );
  assert.throws(
    () => parseJsonlBridgeRequest("[]"),
    /request must be a JSON object/,
  );
  assert.throws(
    () => parseJsonlBridgeRequest("{"),
    /invalid JSON:/,
  );
});

test("AMB bridge forwards query timestamps as recall asOf metadata", async () => {
  const calls = [];
  const bridge = new RemnicAmbBridge(
    {
      async reset() {},
      async store() {},
      async recall(sessionId, query, budgetChars, options) {
        calls.push({ sessionId, query, budgetChars, options });
        return "The launch decision owner was Marisol.";
      },
      async destroy() {},
    },
    {
      drainAfterIngest: false,
      groupDocumentsByUser: true,
      resetBeforeIngest: false,
      recallBudgetChars: 4096,
      sessionPrefix: "beam",
    },
  );

  await bridge.ingest([
    {
      id: "conv-1_s0_0",
      user_id: "conv-1",
      content: "[2026-05-09T12:00:00Z | Turn 1] User: Marisol owned it.",
    },
  ]);
  const result = await bridge.retrieve({
    query: "Who owned the launch decision?",
    k: 10,
    user_id: "conv-1",
    query_timestamp: "2026-05-10T12:00:00Z",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.sessionId, "beam-conv-1");
  assert.match(calls[0]?.query ?? "", /query_timestamp=2026-05-10T12:00:00Z/);
  assert.deepEqual(calls[0]?.options, { asOf: "2026-05-10T12:00:00Z" });
  assert.equal(result.raw_response.query_timestamp, "2026-05-10T12:00:00Z");
  assert.match(result.documents[0]?.content ?? "", /Marisol/);
});

test("AMB bridge returns empty recall for unknown scoped users", async () => {
  const bridge = new RemnicAmbBridge(
    {
      async reset() {},
      async store() {},
      async recall() {
        throw new Error("recall should not be called for unknown scoped users");
      },
      async destroy() {},
    },
    {
      drainAfterIngest: false,
      groupDocumentsByUser: true,
      resetBeforeIngest: false,
      recallBudgetChars: 4096,
      sessionPrefix: "beam",
    },
  );

  await bridge.ingest([
    {
      id: "conv-1_s0_0",
      user_id: "conv-1",
      content: "User: Marisol owned it.",
    },
  ]);
  const result = await bridge.retrieve({
    query: "Who owned the launch decision?",
    k: 10,
    user_id: "missing-user",
  });

  assert.deepEqual(result.documents, []);
  assert.equal(result.raw_response.session_count, 0);
  assert.equal(result.raw_response.user_id, "missing-user");
});

test("AMB bridge reloads persisted session index for skipped-ingestion recall", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-amb-index-"));
  const sessionIndexPath = path.join(dir, "amb-session-index.json");
  const storedSessions = [];
  const recallCalls = [];

  try {
    const writer = new RemnicAmbBridge(
      {
        async reset() {},
        async store(sessionId) {
          storedSessions.push(sessionId);
        },
        async recall() {
          throw new Error("writer bridge should not recall");
        },
        async destroy() {},
      },
      {
        drainAfterIngest: false,
        groupDocumentsByUser: true,
        resetBeforeIngest: false,
        recallBudgetChars: 4096,
        sessionPrefix: "beam",
        sessionIndexPath,
      },
    );

    await writer.ingest([
      {
        id: "conv-1_s0_0",
        user_id: "conv-1",
        content: "User: Marisol owned it.",
      },
      {
        id: "conv-2_s0_0",
        user_id: "conv-2",
        content: "User: Naveen owned it.",
      },
    ]);

    assert.deepEqual(storedSessions, ["beam-conv-1", "beam-conv-2"]);

    const reader = new RemnicAmbBridge(
      {
        async reset() {},
        async store() {
          throw new Error("reader bridge should not ingest");
        },
        async recall(sessionId, query) {
          recallCalls.push({ sessionId, query });
          return sessionId === "beam-conv-1" ? "Marisol owned it." : "";
        },
        async destroy() {},
      },
      {
        drainAfterIngest: false,
        groupDocumentsByUser: true,
        resetBeforeIngest: false,
        recallBudgetChars: 4096,
        sessionPrefix: "beam",
        sessionIndexPath,
      },
    );

    const result = await reader.retrieve({
      query: "Who owned it?",
      k: 10,
      user_id: "conv-1",
    });

    assert.deepEqual(
      recallCalls.map((call) => call.sessionId),
      ["beam-conv-1"],
    );
    assert.equal(result.raw_response.session_count, 1);
    assert.match(result.documents[0]?.content ?? "", /Marisol/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AMB bridge can derive grouped session id for legacy skipped-ingestion stores", async () => {
  const recallCalls = [];
  const currentSession = buildAmbStorageSessionId({ user_id: "conv/1" }, 0, "beam");
  const legacyPreHashSession = "beam-conv-1";
  assert.notEqual(currentSession, legacyPreHashSession);
  const bridge = new RemnicAmbBridge(
    {
      async reset() {},
      async store() {
        throw new Error("retrieve should not ingest");
      },
      async recall(sessionId) {
        recallCalls.push(sessionId);
        return sessionId === legacyPreHashSession ? "Marisol owned it." : "";
      },
      async destroy() {},
    },
    {
      drainAfterIngest: false,
      groupDocumentsByUser: true,
      resetBeforeIngest: false,
      recallBudgetChars: 4096,
      sessionPrefix: "beam",
    },
  );

  const result = await bridge.retrieve({
    query: "Who owned it?",
    k: 10,
    user_id: "conv/1",
  });

  assert.deepEqual(recallCalls, [currentSession, legacyPreHashSession]);
  assert.equal(result.raw_response.session_count, 2);
  assert.match(result.documents[0]?.content ?? "", /Marisol/);
});

test("AMB bridge treats a loaded session index as authoritative for missing users", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-amb-index-authoritative-"));
  const sessionIndexPath = path.join(dir, "amb-session-index.json");
  const recallCalls = [];

  try {
    await writeFile(
      sessionIndexPath,
      JSON.stringify({
        version: 1,
        allSessions: ["beam-conv-2"],
        sessionsByUser: {
          "conv-2": ["beam-conv-2"],
        },
      }),
      "utf8",
    );
    const bridge = new RemnicAmbBridge(
      {
        async reset() {},
        async store() {
          throw new Error("retrieve should not ingest");
        },
        async recall(sessionId) {
          recallCalls.push(sessionId);
          return sessionId === "beam-conv-1" ? "Marisol owned it." : "";
        },
        async destroy() {},
      },
      {
        drainAfterIngest: false,
        groupDocumentsByUser: true,
        resetBeforeIngest: false,
        recallBudgetChars: 4096,
        sessionPrefix: "beam",
        sessionIndexPath,
      },
    );

    const result = await bridge.retrieve({
      query: "Who owned it?",
      k: 10,
      user_id: "conv-1",
    });

    assert.deepEqual(recallCalls, []);
    assert.deepEqual(result.documents, []);
    assert.equal(result.raw_response.session_count, 0);
    assert.equal(result.raw_response.user_id, "conv-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AMB bridge rejects conflicting config env vars", async () => {
  await assert.rejects(
    () =>
      loadRemnicAmbConfig({
        REMNIC_AMB_CONFIG_PATH: "/tmp/remnic.json",
        REMNIC_AMB_CONFIG_JSON: "{}",
      }),
    /Set only one/,
  );
});

test("AMB bridge expands tilde config paths", async () => {
  const oldHome = process.env.HOME;
  const homeDir = await mkdtemp(path.join(tmpdir(), "remnic-amb-home-"));
  try {
    process.env.HOME = homeDir;
    await writeFile(
      path.join(homeDir, "amb-config.json"),
      JSON.stringify({ remnic: { qmdEnabled: true } }),
    );

    assert.deepEqual(
      await loadRemnicAmbConfig({
        REMNIC_AMB_CONFIG_PATH: "~/amb-config.json",
      }),
      { qmdEnabled: true },
    );
  } finally {
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("AMB bridge rejects nested remnic config arrays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "remnic-amb-config-"));
  const file = path.join(dir, "amb-config.json");

  try {
    await writeFile(file, JSON.stringify({ remnic: [] }));
    await assert.rejects(
      () =>
        loadRemnicAmbConfig({
          REMNIC_AMB_CONFIG_PATH: file,
        }),
      /REMNIC_AMB_CONFIG_PATH remnic value must be a JSON object/,
    );
    await assert.rejects(
      () =>
        loadRemnicAmbConfig({
          REMNIC_AMB_CONFIG_JSON: JSON.stringify({ remnic: [] }),
        }),
      /REMNIC_AMB_CONFIG_JSON remnic value must be a JSON object/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("AMB bridge parses inline JSON config", async () => {
  assert.deepEqual(
    await loadRemnicAmbConfig({
      REMNIC_AMB_CONFIG_JSON: '{"qmdEnabled":true}',
    }),
    { qmdEnabled: true },
  );
});
