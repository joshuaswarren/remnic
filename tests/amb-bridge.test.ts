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
  RemnicAmbBridge,
} from "../integrations/amb/remnic-bridge.mjs";

test("AMB bridge builds stable sanitized session ids", () => {
  assert.equal(
    buildAmbSessionId({ id: "doc one", user_id: "conv/42" }, 3),
    "amb-conv-42-doc-one-3",
  );
});

test("AMB bridge can use benchmark-specific session prefixes", () => {
  assert.equal(
    buildAmbSessionId({ id: "doc one", user_id: "conv/42" }, 3, "beam"),
    "beam-conv-42-doc-one-3",
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
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[2]?.content, "Stored as structured assistant context.");
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
  assert.throws(
    () => buildAmbRecallQuery("What happened?", "not-a-date"),
    /query_timestamp must be a parseable ISO 8601 timestamp/,
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

test("AMB bridge parses inline JSON config", async () => {
  assert.deepEqual(
    await loadRemnicAmbConfig({
      REMNIC_AMB_CONFIG_JSON: '{"qmdEnabled":true}',
    }),
    { qmdEnabled: true },
  );
});
