import test from "node:test";
import assert from "node:assert/strict";
import { openclawReplayNormalizer } from "../src/replay/normalizers/openclaw.ts";
import { claudeReplayNormalizer } from "../src/replay/normalizers/claude.ts";
import { chatgptReplayNormalizer } from "../src/replay/normalizers/chatgpt.ts";

test("openclaw normalizer parses transcript records from export bundle", async () => {
  const bundle = {
    records: [
      {
        path: "transcripts/main/default/2026-02-25.jsonl",
        content: [
          JSON.stringify({
            timestamp: "2026-02-25T00:00:00.000Z",
            role: "user",
            content: "hello",
            sessionKey: "agent:generalist:main",
            turnId: "t-1",
          }),
          JSON.stringify({
            timestamp: "2026-02-25T00:01:00.000Z",
            role: "assistant",
            content: "hi",
            sessionKey: "agent:generalist:main",
            turnId: "t-2",
          }),
        ].join("\n"),
      },
    ],
  };

  const result = await openclawReplayNormalizer.parse(bundle, {});
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].source, "openclaw");
  assert.equal(result.turns[0].externalId, "t-1");
  assert.equal(result.warnings.length, 0);
});

test("openclaw normalizer throws in strict mode on invalid turns", async () => {
  await assert.rejects(
    async () =>
      openclawReplayNormalizer.parse(
        [{ timestamp: "2026-02-25T00:00:00.000Z", role: "system", content: "nope" }],
        { strict: true },
      ),
    /Skipping invalid openclaw turn/,
  );
});

test("claude normalizer parses chat_messages format", async () => {
  const input = {
    conversations: [
      {
        uuid: "claude-conv-1",
        name: "Test",
        chat_messages: [
          { uuid: "m1", sender: "human", text: "Question", created_at: "2026-02-25T01:00:00Z" },
          { uuid: "m2", sender: "assistant", text: "Answer", created_at: "2026-02-25T01:01:00Z" },
        ],
      },
    ],
  };

  const result = await claudeReplayNormalizer.parse(input, {});
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].sessionKey, "replay:claude:claude-conv-1");
  assert.equal(result.turns[0].role, "user");
  assert.equal(result.turns[1].role, "assistant");
  assert.equal(result.warnings.length, 0);
});

test("chatgpt normalizer parses mapping export shape", async () => {
  const input = [
    {
      id: "chatgpt-conv-1",
      title: "Mapping Export",
      current_node: "n2",
      mapping: {
        n1: {
          id: "n1",
          parent: null,
          create_time: 1772054400,
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["Hello from mapping"] },
            create_time: 1772054400,
          },
        },
        n2: {
          id: "n2",
          parent: "n1",
          create_time: 1772054460,
          message: {
            id: "msg-2",
            author: { role: "assistant" },
            content: { parts: ["Reply from mapping"] },
            create_time: 1772054460,
          },
        },
      },
    },
  ];

  const result = await chatgptReplayNormalizer.parse(input, {});
  assert.equal(result.turns.length, 2);
  assert.equal(result.turns[0].sessionKey, "replay:chatgpt:chatgpt-conv-1");
  assert.equal(result.turns[0].role, "user");
  assert.equal(result.turns[1].role, "assistant");
  assert.equal(result.warnings.length, 0);
});

test("chatgpt normalizer follows active branch from current_node", async () => {
  const input = [
    {
      id: "chatgpt-conv-branchy",
      current_node: "n4",
      mapping: {
        n1: {
          id: "n1",
          parent: null,
          create_time: 1772054400,
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["root"] },
            create_time: 1772054400,
          },
        },
        n2: {
          id: "n2",
          parent: "n1",
          create_time: 1772054460,
          message: {
            id: "msg-2",
            author: { role: "assistant" },
            content: { parts: ["branch-a"] },
            create_time: 1772054460,
          },
        },
        n3: {
          id: "n3",
          parent: "n1",
          create_time: 1772054520,
          message: {
            id: "msg-3",
            author: { role: "assistant" },
            content: { parts: ["branch-b"] },
            create_time: 1772054520,
          },
        },
        n4: {
          id: "n4",
          parent: "n2",
          create_time: 1772054580,
          message: {
            id: "msg-4",
            author: { role: "user" },
            content: { parts: ["tail"] },
            create_time: 1772054580,
          },
        },
      },
    },
  ];

  const result = await chatgptReplayNormalizer.parse(input, {});
  assert.equal(result.turns.length, 3);
  assert.deepEqual(result.turns.map((turn) => turn.content), ["root", "branch-a", "tail"]);
});

test("chatgpt normalizer skips unsupported roles with warnings", async () => {
  const result = await chatgptReplayNormalizer.parse(
    {
      id: "conv-2",
      messages: [
        {
          id: "m1",
          author: { role: "system" },
          content: { parts: ["meta"] },
          create_time: 1772054400,
        },
      ],
    },
    {},
  );

  assert.equal(result.turns.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].code, /replay.chatgpt.message.invalid/);
});

