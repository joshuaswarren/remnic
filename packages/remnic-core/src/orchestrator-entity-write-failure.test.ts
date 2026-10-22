import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { resetExtractionLlmHealthForTests } from "./extraction-llm-health.js";
import { Orchestrator } from "./orchestrator.js";
import { ContentHashIndex } from "./storage.js";
import {
  cleanupDir,
  makeLifecycleConfig,
  mkTempMemoryDir,
  stubExtraction,
} from "./testing/orchestrator-lite.js";
import type { ExtractionResult } from "./types.js";

const FACT = "Project Alpha uses a queue for background processing.";

for (const includeFact of [false, true]) {
  test(`#3228: entity write failure retains input${includeFact ? " after a committed fact" : ""}`, async () => {
    const memoryDir = await mkTempMemoryDir("entity-write-failure");
    const config = makeLifecycleConfig(memoryDir, {
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      extractionMinImportanceLevel: "trivial",
      entityActivityLogEnabled: false,
    });
    const orchestrator = new Orchestrator(config);
    const storage = await orchestrator.getStorageForNamespace();
    const writeEntity = storage.writeEntity.bind(storage);
    try {
      await storage.ensureDirectories();
      const entityName = storage.normalizeEntityName("Alpha", "project");
      await orchestrator.buffer.load();
      const bufferKey = "entity-write-failure";
      await orchestrator.buffer.addTurn(bufferKey, {
        role: "user",
        content: FACT,
        sessionKey: bufferKey,
        timestamp: "2026-10-01T12:00:00.000Z",
        sourceValidAt: "2026-10-01T12:00:00.000Z",
        persistProcessedFingerprint: true,
      });
      await orchestrator.buffer.flushPendingSave({ throwOnFailure: true });
      const turns = orchestrator.buffer.getTurns(bufferKey);
      assert.equal(turns.length, 1, "the source turn must be durably buffered before extraction");
      const before = await storage.loadMeta();
      const extractionCalls = stubExtraction(orchestrator, (): ExtractionResult => ({
        facts: includeFact
          ? [{ content: FACT, category: "fact", confidence: 0.9, tags: [] }]
          : [],
        entities: [{ name: "Alpha", type: "project", facts: ["Uses a queue"] }],
        questions: [],
        profileUpdates: [],
      }));
      const writeFailure = Object.assign(new Error("synthetic entity write denied"), { code: "EACCES" });
      let entityWriteAttempts = 0;
      storage.writeEntity = async (...args: Parameters<typeof writeEntity>) => {
        entityWriteAttempts += 1;
        assert.deepEqual(args.slice(0, 3), ["Alpha", "project", ["Uses a queue"]]);
        throw writeFailure;
      };
      let commits = 0;
      const options = { bufferKey, onDurableCommit: () => { commits += 1; } };

      await assert.rejects(
        orchestrator.runExtraction(turns, options),
        (error: unknown) => error === writeFailure,
        "the original entity I/O failure must reach the caller",
      );
      assert.equal(entityWriteAttempts, 1, "the failure must come from the real entity persistence path");
      assert.equal(commits, 0, "a failed batch must not signal durable completion");
      assert.deepEqual(orchestrator.buffer.getTurns(bufferKey), turns);
      const retainedBuffer = new SmartBuffer(config, storage);
      await retainedBuffer.load();
      assert.deepEqual(retainedBuffer.getTurns(bufferKey), turns, "source turns must remain on disk too");
      const failedMeta = await storage.loadMeta();
      assert.equal(failedMeta.processedExtractionFingerprints?.length ?? 0, 0);
      assert.equal(failedMeta.extractionCount, before.extractionCount);
      assert.equal(await storage.readEntity(entityName), "", "the failed entity was not written");

      const factsBeforeRetry = (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "fact");
      assert.equal(factsBeforeRetry.length, includeFact ? 1 : 0);
      if (includeFact) {
        const hashes = new ContentHashIndex(path.join(storage.dir, "state"));
        await hashes.load();
        assert.equal(hashes.has(FACT), true, "the earlier fact's deferred hash must be durable before rejection");
      }

      storage.writeEntity = writeEntity;
      const retried = await orchestrator.runExtraction(turns, options);
      assert.equal(retried.status, "completed");
      assert.equal(retried.persistedCount, 1, "retry writes the entity, not another copy of an earlier fact");
      assert.equal(commits, 1);
      assert.match(await storage.readEntity(entityName), /Uses a queue/);
      assert.equal((await storage.listEntityNames()).length, 1);
      const factsAfterRetry = (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "fact");
      assert.deepEqual(
        factsAfterRetry.map((m) => m.frontmatter.id),
        factsBeforeRetry.map((m) => m.frontmatter.id),
        "retry must preserve the already committed fact without duplicating it",
      );
      assert.equal((await storage.loadMeta()).processedExtractionFingerprints?.length, 1);
      assert.equal(orchestrator.buffer.getTurns(bufferKey).length, 0);
      const clearedBuffer = new SmartBuffer(config, storage);
      await clearedBuffer.load();
      assert.equal(clearedBuffer.getTurns(bufferKey).length, 0);
      assert.equal((await orchestrator.runExtraction(turns, options)).reason, "processed_fingerprint");
      assert.equal(extractionCalls.length, 2, "only the failed attempt and successful retry call the extractor");
      assert.equal(commits, 1, "processed replay must not emit a second commit");
    } finally {
      storage.writeEntity = writeEntity;
      try {
        await orchestrator.destroy();
      } finally {
        resetExtractionLlmHealthForTests();
        await cleanupDir(memoryDir);
      }
    }
  });
}
