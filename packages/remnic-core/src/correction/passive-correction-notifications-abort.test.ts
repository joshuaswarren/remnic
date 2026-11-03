import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  drainPassiveCorrectionNotifications,
  enqueuePassiveCorrectionNotification,
} from "./passive-correction-notifications.js";

// Issue #3139 review: a briefing cancelled mid-drain must leave the queue
// intact, because the caller never receives what the drain consumed.
test("a drain cancelled after reading keeps the notification queue", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-3139-drain-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await enqueuePassiveCorrectionNotification(dir, {
    planId: "plan-1",
    summary: "kept",
    undoCommand: "undo",
    createdAt: new Date(0).toISOString(),
  });
  const controller = new AbortController();
  const read: (file: string, encoding: "utf-8") => Promise<string> = fs.readFile;
  t.mock.method(fs, "readFile", async (file: string) => {
    const content = await read(file, "utf-8");
    controller.abort(new Error("deadline"));
    return content;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(drainPassiveCorrectionNotifications(dir, controller.signal), { name: "AbortError" });

  t.mock.restoreAll();
  syncBuiltinESMExports();
  const kept = await drainPassiveCorrectionNotifications(dir);
  assert.equal(kept.length, 1, "the cancelled drain must not consume the queue");
});
