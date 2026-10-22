import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../packages/remnic-core/src/config.js";
import { Orchestrator } from "../packages/remnic-core/src/orchestrator.js";
import { withHeldFileLock } from "../packages/remnic-core/src/utils/serialize-mutations.js";

/** The real filesystem lock polls the platform clock; fake time cannot drive its I/O. */
async function remainsPending(work: Promise<void>): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => timeout.resolve(true), 100);
  try {
    return await Promise.race([
      work.then(() => false),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const namespaced of [false, true]) {
  test(`background startup migration belongs to readiness and shutdown (namespaces=${namespaced})`, async () => {
    const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migration-shutdown-"));
    const orchestrator = new Orchestrator(parseConfig({
      memoryDir, workspaceDir: path.join(memoryDir, "workspace"), namespacesEnabled: namespaced,
      qmdEnabled: false, localLlmEnabled: false, openaiApiKey: false,
      embeddingFallbackEnabled: false, identityContinuityEnabled: false,
      transcriptEnabled: false, hourlySummariesEnabled: false, compoundingEnabled: false,
      knowledgeIndexEnabled: false, factDeduplicationEnabled: false,
    }));
    const storage = namespaced ? await orchestrator.getStorage("shared") : orchestrator.storage;
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withHeldFileLock(path.join(storage.dir, "state", "entity-canonical-id-migration.lock"),
      { staleMs: 60_000, maxWaitMs: 60_000 }, async () => {
        acquired.resolve();
        await release.promise;
      });
    let shutdown: Promise<void> | undefined;
    try {
      await acquired.promise;
      await orchestrator.initialize();
      assert.equal(await remainsPending(orchestrator.deferredReady), true, "full readiness must own the replay");
      shutdown = orchestrator.destroy();
      assert.equal(await remainsPending(shutdown), true, "shutdown must wait for its active storage writer");
      release.resolve();
      await holder;
      await shutdown;
      await orchestrator.deferredReady;
      await stat(path.join(storage.dir, "state", "entity-canonical-id-migration-v1.json"));
      await rm(memoryDir, { recursive: true, force: true });
      await assert.rejects(stat(memoryDir), { code: "ENOENT" });
    } finally {
      release.resolve();
      await holder;
      await (shutdown ?? orchestrator.destroy());
      await rm(memoryDir, { recursive: true, force: true });
    }
  });
}
