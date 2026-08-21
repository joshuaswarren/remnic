import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ImportTurn, ImporterWriteTarget } from "@remnic/core";
import { runImporter } from "@remnic/core";

import { adapter, claudeAdapter } from "./adapter.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

function makeTarget(): {
  target: ImporterWriteTarget;
  received: ImportTurn[][];
} {
  const received: ImportTurn[][] = [];
  return {
    target: {
      async ingestBulkImportBatch(turns) {
        received.push(turns.map((t) => ({ ...t })));
      },
      bulkImportWriteNamespace() {
        return "default";
      },
    },
    received,
  };
}

describe("claude adapter shape", () => {
  it("exports a canonical adapter + name-prefixed alias", () => {
    assert.equal(adapter.name, "claude");
    assert.equal(adapter.sourceLabel, "claude");
    assert.equal(claudeAdapter, adapter);
    assert.equal(typeof adapter.parse, "function");
    assert.equal(typeof adapter.transform, "function");
    assert.equal(typeof adapter.writeTo, "function");
  });

  it("drives runImporter end-to-end with a synthetic projects fixture", async () => {
    const { target, received } = makeTarget();
    const result = await runImporter(
      adapter,
      loadFixture("projects.json"),
      target,
      { parseOptions: { filePath: "/tmp/claude-export.zip/projects.json" } },
    );
    assert.equal(result.memoriesPlanned, 3);
    assert.equal(result.memoriesWritten, 3);
    assert.equal(result.sourceLabel, "claude");
    const allTurns = received.flat();
    assert.equal(allTurns.length, 3);
    for (const turn of allTurns) {
      assert.equal(turn.role, "user");
      assert.equal(turn.participantName, "claude");
    }
  });

  it("dry-run does not hit the target", async () => {
    const { target, received } = makeTarget();
    const result = await runImporter(
      adapter,
      loadFixture("projects.json"),
      target,
      { dryRun: true },
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.memoriesWritten, 0);
    assert.equal(received.length, 0);
  });

  it("skips conversations by default but imports them with includeConversations", async () => {
    const conversations = loadFixture("conversations.json");
    const t1 = makeTarget();
    const r1 = await runImporter(adapter, conversations, t1.target);
    assert.equal(r1.memoriesPlanned, 0);
    assert.equal(t1.received.length, 0);

    const t2 = makeTarget();
    const r2 = await runImporter(adapter, conversations, t2.target, {
      transformOptions: { includeConversations: true },
    });
    assert.equal(r2.memoriesPlanned, 1);
    assert.equal(r2.memoriesWritten, 1);
  });
});
