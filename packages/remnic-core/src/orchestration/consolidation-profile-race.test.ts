import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "../storage.js";
import { ConsolidationRunCoordinator } from "./consolidation-run.js";
import type { ExtractionEngine } from "../extraction.js";
import type { PluginConfig } from "../types.js";

function raceConfig(): PluginConfig {
  return {
    memoryDir: "/synthetic/remnic-profile-race-tests",
    queryAwareIndexingEnabled: false,
    dependencyPropagation: { enabled: false, maxDependents: 0 },
  } as unknown as PluginConfig;
}

const PROFILE_SECTION = { consolidateTriggerLines: 2, consolidateTargetLines: 5 };

function makeRaceCoordinator(
  storage: StorageManager,
  extraction: ExtractionEngine,
): ConsolidationRunCoordinator {
  return new ConsolidationRunCoordinator({
    config: raceConfig(),
    getStorage: () => storage,
    getStorageRouter: () => ({ recordWrite: async () => {} }) as never,
    getExtraction: () => extraction,
    storageDirNamespace: () => "namespace-a",
    getDependencyPropagationDelivery: () =>
      ({
        prepare: async () => null,
        afterMutation: async () => {},
        cancel: () => {},
        deferPrepared: async () => {},
      }) as never,
    embeddingFallback: { removeFromIndex: async () => {} } as never,
    tmtBuilder: { maybeRebuildNodes: async () => {} } as never,
    consolidationObservers: new Set(),
    getAccessTrackingBuffer: () => new Map(),
    lifecyclePolicyCoordinator: {
      runFactArchival: async () => 0,
      runSummarization: async () => {},
      runTopicExtraction: async () => {},
    } as never,
    compressionGuidelineCoordinator: {
      runCompressionGuidelineLearningPass: async () => {},
    } as never,
    semanticConsolidationCoordinator: {} as never,
    entitySynthesisCoordinator: {} as never,
    recallSectionCoordinator: {
      getRecallSectionEntry: (sectionId: string) =>
        sectionId === "profile" ? PROFILE_SECTION : undefined,
    } as never,
    tierMigrationCoordinator: {
      runCycle: async () => ({ migrated: 0 }),
    } as never,
    flushAccessTracking: async () => {},
    indexPersistedMemory: async () => {},
    autoConsolidateIdentity: async () => {},
    fastChatCompletion: async () => null,
  });
}

/** Extraction fake whose consolidateProfile gates AFTER receiving the old
 * profile, exactly like a slow LLM call, so the test can interleave an append
 * inside the real await window (no fake timing). */
function makeGatedConsolidationExtraction(
  profilePassedToModel: PromiseWithResolvers<string>,
  releaseConsolidation: PromiseWithResolvers<void>,
  consolidatedProfile: string,
): ExtractionEngine {
  return {
    async consolidate() {
      return { items: [], profileUpdates: [], entityUpdates: [] };
    },
    async consolidateProfile(fullProfileContent: string) {
      profilePassedToModel.resolve(fullProfileContent);
      await releaseConsolidation.promise;
      return { consolidatedProfile, removedCount: 2, summary: "test consolidation" };
    },
  } as unknown as ExtractionEngine;
}

async function makeStorage(): Promise<{ storage: StorageManager; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-profile-consolidation-race-"));
  const storage = new StorageManager(root);
  // The consolidation pass early-returns below five memories; seed enough to
  // reach the profile branch.
  for (let i = 0; i < 5; i++) await storage.writeMemory("fact", `seed claim ${i}`);
  return { storage, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const BASE_PROFILE_LINES = ["# Behavioral Profile", "", "- trait one", "- trait two", "- trait three", ""];

test("profile consolidation keeps a concurrent append instead of clobbering it", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.writeProfile(BASE_PROFILE_LINES.join("\n"));

    const profilePassedToModel = Promise.withResolvers<string>();
    const releaseConsolidation = Promise.withResolvers<void>();
    const extraction = makeGatedConsolidationExtraction(
      profilePassedToModel,
      releaseConsolidation,
      "# Behavioral Profile\n\n- consolidated summary\n",
    );
    const coordinator = makeRaceCoordinator(storage, extraction);

    const run = coordinator.run();
    const baseline = await profilePassedToModel.promise;
    assert.equal(baseline, await storage.readProfile(), "model must receive the pre-consolidation profile");

    // Concurrent extractor appends during the real LLM await window.
    await storage.appendToProfile(["unique concurrent bullet"]);

    releaseConsolidation.resolve();
    await run;

    const profile = await storage.readProfile();
    assert.match(profile, /unique concurrent bullet/, "append made during consolidation must survive");
    assert.doesNotMatch(profile, /consolidated summary/, "stale consolidation must not be committed");
  } finally {
    await cleanup();
  }
});

test("profile consolidation commits when the profile is unchanged during the LLM call", async () => {
  const { storage, cleanup } = await makeStorage();
  try {
    await storage.writeProfile(BASE_PROFILE_LINES.join("\n"));

    const profilePassedToModel = Promise.withResolvers<string>();
    const releaseConsolidation = Promise.withResolvers<void>();
    const extraction = makeGatedConsolidationExtraction(
      profilePassedToModel,
      releaseConsolidation,
      "# Behavioral Profile\n\n- consolidated summary\n",
    );
    const coordinator = makeRaceCoordinator(storage, extraction);

    const run = coordinator.run();
    await profilePassedToModel.promise;
    releaseConsolidation.resolve();
    await run;

    const profile = await storage.readProfile();
    assert.match(profile, /consolidated summary/, "unchanged profile must take the consolidation");
    assert.doesNotMatch(profile, /trait one/, "consolidation replaces the old bullets");
  } finally {
    await cleanup();
  }
});
