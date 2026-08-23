import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  loadImporterFixture,
  makeImporterTestTarget,
  runImporter,
} from "@remnic/core";

import { adapter, chatgptAdapter } from "./adapter.js";

const loadFixture = (name: string): string =>
  loadImporterFixture(import.meta.url, name);

describe("chatgpt adapter shape", () => {
  it("exports a canonical adapter + name-prefixed alias", () => {
    assert.equal(adapter.name, "chatgpt");
    assert.equal(adapter.sourceLabel, "chatgpt");
    assert.equal(chatgptAdapter, adapter);
    assert.equal(typeof adapter.parse, "function");
    assert.equal(typeof adapter.transform, "function");
    assert.equal(typeof adapter.writeTo, "function");
  });

  it("drives runImporter end-to-end with a synthetic saved-memories fixture", async () => {
    const { target, received } = makeImporterTestTarget();
    const result = await runImporter(
      adapter,
      loadFixture("saved-memories-2026.json"),
      target,
      { parseOptions: { filePath: "/tmp/chatgpt-export.zip/memory.json" } },
    );
    assert.equal(result.memoriesPlanned, 2);
    assert.equal(result.memoriesWritten, 2);
    assert.equal(result.sourceLabel, "chatgpt");
    assert.ok(received.length >= 1);
    const allTurns = received.flat();
    for (const turn of allTurns) {
      assert.equal(turn.role, "user");
      assert.equal(turn.participantName, "chatgpt");
    }
  });

  it("dry-run does not hit the target", async () => {
    const { target, received } = makeImporterTestTarget();
    const result = await runImporter(
      adapter,
      loadFixture("saved-memories-2026.json"),
      target,
      { dryRun: true },
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
  });

  it("skips conversations by default but imports them with --include-conversations", async () => {
    const conversations = loadFixture("conversations-mapping.json");
    const target1 = makeImporterTestTarget();
    const result1 = await runImporter(adapter, conversations, target1.target);
    assert.equal(result1.memoriesPlanned, 0);
    assert.equal(target1.received.length, 0);

    const target2 = makeImporterTestTarget();
    const result2 = await runImporter(adapter, conversations, target2.target, {
      transformOptions: { includeConversations: true },
    });
    assert.equal(result2.memoriesPlanned, 1);
    assert.equal(result2.memoriesWritten, 1);
  });
});
