/**
 * PR #2016 regression: chunked parent fact-hash durability.
 *
 * When fact dedup is enabled, the chunked extraction path writes the parent
 * memory first and then does fallible post-write work (chunk writes, artifact
 * writes, embedding index, promotion, graph edges). The parent write used to
 * defer its fact-content-hash flush to the end-of-method batch
 * saveContentHashIndexes(). If a later writeChunk() threw before that batch
 * save, the parent .md was durable but its hash was never written to
 * fact-hashes.txt — so a peer process with an already-built in-memory index
 * kept missing the durable parent and could re-extract it as a duplicate.
 *
 * Fix (extraction-persist.ts): the chunked parent write no longer defers its
 * hash flush — it saves immediately (crash-safe), BEFORE the fallible chunk /
 * artifact work runs. This test drives persistExtraction through the real
 * Orchestrator, forces the first writeChunk() to throw, and asserts the
 * parent's hash is already durable in the on-disk fact-hashes.txt (loaded
 * directly, NOT via a corpus rebuild that would reconstruct it regardless).
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

/**
 * Long, multi-sentence content that recursively chunks into >1 chunk.
 * estimateTokens ≈ chars/4; with the default config (minTokens 150,
 * targetTokens 200) this comfortably yields multiple chunks.
 */
function chunkableContent(): string {
  const sentences: string[] = [];
  for (let i = 0; i < 24; i += 1) {
    sentences.push(
      `Sentence ${i} records a distinct durable operational detail about the deployment topology and its rollout guarantees.`,
    );
  }
  return sentences.join(" ");
}

function chunkableResult(content: string): ExtractionResult {
  return {
    facts: [{ content, category: "fact", confidence: 0.9, tags: [] }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
}

test("#2016: a chunked parent's fact hash is durable on disk before fallible chunk writes", async () => {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-chunk-hash-durability-"),
  );
  try {
    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir: path.join(memoryDir, "workspace"),
      qmdEnabled: false,
      embeddingFallbackEnabled: false,
      chunkingEnabled: true,
      semanticChunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
    });
    const orchestrator = new Orchestrator(
      config,
    ) as unknown as OrchestratorTestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

    const body = chunkableContent();

    // Deterministic failure: the FIRST chunk write throws — after the parent
    // .md is durable and before the end-of-method saveContentHashIndexes().
    // This is exactly the "later writeChunk() throws" case the finding names.
    storage.writeChunk = async (): Promise<string> => {
      throw new Error("simulated writeChunk failure");
    };

    await assert.rejects(
      orchestrator.persistExtraction(chunkableResult(body), storage, null, {
        sourceConnector: "chatgpt",
      }),
      /simulated writeChunk failure/,
      "the chunk write failure must propagate — chunked post-write work is not swallowed",
    );

    // The chunked parent .md is durable (and no chunk landed, since the first
    // writeChunk threw).
    const all = await storage.readAllMemories();
    const parents = all.filter((m: MemoryFile) =>
      m.content.includes("Sentence 0 records"),
    );
    assert.equal(parents.length, 1, "the chunked parent .md must be durable");

    // The parent's content hash was flushed to fact-hashes.txt BEFORE the
    // throw. Load ONLY the on-disk index (no corpus rebuild) so this asserts
    // the durable file itself, not a restart-time reconstruction.
    const stateDir = path.join(memoryDir, "state");
    const onDisk = new ContentHashIndex(stateDir);
    await onDisk.load();
    assert.equal(
      onDisk.has(sanitizeMemoryContent(body).text),
      true,
      "the parent fact hash must be durable on disk before fallible chunk work (PR #2016)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
