import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { parseConfig } from "./config.js";
import { SecureStoreLockedError } from "./secure-store/secure-fs.js";
import { StorageManager } from "./storage.js";
import { cleanupDir } from "./testing/orchestrator-lite.js";

test.afterEach(() => {
  mock.restoreAll();
});

function makeConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    recallPlannerEnabled: false,
    sharedContextEnabled: false,
    initGateTimeoutMs: 1000,
  });
}

// Issue #3530 review (w86): applySecureStoreKey invalidates
// knowledgeIndexCache but does not advance entityMutationVersion, so an
// in-flight readAllEntityFiles started while unlocked can publish decrypted
// ScoredEntity[] after the store locks — and a subsequent locked call hits
// that cache and returns plaintext summaries it must not serve.
test("a mid-scan secure-store lock cannot publish a decrypted index the locked store then serves (#3530)", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-ki-lock-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.setSecureStoreKeyAndWait(randomBytes(32), true);
    await storage.writeEntity("Alice", "person", ["Alice secret launch fact"]);

    // Hold the first corpus read's RETURN open after it has decrypted while
    // unlocked, so the lock lands inside the publish window deterministically.
    let calls = 0;
    let firstDecrypted!: () => void;
    let releaseFirst!: () => void;
    const decrypted = new Promise<void>((r) => {
      firstDecrypted = r;
    });
    const hold = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const origRead = StorageManager.prototype.readAllEntityFiles;
    t.mock.method(
      StorageManager.prototype,
      "readAllEntityFiles",
      async function (this: StorageManager, ...args: Parameters<StorageManager["readAllEntityFiles"]>) {
        calls += 1;
        const rows = await origRead.apply(this, args);
        if (calls === 1) {
          firstDecrypted();
          await hold;
        }
        return rows;
      },
    );

    const config = makeConfig(memoryDir);
    const building = storage.buildKnowledgeIndex(config);
    await decrypted; // corpus decrypted in memory; publish has not happened yet
    await storage.setSecureStoreKeyAndWait(null); // lock mid-scan
    releaseFirst();
    const first = await building;
    assert.ok(first.result.includes("Alice"), "the unlocked caller keeps its decrypted result");

    // The publish must have been stamped with the secure-store key the scan
    // ran under. A locked call may not hit it: with the key validated the
    // cache misses and the rescan hits the locked store's own refusal.
    calls = 0; // any rescan now would prove the cache was not served
    await assert.rejects(
      storage.buildKnowledgeIndex(config),
      SecureStoreLockedError,
      "a locked store must not serve the decrypted index the mid-scan publish left behind",
    );
  } finally {
    await cleanupDir(memoryDir);
  }
});
