import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectUserTurnsFromConversation,
  parseChatGPTExport,
} from "./parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseChatGPTExport", () => {
  it("reads the 2026 `memory` object shape", () => {
    const parsed = parseChatGPTExport(loadFixture("saved-memories-2026.json"));
    // Two active memories + one soft-deleted (skipped).
    assert.equal(parsed.savedMemories.length, 2);
    assert.equal(parsed.conversations.length, 0);
    assert.equal(parsed.savedMemories[0].id, "11111111-aaaa-4000-8000-000000000001");
    assert.equal(parsed.savedMemories[1].pinned, true);
    // Soft-deleted entry must not leak through.
    assert.ok(!parsed.savedMemories.some((m) => m.id?.endsWith("0003")));
  });

  it("reads the legacy array shape with mixed content/text fields", () => {
    const parsed = parseChatGPTExport(
      loadFixture("saved-memories-legacy-array.json"),
    );
    assert.equal(parsed.savedMemories.length, 2);
    assert.equal(
      parsed.savedMemories[1].content,
      "Fictional example: reviewed a paper on retrieval-augmented generation.",
    );
  });

  it("reads the conversations mapping shape", () => {
    const parsed = parseChatGPTExport(
      loadFixture("conversations-mapping.json"),
    );
    assert.equal(parsed.savedMemories.length, 0);
    assert.equal(parsed.conversations.length, 1);
    const [conv] = parsed.conversations;
    assert.equal(conv.id, "synthetic-conv-0001");
    const userTurns = collectUserTurnsFromConversation(conv);
    assert.equal(userTurns.length, 2);
    assert.equal(
      userTurns[0].content,
      "I want to build a synthetic weekend project.",
    );
    // createdAt is derived from the numeric create_time field → ISO.
    assert.ok(
      userTurns[0].createdAt &&
        /\d{4}-\d{2}-\d{2}T/.test(userTurns[0].createdAt),
    );
  });

  it("accepts already-parsed objects without double-parsing", () => {
    const obj = { memory: [{ id: "x", content: "hello" }] };
    const parsed = parseChatGPTExport(obj);
    assert.equal(parsed.savedMemories.length, 1);
    assert.equal(parsed.savedMemories[0].content, "hello");
  });

  it("skips entries missing content in non-strict mode", () => {
    const parsed = parseChatGPTExport({
      memory: [{ id: "x" }, { id: "y", content: "kept" }],
    });
    assert.equal(parsed.savedMemories.length, 1);
    assert.equal(parsed.savedMemories[0].content, "kept");
  });

  it("throws in strict mode on missing content", () => {
    assert.throws(() =>
      parseChatGPTExport(
        { memory: [{ id: "x" }] },
        { strict: true },
      ),
    );
  });

  it("throws on malformed JSON string input", () => {
    assert.throws(() => parseChatGPTExport("{not valid"));
  });

  it("distinguishes a top-level conversations array from a memories array", () => {
    const convArray = [
      {
        id: "c-1",
        mapping: {
          "m-1": {
            id: "m-1",
            message: {
              id: "m-1",
              author: { role: "user" },
              content: { parts: ["Hello"] },
              create_time: 1737763200,
            },
          },
        },
      },
    ];
    const parsed = parseChatGPTExport(convArray);
    assert.equal(parsed.conversations.length, 1);
    assert.equal(parsed.savedMemories.length, 0);
  });

  // Cursor review on PR #595 — strict mode should reject object payloads
  // that have none of the recognized ChatGPT export sections rather than
  // silently returning an empty struct.
  it("strict mode rejects unknown object shapes", () => {
    assert.throws(
      () => parseChatGPTExport({ foo: "bar" }, { strict: true }),
      /Unknown ChatGPT export object shape/,
    );
  });

  it("non-strict mode returns an empty result for unknown object shapes", () => {
    const parsed = parseChatGPTExport({ foo: "bar" });
    assert.equal(parsed.savedMemories.length, 0);
    assert.equal(parsed.conversations.length, 0);
  });

  // Cursor review on PR #595 — collectUserTurnsFromConversation should
  // follow the current_node → parent chain rather than flattening every
  // node in the mapping, which would include abandoned branches.
  it("follows current_node chain and ignores abandoned mapping branches", () => {
    const conv = {
      current_node: "msg-3",
      mapping: {
        "msg-1": {
          id: "msg-1",
          parent: null,
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["First user turn (active)"] },
            create_time: 1000,
          },
        },
        "msg-2": {
          id: "msg-2",
          parent: "msg-1",
          message: {
            id: "msg-2",
            author: { role: "assistant" },
            content: { parts: ["Reply"] },
            create_time: 1100,
          },
        },
        "msg-3": {
          id: "msg-3",
          parent: "msg-2",
          message: {
            id: "msg-3",
            author: { role: "user" },
            content: { parts: ["Second user turn (active)"] },
            create_time: 1200,
          },
        },
        "msg-abandoned": {
          id: "msg-abandoned",
          parent: "msg-1",
          message: {
            id: "msg-abandoned",
            author: { role: "user" },
            content: { parts: ["ABANDONED branch — must NOT appear"] },
            create_time: 1050,
          },
        },
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.content, "First user turn (active)");
    assert.equal(turns[1]?.content, "Second user turn (active)");
  });

  it("follows message-level parent links when mapping nodes omit parent", () => {
    const conv = {
      current_node: "msg-3",
      mapping: {
        "msg-1": {
          id: "msg-1",
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["First message-parent user turn"] },
            create_time: 1000,
          },
        },
        "msg-2": {
          id: "msg-2",
          message: {
            id: "msg-2",
            parent: "msg-1",
            author: { role: "assistant" },
            content: { parts: ["Reply"] },
            create_time: 1100,
          },
        },
        "msg-3": {
          id: "msg-3",
          message: {
            id: "msg-3",
            parent: "msg-2",
            author: { role: "user" },
            content: { parts: ["Second message-parent user turn"] },
            create_time: 1200,
          },
        },
        "msg-abandoned": {
          id: "msg-abandoned",
          message: {
            id: "msg-abandoned",
            parent: "msg-1",
            author: { role: "user" },
            content: { parts: ["ABANDONED message-parent branch"] },
            create_time: 1050,
          },
        },
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    assert.deepEqual(
      turns.map((turn) => turn.content),
      ["First message-parent user turn", "Second message-parent user turn"],
    );
  });

  it("falls back to sorted traversal when current_node is missing", () => {
    const conv = {
      mapping: {
        "msg-1": {
          id: "msg-1",
          parent: null,
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["alpha"] },
            create_time: 200,
          },
        },
        "msg-2": {
          id: "msg-2",
          parent: "msg-1",
          message: {
            id: "msg-2",
            author: { role: "user" },
            content: { parts: ["beta"] },
            create_time: 100,
          },
        },
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    // Sorted by create_time ascending.
    assert.deepEqual(
      turns.map((t) => t.content),
      ["beta", "alpha"],
    );
  });

  it("uses node id as a stable secondary sort key when timestamps tie", () => {
    const mkNode = (id: string) => ({
      id,
      parent: null,
      message: {
        id,
        author: { role: "user" },
        content: { parts: [`turn-${id}`] },
        create_time: 500, // all same timestamp
      },
    });
    const conv = {
      mapping: {
        "msg-c": mkNode("msg-c"),
        "msg-a": mkNode("msg-a"),
        "msg-b": mkNode("msg-b"),
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    // Stable order: node id ascending.
    assert.deepEqual(
      turns.map((t) => t.content),
      ["turn-msg-a", "turn-msg-b", "turn-msg-c"],
    );
  });

  // Codex review on PR #595 — when current_node's parent chain is broken
  // (dangling reference to a node that doesn't exist in mapping),
  // followCurrentNodeChain must return [] rather than a partial tail, so
  // the caller falls back to a timestamp-sorted traversal of ALL nodes.
  it("falls back to sorted traversal when current_node's parent chain is broken", () => {
    const conv = {
      current_node: "msg-3",
      mapping: {
        // msg-3 → parent "missing-id" which is NOT in the mapping.
        "msg-3": {
          id: "msg-3",
          parent: "missing-id",
          message: {
            id: "msg-3",
            author: { role: "user" },
            content: { parts: ["latest"] },
            create_time: 300,
          },
        },
        // These should still appear because we fall back to timestamp sort.
        "msg-1": {
          id: "msg-1",
          parent: null,
          message: {
            id: "msg-1",
            author: { role: "user" },
            content: { parts: ["oldest"] },
            create_time: 100,
          },
        },
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    assert.deepEqual(
      turns.map((t) => t.content),
      ["oldest", "latest"],
    );
  });

  // Codex review on PR #595 — parseChatGPTExport MUST reject undefined /
  // null input (what runImportCommand passes when --file is omitted) with
  // a user-facing error. Silently returning 0 memories masks bad CLI
  // invocations. Matches the gemini/claude slices.
  it("rejects missing input with a user-facing error", () => {
    assert.throws(() => parseChatGPTExport(undefined), /requires a file/);
    assert.throws(() => parseChatGPTExport(null), /requires a file/);
  });

  // Cursor review on PR #595 — asIsoString must not throw on corrupted
  // timestamps that overflow Date.toISOString's valid range.
  it("returns undefined for timestamps beyond Date's valid range", () => {
    const conv = {
      current_node: "m1",
      mapping: {
        m1: {
          id: "m1",
          parent: null,
          message: {
            id: "m1",
            author: { role: "user" },
            content: { parts: ["hello"] },
            // 1e20 seconds → vastly beyond Date's safe range
            create_time: 1e20,
          },
        },
      },
    };
    const turns = collectUserTurnsFromConversation(conv);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.createdAt, undefined);
  });
});
