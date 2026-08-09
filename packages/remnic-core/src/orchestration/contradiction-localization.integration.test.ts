import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { Orchestrator } from "../orchestrator.js";
import type { ExtractionResult, ExtractionEngine, PluginConfig } from "../types.js";
import type { StorageManager } from "../storage.js";
import { ContradictionLinkingCoordinator } from "./contradiction-linking-coordinator.js";

function baseConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "test-key",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    contradictionDetectionEnabled: true,
    contradictionLocalization: {
      anchorEnabled: true,
      anchorCandidates: 5,
      searchCandidates: 5,
      maxCandidates: 8,
    },
  });
}

function extractionResult(fact: Record<string, unknown>): ExtractionResult {
  return {
    facts: [fact],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as unknown as ExtractionResult;
}

test("persistExtraction forwards ExtractedFact anchors to contradiction detection", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-anchor-"));
  try {
    const orchestrator = new Orchestrator(baseConfig(memoryDir)) as unknown as {
      qmd: { isAvailable: () => boolean };
      getStorage: (namespace: string) => Promise<StorageManager>;
      persistExtraction: (result: ExtractionResult, storage: StorageManager, threadId: null) => Promise<unknown>;
      contradictionLinkingCoordinator: ContradictionLinkingCoordinator;
    };
    orchestrator.qmd = { isAvailable: () => true };
    const calls: unknown[][] = [];
    orchestrator.contradictionLinkingCoordinator.checkForContradiction = async (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    await orchestrator.persistExtraction(
      extractionResult({
        category: "fact",
        content: "Alice lives in New York",
        confidence: 0.95,
        tags: [],
        entityRef: "person:alice",
        structuredAttributes: { city: "New York" },
      }),
      storage,
      null,
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.[3], {
      entityRef: "person:alice",
      structuredAttributes: { city: "New York" },
    });
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("anchor-only contradiction flows through deferred resolve and supersedes the old memory", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-contradiction-deferred-"));
  try {
    const config = baseConfig(memoryDir) as PluginConfig;
    const old = {
      path: "/synthetic/default/old.md",
      content: "Alice lives in Austin",
      frontmatter: {
        id: "old",
        category: "fact",
        created: "2026-08-01T00:00:00.000Z",
        updated: "2026-08-01T00:00:00.000Z",
        source: "test",
        confidence: 0.9,
        confidenceTier: "explicit",
        tags: [],
        status: "active",
        entityRef: "person:alice",
        structuredAttributes: { city: "Austin" },
      },
    } as never;
    const storage = {
      readAllMemories: async () => [old],
      getMemoryById: async (id: string) => (id === "old" ? old : null),
      supersedeMemory: async (id: string) => {
        if (id !== "old") return false;
        old.frontmatter.status = "superseded";
        return true;
      },
    } as never as StorageManager;
    const extraction = {
      verifyContradiction: async () => ({
        isContradiction: true,
        confidence: 0.99,
        reasoning: "city changed",
        whichIsNewer: "second",
      }),
    } as unknown as ExtractionEngine;
    const coordinator = new ContradictionLinkingCoordinator({
      getConfig: () => config,
      isSearchAvailable: () => true,
      searchAcrossNamespaces: async () => [],
      extractMemoryIdsFromResults: () => [],
      namespaceFromPath: () => "default",
      storageForNamespace: async () => storage,
      getExtraction: () => extraction,
    });

    const contradiction = await coordinator.checkForContradiction(
      "Alice lives in New York",
      "fact",
      "default",
      { entityRef: "person:alice", structuredAttributes: { city: "New York" } },
    );
    assert.equal(contradiction?.supersededId, "old");

    await coordinator.applyDeferredContradictionResolve(contradiction, storage, "new", false);
    assert.equal(old.frontmatter.status, "superseded");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
