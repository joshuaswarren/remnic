import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseClaudeExport } from "./parser.js";
import { transformClaudeExport } from "./transform.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("transformClaudeExport", () => {
  it("emits project docs + prompt_template by default (skips conversations)", () => {
    const parsed = parseClaudeExport(loadFixture("projects.json"), {
      filePath: "/tmp/claude.zip",
    });
    const memories = transformClaudeExport(parsed);
    // project[0]: 2 docs + 1 template. project[1]: empty. Total = 3.
    assert.equal(memories.length, 3);
    for (const m of memories) {
      assert.equal(m.sourceLabel, "claude");
      assert.equal(m.importedFromPath, "/tmp/claude.zip");
    }
    const kinds = memories.map((m) => m.metadata?.kind);
    assert.deepEqual(kinds, ["project_doc", "project_doc", "project_prompt_template"]);
  });

  it("skips empty docs and empty prompt_template", () => {
    const parsed = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "p-empty",
          name: "Empty",
          prompt_template: "   ",
          docs: [{ uuid: "d", filename: "blank.md", content: "" }],
        },
      ]),
    );
    const memories = transformClaudeExport(parsed);
    assert.equal(memories.length, 0);
  });

  it("does not emit conversations unless includeConversations is true", () => {
    const parsed = parseClaudeExport(loadFixture("conversations.json"));
    const defaultOut = transformClaudeExport(parsed);
    assert.equal(defaultOut.length, 0);
    const withConvs = transformClaudeExport(parsed, {
      includeConversations: true,
    });
    assert.equal(withConvs.length, 1);
    assert.equal(withConvs[0]?.metadata?.kind, "conversation_summary");
    assert.equal(withConvs[0]?.metadata?.humanTurns, 2);
  });

  it("truncates long conversation summaries at maxConversationSummaryChars", () => {
    const longText = "x".repeat(500);
    const parsed = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          name: "Long convo",
          chat_messages: Array.from({ length: 10 }, (_, i) => ({
            uuid: `m${i}`,
            sender: "human",
            text: longText,
          })),
        },
      ]),
    );
    const [memory] = transformClaudeExport(parsed, {
      includeConversations: true,
      maxConversationSummaryChars: 100,
    });
    assert.ok(memory);
    assert.ok(memory.content.length <= 100);
    assert.ok(memory.content.endsWith("..."));
  });

  it("honors maxMemories as a hard cap", () => {
    const parsed = parseClaudeExport(loadFixture("projects.json"));
    const memories = transformClaudeExport(parsed, { maxMemories: 1 });
    assert.equal(memories.length, 1);
  });

  it("preserves project + doc metadata on emitted memories", () => {
    const parsed = parseClaudeExport(loadFixture("projects.json"));
    const memories = transformClaudeExport(parsed);
    const doc = memories.find((m) => m.metadata?.kind === "project_doc");
    assert.ok(doc);
    assert.equal(doc.metadata?.projectName, "Synthetic weekend CLI");
    assert.equal(doc.metadata?.filename, "architecture.md");
    const tpl = memories.find((m) => m.metadata?.kind === "project_prompt_template");
    assert.ok(tpl);
    assert.equal(tpl.metadata?.projectName, "Synthetic weekend CLI");
  });

  // Cursor review on PR #598 — when the title alone is longer than
  // maxChars, the previous truncation logic produced content that
  // exceeded the cap.
  it("truncation never exceeds maxConversationSummaryChars with a long title", () => {
    const longTitle = "T".repeat(500);
    const parsed = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "long-title",
          name: longTitle,
          chat_messages: [
            {
              uuid: "m1",
              sender: "human",
              text: "short body",
            },
          ],
        },
      ]),
    );
    const [memory] = transformClaudeExport(parsed, {
      includeConversations: true,
      maxConversationSummaryChars: 100,
    });
    assert.ok(memory);
    assert.ok(
      memory.content.length <= 100,
      `content length ${memory.content.length} must be <= 100`,
    );
    assert.ok(memory.content.endsWith("..."));
  });

  // Cursor review on PR #598 — even when maxChars is below the suffix
  // length (3), content.length must never exceed maxChars. The earlier
  // fix unconditionally appended "..." which produced 3-char output for
  // maxChars=2.
  it("honors maxChars below the suffix length", () => {
    const longTitle = "T".repeat(500);
    const parsed = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "tiny-cap",
          name: longTitle,
          chat_messages: [
            { uuid: "m1", sender: "human", text: "body" },
          ],
        },
      ]),
    );
    for (const cap of [0, 1, 2]) {
      const [memory] = transformClaudeExport(parsed, {
        includeConversations: true,
        maxConversationSummaryChars: cap,
      });
      assert.ok(memory);
      assert.ok(
        memory.content.length <= cap,
        `content.length ${memory.content.length} must be <= ${cap}`,
      );
    }
  });
});
