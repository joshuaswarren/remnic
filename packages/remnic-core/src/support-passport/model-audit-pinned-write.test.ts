import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { HeldFileLockController } from "../utils/serialize-mutations.js";
import type { SupportPassportModelAuditRecord } from "./model-audit.js";
import { SupportPassportModelAuditRecordSchema, SupportPassportModelAuditStore } from "./model-audit.js";

function auditRecord(): SupportPassportModelAuditRecord {
  return SupportPassportModelAuditRecordSchema.parse({
    schemaVersion: 1,
    operation: "draft_cards",
    actorHash: "a".repeat(64),
    subjectIdsHash: "b".repeat(64),
    modelUsed: "gateway/test-model",
    route: "gateway",
    outputSchemaVersion: 1,
    outcome: "success",
    occurredAt: "2026-08-11T12:00:00.000Z",
    latencyMs: 25,
  });
}

test("the model audit append stays in the pinned directory after a path swap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "remnic-support-model-audit-pinned-"));
  const auditDir = path.join(root, "state", "support-passport", "audit");
  const parkedAuditDir = path.join(root, "parked-audit");
  const record = auditRecord();
  const swapLock = (async (_lockPath, _options, task) => {
    await rename(auditDir, parkedAuditDir);
    await mkdir(auditDir, { recursive: true });
    return await task(true, {
      refresh: async () => true,
    } as HeldFileLockController);
  }) as typeof import("../utils/serialize-mutations.js").withHeldFileLock;
  const store = new SupportPassportModelAuditStore({
    memoryDir: root,
    withHeldFileLock: swapLock,
  });

  try {
    await assert.rejects(
      store.record(record),
      /support passport audit directory must remain inside the memory directory/
    );
    await assert.rejects(
      readFile(path.join(auditDir, "2026-08-11.jsonl"), "utf8"),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
    );
    assert.deepEqual(
      JSON.parse((await readFile(path.join(parkedAuditDir, "2026-08-11.jsonl"), "utf8")).trim()),
      record
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