test("normalizers honor defaultSessionKey when source session identifiers are absent", async () => {
  const openclaw = await openclawReplayNormalizer.parse(
    [{ timestamp: "2026-02-25T03:00:00.000Z", role: "user", content: "hi" }],
    { defaultSessionKey: "replay:default:session" },
  );
  const claude = await claudeReplayNormalizer.parse(
    { chat_messages: [{ sender: "human", text: "x", created_at: "2026-02-25T03:01:00.000Z" }] },
    { defaultSessionKey: "replay:default:session" },
  );
  const chatgpt = await chatgptReplayNormalizer.parse(
    { messages: [{ author: { role: "user" }, content: { parts: ["y"] }, create_time: 1772054460 }] },
    { defaultSessionKey: "replay:default:session" },
  );

  assert.equal(openclaw.turns[0].sessionKey, "replay:default:session");
  assert.equal(claude.turns[0].sessionKey, "replay:default:session");
  assert.equal(chatgpt.turns[0].sessionKey, "replay:default:session");
});

test("defaultSessionKey is fallback-only when conversation identifiers exist", async () => {
  const claude = await claudeReplayNormalizer.parse(
    {
      conversations: [
        {
          uuid: "claude-conv-xyz",
          chat_messages: [{ sender: "human", text: "x", created_at: "2026-02-25T03:01:00.000Z" }],
        },
      ],
    },
    { defaultSessionKey: "replay:default:session" },
  );

  const chatgpt = await chatgptReplayNormalizer.parse(
    {
      id: "chatgpt-conv-xyz",
      messages: [{ author: { role: "user" }, content: { parts: ["y"] }, create_time: 1772054460 }],
    },
    { defaultSessionKey: "replay:default:session" },
  );

  assert.equal(claude.turns[0].sessionKey, "replay:claude:claude-conv-xyz");
  assert.equal(chatgpt.turns[0].sessionKey, "replay:chatgpt:chatgpt-conv-xyz");
});

test("claude normalizer uses defaultSessionKey when conversation id is blank", async () => {
  const result = await claudeReplayNormalizer.parse(
    {
      conversations: [
        {
          uuid: "   ",
          chat_messages: [{ sender: "human", text: "x", created_at: "2026-02-25T03:01:00.000Z" }],
        },
      ],
    },
    { defaultSessionKey: "replay:default:session" },
  );

  assert.equal(result.turns[0].sessionKey, "replay:default:session");
});

test("normalizers skip out-of-range numeric timestamps instead of throwing", async () => {
  const openclaw = await openclawReplayNormalizer.parse(
    [{ role: "user", content: "x", timestamp: 1e20 }],
    {},
  );
  const claude = await claudeReplayNormalizer.parse(
    { chat_messages: [{ sender: "human", text: "x", created_at: 1e20 }] },
    {},
  );
  const chatgpt = await chatgptReplayNormalizer.parse(
    { messages: [{ author: { role: "user" }, content: { parts: ["x"] }, create_time: 1e20 }] },
    {},
  );

  assert.equal(openclaw.turns.length, 0);
  assert.equal(claude.turns.length, 0);
  assert.equal(chatgpt.turns.length, 0);
  assert.equal(openclaw.warnings.length > 0, true);
  assert.equal(claude.warnings.length > 0, true);
  assert.equal(chatgpt.warnings.length > 0, true);
});

test("normalizers reject overflowed string timestamps instead of rewriting them", async () => {
  const openclaw = await openclawReplayNormalizer.parse(
    [{ role: "user", content: "x", timestamp: "2024-02-31T10:00:00Z" }],
    {},
  );
  const claude = await claudeReplayNormalizer.parse(
    { chat_messages: [{ sender: "human", text: "x", created_at: "2024-02-31T10:00:00Z" }] },
    {},
  );

  assert.equal(openclaw.turns.length, 0);
  assert.equal(claude.turns.length, 0);
  assert.equal(openclaw.warnings.length > 0, true);
  assert.equal(claude.warnings.length > 0, true);
});

test("normalizers reject non-UTC string timestamps instead of Date.parse coercion", async () => {
  const openclaw = await openclawReplayNormalizer.parse(
    [{ role: "user", content: "x", timestamp: "February 25, 2026 10:00 AM" }],
    {},
  );
  const claude = await claudeReplayNormalizer.parse(
    { chat_messages: [{ sender: "human", text: "x", created_at: "2026-02-25T10:00:00-05:00" }] },
    {},
  );

  assert.equal(openclaw.turns.length, 0);
  assert.equal(claude.turns.length, 0);
  assert.equal(openclaw.warnings.length > 0, true);
  assert.equal(claude.warnings.length > 0, true);
});
