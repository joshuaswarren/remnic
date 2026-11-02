import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { SmartBuffer } from "./buffer.js";
import { resetExtractionLlmHealthForTests } from "./extraction-llm-health.js";
import { Orchestrator } from "./orchestrator.js";
import { ContentHashIndex } from "./storage.js";
import {
  cleanupDir,
  harmonicNodeStoreStatus,
  makeHarmonicLifecycleConfig,
  makeLifecycleConfig,
  mkTempMemoryDir,
  stubExtraction,
} from "./testing/orchestrator-lite.js";
import type { ExtractionResult } from "./types.js";

/** Owner contract for the private Orchestrator temporal/tag batch hook. */
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
        (error: Error) => error === writeFailure,
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

test("#3231: entity failure after a committed fact still runs deferred post-write maintenance", async () => {
  // Partial-success path: fact (preference) is durable, later writeEntity throws.
  // Batch-end finalization in persistExtraction (hash flush, behavior ledger,
  // harmonic construction, temporal/tag index) and runExtraction's
  // requestQmdMaintenance must still cover the earlier durable write. Retry
  // exact-dedupes the fact (`continue`), so those effects are not re-queued.
  const memoryDir = await mkTempMemoryDir("entity-write-failure-maintenance");
  const preference =
    "Prefers terse queue names for background jobs in Project Alpha.";
  const config = makeHarmonicLifecycleConfig(memoryDir, {
    chunkingEnabled: false,
    multiGraphMemoryEnabled: false,
    factDeduplicationEnabled: true,
    extractionMinImportanceLevel: "trivial",
    entityActivityLogEnabled: false,
    queryAwareIndexingEnabled: true,
  });
  const orchestrator = new Orchestrator(config);
  const storage = await orchestrator.getStorageForNamespace();
  const writeEntity = storage.writeEntity.bind(storage);
  const temporalIdBatches: string[][] = [];
  // Bracket access is TypeScript's typed escape hatch for the private method; the spy only wraps and restores it.
  const originalTemporal = orchestrator["updateTemporalTagIndexes"].bind(orchestrator);
  orchestrator["updateTemporalTagIndexes"] = async (target, persistedIds) => {
    temporalIdBatches.push([...persistedIds]);
    return originalTemporal(target, persistedIds);
  };
  let qmdMaintenanceCalls = 0;
  const originalQmd = orchestrator.requestQmdMaintenance.bind(orchestrator);
  orchestrator.requestQmdMaintenance = () => {
    qmdMaintenanceCalls += 1;
    originalQmd();
  };
  try {
    await storage.ensureDirectories();
    await orchestrator.buffer.load();
    const bufferKey = "entity-write-failure-maintenance";
    await orchestrator.buffer.addTurn(bufferKey, {
      role: "user",
      content: preference,
      sessionKey: bufferKey,
      timestamp: "2026-10-01T12:00:00.000Z",
      sourceValidAt: "2026-10-01T12:00:00.000Z",
      persistProcessedFingerprint: true,
    });
    await orchestrator.buffer.flushPendingSave({ throwOnFailure: true });
    const turns = orchestrator.buffer.getTurns(bufferKey);
    assert.equal(turns.length, 1);
    stubExtraction(orchestrator, (): ExtractionResult => ({
      facts: [
        {
          content: preference,
          category: "preference",
          confidence: 0.95,
          tags: ["queue-naming"],
        },
      ],
      entities: [{ name: "Alpha", type: "project", facts: ["Uses a queue"] }],
      questions: [],
      profileUpdates: [],
    }));
    const writeFailure = Object.assign(new Error("synthetic entity write denied"), {
      code: "EACCES",
    });
    storage.writeEntity = async () => {
      throw writeFailure;
    };

    await assert.rejects(
      orchestrator.runExtraction(turns, { bufferKey }),
      (error: Error) => error === writeFailure,
      "entity I/O failure must still reach the caller",
    );

    const facts = (await storage.readAllMemories()).filter(
      (m) => m.frontmatter.category === "preference",
    );
    assert.equal(facts.length, 1, "the preference fact must remain durable");
    const factId = facts[0]!.frontmatter.id;
    const hashes = new ContentHashIndex(path.join(storage.dir, "state"));
    await hashes.load();
    assert.equal(hashes.has(preference), true, "deferred fact hash must flush before rejection");

    const signals = await storage.readBehaviorSignals(50);
    assert.ok(
      signals.some(
        (s) => s.memoryId === factId && s.signalType === "preference_affinity",
      ),
      "batch-end behavior-signal append must cover the committed preference before rethrow",
    );

    const harmonic = await harmonicNodeStoreStatus(memoryDir);
    assert.equal(harmonic.nodes.invalid, 0);
    assert.ok(
      harmonic.nodes.valid > 0 && (harmonic.latestNode?.sourceMemoryIds ?? []).includes(factId),
      "batch-end harmonic construction must cover the committed fact before rethrow",
    );

    assert.ok(
      temporalIdBatches.some((ids) => ids.includes(factId)),
      "batch-end temporal/tag index update must include the committed fact before rethrow",
    );
    assert.ok(
      qmdMaintenanceCalls > 0,
      "partial durable writes must still schedule QMD reindex before the entity error propagates",
    );

    // Retry exact-dedupes the preference (`continue`), so missing deferred
    // effects are not re-queued. Prove the failure-path finalization is the
    // only chance they have to land.
    storage.writeEntity = writeEntity;
    const retried = await orchestrator.runExtraction(turns, { bufferKey });
    assert.equal(retried.status, "completed");
    assert.equal(
      (await storage.readAllMemories()).filter((m) => m.frontmatter.category === "preference").length,
      1,
      "retry must not duplicate the already-committed preference",
    );
    assert.ok(
      (await storage.readBehaviorSignals(50)).some(
        (s) => s.memoryId === factId && s.signalType === "preference_affinity",
      ),
      "behavior signals must survive retry without relying on re-queue from the deduped fact",
    );
    assert.ok(
      ((await harmonicNodeStoreStatus(memoryDir)).latestNode?.sourceMemoryIds ?? []).includes(factId),
      "harmonic records must survive retry without relying on re-queue from the deduped fact",
    );
  } finally {
    storage.writeEntity = writeEntity;
    orchestrator.requestQmdMaintenance = originalQmd;
    orchestrator["updateTemporalTagIndexes"] = originalTemporal;
    try {
      await orchestrator.destroy();
    } finally {
      resetExtractionLlmHealthForTests();
      await cleanupDir(memoryDir);
    }
  }
});

