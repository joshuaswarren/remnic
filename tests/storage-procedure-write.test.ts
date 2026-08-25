import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdtemp, rm } from "node:fs/promises";
import { StorageManager } from "@remnic/core/storage";
import {
  buildProcedureMarkdownBody,
  parseProcedureStepsFromBody,
} from "../packages/remnic-core/src/procedural/procedure-types.ts";

test("procedure markdown helpers round-trip ordered steps", () => {
  const body = buildProcedureMarkdownBody([
    { order: 1, intent: "Open the repo", toolCall: { kind: "shell", signature: "cd project && ls" } },
    { order: 2, intent: "Run tests", expectedOutcome: "All green" },
  ]);
  const parsed = parseProcedureStepsFromBody(body);
  assert.ok(parsed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].intent, "Open the repo");
  assert.equal(parsed[0].toolCall?.kind, "shell");
  assert.equal(parsed[1].intent, "Run tests");
  assert.equal(parsed[1].expectedOutcome, "All green");
});

test("StorageManager.writeMemory writes procedure memories under procedures/<date>/", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-engram-procedure-write-"));
  try {
    const storage = new StorageManager(dir);
    const body = buildProcedureMarkdownBody([{ order: 1, intent: "Ship the fix" }]);
    const { id: id } = await storage.writeMemory("procedure", body, {
      source: "test",
      status: "pending_review",
    });

    const today = new Date().toISOString().slice(0, 10);
    const expected = path.join(dir, "procedures", today, `${id}.md`);
    await access(expected);

    const memories = await storage.readAllMemories();
    const found = memories.find((m) => m.frontmatter.id === id);
    assert.ok(found);
    assert.equal(found.frontmatter.category, "procedure");
    assert.equal(found.frontmatter.status, "pending_review");
    assert.ok(found.path.replace(/\\/g, "/").includes("/procedures/"));

    const again = parseProcedureStepsFromBody(found.content);
    assert.ok(again);
    assert.equal(again[0].intent, "Ship the fix");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
