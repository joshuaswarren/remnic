import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAmbMessages,
  buildAmbRecallDocuments,
  buildAmbSessionId,
  loadRemnicAmbConfig,
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

test("AMB bridge preserves document metadata and content as Remnic messages", () => {
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
      content: "User: The launch date is June 3.",
    },
  ]);
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

test("AMB bridge parses inline JSON config", async () => {
  assert.deepEqual(
    await loadRemnicAmbConfig({
      REMNIC_AMB_CONFIG_JSON: '{"qmdEnabled":true}',
    }),
    { qmdEnabled: true },
  );
});
