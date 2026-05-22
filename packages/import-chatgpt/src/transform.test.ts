import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseChatGPTExport } from "./parser.js";
import { transformChatGPTExport, CHATGPT_SOURCE_LABEL } from "./transform.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf-8"));
}

describe("transformChatGPTExport", () => {
  it("emits one memory per saved-memory entry with provenance", () => {
    const parsed = parseChatGPTExport(loadFixtureJson("saved-memories-2026.json"), {
      filePath: "/tmp/chatgpt.zip/memory.json",
    });
    const memories = transformChatGPTExport(parsed);
    assert.equal(memories.length, 2);
    for (const memory of memories) {
      assert.equal(memory.sourceLabel, CHATGPT_SOURCE_LABEL);
      assert.equal(memory.importedFromPath, "/tmp/chatgpt.zip/memory.json");
      assert.equal(
        (memory.metadata as { kind?: string } | undefined)?.kind,
        "saved_memory",
      );
    }
    assert.equal(
      memories[0].sourceId,
      "11111111-aaaa-4000-8000-000000000001",
    );
    assert.equal(
      (memories[1].metadata as { pinned?: boolean }).pinned,
      true,
    );
  });

  it("skips conversations by default", () => {
    const parsed = parseChatGPTExport(
      loadFixtureJson("conversations-mapping.json"),
    );
    const memories = transformChatGPTExport(parsed);
    assert.equal(memories.length, 0);
  });

  it("emits one memory per conversation when includeConversations is true", () => {
    const parsed = parseChatGPTExport(
      loadFixtureJson("conversations-mapping.json"),
    );
    const memories = transformChatGPTExport(parsed, {
      includeConversations: true,
    });
    assert.equal(memories.length, 1);
    const [memory] = memories;
    assert.equal(memory.sourceLabel, CHATGPT_SOURCE_LABEL);
    assert.equal(memory.sourceId, "synthetic-conv-0001");
    assert.ok(
      memory.content.includes("synthetic weekend project"),
      `expected user turn text in: ${memory.content}`,
    );
    assert.equal(
      (memory.metadata as { kind?: string }).kind,
      "conversation_summary",
    );
    assert.equal(
      (memory.metadata as { userTurns?: number }).userTurns,
      2,
    );
  });

  it("uses conversation timestamps when user messages have no timestamps", () => {
    const parsed = parseChatGPTExport({
      conversations: [
        {
          id: "c1",
          create_time: 1737763200,
          mapping: {
            a: {
              id: "a",
              message: {
                author: { role: "user" },
                content: { parts: ["hello from the timestamp fallback"] },
              },
            },
          },
        },
      ],
    });

    const memories = transformChatGPTExport(parsed, {
      includeConversations: true,
    });

    assert.equal(memories.length, 1);
    assert.equal(memories[0].sourceTimestamp, "2025-01-25T00:00:00.000Z");
  });

  it("respects maxConversationSummaryChars truncation", () => {
    // Build a synthetic parsed shape with a long user turn.
    const longTurn = "x".repeat(5000);
    const parsed = parseChatGPTExport({
      conversations: [
        {
          id: "synth-truncate",
          title: "truncate me",
          mapping: {
            a: {
              id: "a",
              message: {
                author: { role: "user" },
                content: { parts: [longTurn] },
                create_time: 1737763200,
              },
            },
          },
        },
      ],
    });
    const memories = transformChatGPTExport(parsed, {
      includeConversations: true,
      maxConversationSummaryChars: 200,
    });
    assert.equal(memories.length, 1);
    assert.ok(memories[0].content.endsWith("..."));
    assert.ok(memories[0].content.length <= 210);
  });

  it("honors maxMemories as a hard cap", () => {
    const parsed = parseChatGPTExport(
      loadFixtureJson("saved-memories-2026.json"),
    );
    const memories = transformChatGPTExport(parsed, { maxMemories: 1 });
    assert.equal(memories.length, 1);
  });

  it("normalizes saved-memory timestamps and omits invalid values", () => {
    const parsed = parseChatGPTExport({
      memory: [
        {
          id: "valid",
          content: "Valid timestamp memory",
          updated_at: 1737763200,
        },
        {
          id: "invalid",
          content: "Invalid timestamp memory",
          updated_at: "not-a-date",
          created_at: "also-not-a-date",
        },
        {
          id: "fallback",
          content: "Fallback timestamp memory",
          updated_at: "not-a-date",
          created_at: "2025-01-25T00:00:00.000Z",
        },
      ],
    });

    const memories = transformChatGPTExport(parsed);

    assert.equal(memories.length, 3);
    assert.equal(memories[0].sourceTimestamp, "2025-01-25T00:00:00.000Z");
    assert.equal(memories[1].sourceTimestamp, undefined);
    assert.equal(memories[2].sourceTimestamp, "2025-01-25T00:00:00.000Z");
  });

  // Cursor review on PR #595 — when the title alone is longer than maxChars,
  // the previous truncation logic produced content that exceeded the cap.
  it("truncation never exceeds maxConversationSummaryChars even with a long title", () => {
    const longTitle = "T".repeat(500);
    const parsed = parseChatGPTExport({
      conversations: [
        {
          id: "long-title",
          title: longTitle,
          mapping: {
            a: {
              id: "a",
              message: {
                author: { role: "user" },
                content: { parts: ["short body"] },
                create_time: 1737763200,
              },
            },
          },
        },
      ],
    });
    const memories = transformChatGPTExport(parsed, {
      includeConversations: true,
      maxConversationSummaryChars: 100,
    });
    assert.equal(memories.length, 1);
    assert.ok(
      memories[0].content.length <= 100,
      `content length ${memories[0].content.length} must be <= 100, got: ${memories[0].content.slice(0, 50)}...`,
    );
    assert.ok(memories[0].content.endsWith("..."));
  });

  it("truncation never exceeds tiny maxConversationSummaryChars caps", () => {
    const parsed = parseChatGPTExport({
      conversations: [
        {
          id: "tiny-cap",
          mapping: {
            a: {
              id: "a",
              message: {
                author: { role: "user" },
                content: { parts: ["hello"] },
                create_time: 1737763200,
              },
            },
          },
        },
      ],
    });

    for (const cap of [0, 1, 2]) {
      const memories = transformChatGPTExport(parsed, {
        includeConversations: true,
        maxConversationSummaryChars: cap,
      });
      assert.equal(memories.length, 1);
      assert.ok(
        memories[0].content.length <= cap,
        `content length ${memories[0].content.length} must be <= ${cap}`,
      );
    }
  });
});
