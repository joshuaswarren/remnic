/**
 * PR #2016 regression: non-chunked parent fact-hash durability.
 *
 * Sibling to orchestrator-chunked-hash-durability.test.ts. When fact dedup is
 * enabled, the NON-chunked extraction path writes the fact memory with its
 * fact-content-hash flush DEFERRED to the end-of-method batch
 * saveContentHashIndexes() (issue #1909 batching). The fallible post-write work
 * that follows — applyDeferredContradictionResolve(), embedding index, shared
 * promotion, verbatim artifact write — can throw AFTER writeSealedMemory() has
 * made the `.md` durable but BEFORE that batch save runs. Left unguarded, the
 * durable fact would be missing from fact-hashes.txt until the next corpus
 * rebuild, so a peer with an already-built in-memory index could re-extract it
 * as a duplicate.
 *
 * Fix (extraction-persist.ts): the non-chunked path guards the post-write work
 * and flushes the deferred parent hash before propagating any failure, while
 * keeping #1909 batching on the success path. This test drives persistExtraction
 * through the real Orchestrator, forces the verbatim-artifact write to throw,
 * and asserts the fact's hash is already durable in the on-disk fact-hashes.txt
 * (loaded directly, NOT via a corpus rebuild that would reconstruct it anyway).
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ContentHashIndex, StorageManager } from "./storage.js";
import { sanitizeMemoryContent } from "./sanitize.js";
import type { ExtractionResult, MemoryFile } from "./types.js";

/** persistExtraction is private; reach it through an unknown-cast surface. */
interface OrchestratorTestSurface {
  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadId: string | null,
    sourceContext?: { sourceConnector?: string; validAt?: string },
  ) => Promise<string[]>;
  getStorage: (namespace: string) => Promise<StorageManager>;
}

/** A short single-sentence fact that does NOT chunk (non-chunked write path). */
const FACT_BODY = "The staging deploy pinned build 8421 as the rollback anchor.";

function factResult(content: string): ExtractionResult {
  return {
    facts: [{ content, category: "fact", confidence: 0.9, tags: [] }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
}

test("#2016: a non-chunked fact's hash is durable on disk before fallible post-write work", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-nonchunk-hash-durability-"),
  );
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      // Force the non-chunked write path.
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      // Make the fallible post-write verbatim-artifact write reachable for a
      // fact so the injected throw fires AFTER the durable .md write.
      verbatimArtifactsEnabled: true,
      verbatimArtifactCategories: ["fact"],
      verbatimArtifactsMinConfidence: 0.5,
    });
    const orchestrator = new Orchestrator(
      config,
    ) as unknown as OrchestratorTestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    // Deterministic failure: the verbatim-artifact write throws — after the
    // fact .md is durable and before the end-of-method saveContentHashIndexes().
    storage.writeArtifact = async (): Promise<string> => {
      throw new Error("simulated writeArtifact failure");
    };

    await assert.rejects(
      orchestrator.persistExtraction(factResult(FACT_BODY), storage, null, {
        sourceConnector: "chatgpt",
      }),
      /simulated writeArtifact failure/,
      "the artifact write failure must propagate — post-write work is not swallowed",
    );

    // The fact .md is durable.
    const all = await storage.readAllMemories();
    const facts = all.filter(
      (m: MemoryFile) => m.frontmatter.category === "fact" && m.content.includes("rollback anchor"),
    );
    assert.equal(facts.length, 1, "the fact .md must be durable");

    // Its content hash was flushed to fact-hashes.txt BEFORE the throw. Load
    // ONLY the on-disk index (no corpus rebuild) so this asserts the durable
    // file itself, not a restart-time reconstruction.
    const stateDir = path.join(memoryDir, "state");
    const onDisk = new ContentHashIndex(stateDir);
    await onDisk.load();
    assert.equal(
      onDisk.has(sanitizeMemoryContent(FACT_BODY).text),
      true,
      "the fact hash must be durable on disk before fallible post-write work (PR #2016)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
