import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectHumanTurnsFromConversation,
  parseClaudeExport,
} from "./parser.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

describe("parseClaudeExport", () => {
  it("parses a projects-array fixture", () => {
    const parsed = parseClaudeExport(loadFixture("projects.json"));
    assert.equal(parsed.projects.length, 2);
    assert.equal(parsed.conversations.length, 0);
    assert.equal(parsed.projects[0]?.docs?.length, 2);
  });

  it("parses a conversations-array fixture", () => {
    const parsed = parseClaudeExport(loadFixture("conversations.json"));
    assert.equal(parsed.conversations.length, 1);
    assert.equal(parsed.projects.length, 0);
    assert.equal(parsed.conversations[0]?.chat_messages?.length, 3);
  });

  it("parses a combined bundle object", () => {
    const parsed = parseClaudeExport(loadFixture("bundle.json"));
    assert.equal(parsed.projects.length, 1);
    assert.equal(parsed.conversations.length, 1);
  });

  it("returns empty arrays on an empty input array (non-strict)", () => {
    const parsed = parseClaudeExport("[]");
    assert.equal(parsed.conversations.length, 0);
    assert.equal(parsed.projects.length, 0);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseClaudeExport("{not-json"), /not valid JSON/);
  });

  it("strict mode rejects unknown array shapes", () => {
    assert.throws(
      () => parseClaudeExport(JSON.stringify([{ hello: "world" }]), { strict: true }),
      /Unknown Claude export array shape/,
    );
  });

  it("preserves filePath in parsed output when provided", () => {
    const parsed = parseClaudeExport(loadFixture("bundle.json"), {
      filePath: "/tmp/claude-export.zip",
    });
    assert.equal(parsed.filePath, "/tmp/claude-export.zip");
  });

  it("collects only human turns from structured and plain content", () => {
    const parsed = parseClaudeExport(loadFixture("conversations.json"));
    const turns = collectHumanTurnsFromConversation(parsed.conversations[0]!);
    assert.equal(turns.length, 2);
    assert.ok(turns[0]?.content.includes("checklist"));
    assert.ok(turns[1]?.content.includes("CHANGELOG"));
  });

  it("accepts the `role` alias used by older exports", () => {
    const parsed = parseClaudeExport(loadFixture("bundle.json"));
    const turns = collectHumanTurnsFromConversation(parsed.conversations[0]!);
    assert.equal(turns.length, 1);
    assert.ok(turns[0]?.content.includes("bundle-world"));
  });

  it("strict mode rejects unknown object shapes", () => {
    assert.throws(
      () => parseClaudeExport({ foo: "bar" }, { strict: true }),
      /Unknown Claude export object shape/,
    );
  });

  it("non-strict mode returns an empty result for unknown object shapes", () => {
    const parsed = parseClaudeExport({ foo: "bar" });
    assert.equal(parsed.conversations.length, 0);
    assert.equal(parsed.projects.length, 0);
  });

  it("strict mode rejects malformed known object sections even when another section is valid", () => {
    assert.throws(
      () =>
        parseClaudeExport(
          {
            projects: [{ prompt_template: "keep" }],
            conversations: { bad: true },
          },
          { strict: true },
        ),
      /conversations section must be an array/,
    );
    assert.throws(
      () =>
        parseClaudeExport(
          {
            conversations: [{ chat_messages: [] }],
            projects: { bad: true },
          },
          { strict: true },
        ),
      /projects section must be an array/,
    );
  });

  it("throws when called without any input (undefined / null)", () => {
    assert.throws(() => parseClaudeExport(undefined), /requires a --file/);
    assert.throws(() => parseClaudeExport(null), /requires a --file/);
  });

  it("rejects primitive (non-object, non-array) input in every mode", () => {
    assert.throws(() => parseClaudeExport(42), /must be a JSON array or object/);
    assert.throws(() => parseClaudeExport(true), /must be a JSON array or object/);
    assert.throws(
      () => parseClaudeExport("42"),
      /must be a JSON array or object/,
    );
  });

  it("strict mode rejects name-only project fallback", () => {
    assert.throws(
      () => parseClaudeExport([{ name: "foo" }], { strict: true }),
      /Unknown Claude export array shape/,
    );
    assert.throws(
      () =>
        parseClaudeExport({ projects: [{ name: "foo" }] }, { strict: true }),
      /Non-project entry/,
    );
  });

  it("non-strict mode still accepts the name-only project fallback", () => {
    const parsed = parseClaudeExport([{ name: "foo" }]);
    assert.equal(parsed.projects.length, 1);
  });

  it("falls back to `messages` when `chat_messages` is an empty array", () => {
    const conv = {
      uuid: "legacy",
      name: "Legacy-shape conversation",
      chat_messages: [],
      messages: [
        {
          role: "human",
          text: "I only live in the messages array.",
        },
      ],
    };
    const turns = collectHumanTurnsFromConversation(conv);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.content, "I only live in the messages array.");
  });
});
