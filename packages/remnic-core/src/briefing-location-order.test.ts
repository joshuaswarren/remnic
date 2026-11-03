import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngramAccessService } from "./access-service.js";
import { enqueuePassiveCorrectionNotification } from "./correction/passive-correction-notifications.js";
import { parseLocationConfig } from "./location/config.js";
import { locationSyncStateFilePath } from "./location/store.js";
import { StorageManager } from "./storage.js";

// Issue #3139 review: the access-service briefing (HTTP and MCP) appends a
// location section. buildBriefing drains correction notifications at most
// once, so an abort during the location read must not follow the drain.
test("an abort during the briefing location read keeps the correction notifications", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "remnic-3139-location-order-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const storage = new StorageManager(dir);
  await enqueuePassiveCorrectionNotification(dir, {
    planId: "plan-1",
    summary: "kept",
    undoCommand: "undo",
    createdAt: new Date(0).toISOString(),
  });
  const queueFile = path.join(dir, "state", "corrections", "notifications.jsonl");
  const orchestrator = {
    config: {
      memoryDir: dir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["global"],
      searchBackend: "qmd",
      qmdEnabled: false,
      nativeKnowledge: undefined,
      openaiApiKey: false,
      model: "test-model",
      location: parseLocationConfig({ enabled: true, timezone: "UTC", sources: [{ id: "reitti" }], tagging: { enabled: true } }),
      briefing: {
        enabled: true,
        defaultWindow: "yesterday",
        defaultFormat: "markdown",
        maxFollowups: 0,
        calendarSource: null,
        saveByDefault: false,
        saveDir: null,
        llmFollowups: false,
      },
    },
    getStorage: async () => storage,
  };
  // SAFETY: the briefing path reads only the config and getStorage members stubbed above.
  const service = new EngramAccessService(orchestrator as never);

  const controller = new AbortController();
  const read: (file: string, encoding: "utf-8") => Promise<string> = fs.readFile;
  t.mock.method(fs, "readFile", async (file: string, encoding: "utf-8") => {
    if (String(file) === locationSyncStateFilePath(dir)) controller.abort(new Error("deadline"));
    return read(file, encoding);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  await assert.rejects(
    service.briefing({ includeLocation: true, abortSignal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(existsSync(queueFile), true, "an abort during the location read must not consume the queue");
});
