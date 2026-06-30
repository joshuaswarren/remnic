import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parseConfig } from "../src/config.js";
import { initLogger, type LoggerBackend } from "../src/logger.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { ExtractionResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// Integration test for PR #439 post-merge Finding 1:
// The orchestrator's semantic chunking catch block must honor
// fallbackToRecursive=false instead of silently falling back to
// recursive chunking.
// ---------------------------------------------------------------------------

type LogEntry = { level: "info" | "warn" | "error" | "debug"; message: string };

function installCapturingLogger(): { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const backend: LoggerBackend = {
    info(msg: string) {
      entries.push({ level: "info", message: msg });
    },
    warn(msg: string) {
      entries.push({ level: "warn", message: msg });
    },
    error(msg: string) {
      entries.push({ level: "error", message: msg });
    },
    debug(msg: string) {
      entries.push({ level: "debug", message: msg });
    },
  };
  initLogger(backend, true);
  return { entries };
}

async function makeOrchestrator(
  overrides: Record<string, unknown> = {},
): Promise<{ orchestrator: any; storage: any; memoryDir: string }> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-chunking-fallback-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: true,
    chunkingEnabled: true,
    semanticChunkingEnabled: true,
    multiGraphMemoryEnabled: false,
    ...overrides,
  });
  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  return { orchestrator, storage, memoryDir };
}

function fact(content: string): {
  content: string;
  category: string;
  tags: string[];
  confidence: number;
} {
  return {
    content,
    category: "fact",
    tags: [],
    confidence: 0.9,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("chunking fallback: re-throws when fallbackToRecursive is false and embeddings fail", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticChunkingConfig: {
      fallbackToRecursive: false,
    },
  });

  // Stub the embeddingFallback so embedTexts always throws (simulating
  // an unavailable embedding backend).
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return true;
    },
    async embedTexts() {
      throw new Error("embedding service unavailable");
    },
    async search() {
      return [];
    },
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };

  // Build a fact long enough to trigger chunking. The chunking threshold
  // is typically around 200 tokens (~800 chars).
  const longContent = Array.from(
    { length: 30 },
    (_, i) =>
      `This is a detailed fact sentence number ${i} that provides substantial information about an important topic.`,
  ).join(" ");

  const extraction: ExtractionResult = {
    facts: [fact(longContent)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  // With fallbackToRecursive=false, the orchestrator must propagate the
  // error from semanticChunkContent rather than silently falling back
  // to recursive chunking.
  await assert.rejects(
    () => orchestrator.persistExtraction(extraction, storage, null),
    /embedding.*unavailable|fallbackToRecursive is disabled/i,
  );
});

test("chunking fallback: falls back to recursive chunking when fallbackToRecursive is true (default)", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    // fallbackToRecursive defaults to true so we don't need to set it
    semanticChunkingConfig: {
      fallbackToRecursive: true,
    },
  });

  // Stub the embeddingFallback so embedTexts always throws.
  // When fallbackToRecursive=true, semanticChunkContent handles the
  // fallback internally (returns recursive-fallback result), so the
  // orchestrator's outer catch block is not reached. The key contract
  // is that the fact is still persisted successfully.
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return true;
    },
    async embedTexts() {
      throw new Error("embedding service unavailable");
    },
    async search() {
      return [];
    },
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };

  const longContent = Array.from(
    { length: 30 },
    (_, i) =>
      `This is a detailed fact sentence number ${i} that provides substantial information about an important topic.`,
  ).join(" ");

  const extraction: ExtractionResult = {
    facts: [fact(longContent)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  // With fallbackToRecursive=true (default), the fact should be
  // persisted successfully via the recursive fallback path.
  const ids = await orchestrator.persistExtraction(extraction, storage, null);
  assert.ok(ids.length >= 1, "fact should be persisted via recursive fallback");
});

test("chunked extraction records catalog touch after supersession, artifact, and graph writes", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticChunkingEnabled: false,
    chunkingTargetTokens: 12,
    chunkingMinTokens: 6,
    chunkingOverlapSentences: 0,
    temporalSupersessionEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactCategories: ["fact"],
    verbatimArtifactsMinConfidence: 0,
    multiGraphMemoryEnabled: true,
  });

  await storage.writeMemory("fact", "Person A lives in Austin.", {
    source: "test",
    entityRef: "person-a",
    structuredAttributes: { city: "Austin" },
    validAt: "2026-01-01T00:00:00.000Z",
  });

  const events: string[] = [];
  const originalWriteChunk = storage.writeChunk.bind(storage);
  storage.writeChunk = async (...args: Parameters<typeof storage.writeChunk>) => {
    const id = await originalWriteChunk(...args);
    events.push("chunk");
    return id;
  };

  const originalWriteMemoryFrontmatter = storage.writeMemoryFrontmatter.bind(storage);
  storage.writeMemoryFrontmatter = async (
    ...args: Parameters<typeof storage.writeMemoryFrontmatter>
  ) => {
    const result = await originalWriteMemoryFrontmatter(...args);
    events.push("supersession");
    return result;
  };

  const originalWriteArtifact = storage.writeArtifact.bind(storage);
  storage.writeArtifact = async (...args: Parameters<typeof storage.writeArtifact>) => {
    const id = await originalWriteArtifact(...args);
    events.push("artifact");
    return id;
  };

  orchestrator.buildGraphEdge = async () => {
    events.push("graph");
  };

  orchestrator.markCatalogWrite = () => {
    events.push("touch");
  };

  const longContent = Array.from(
    { length: 20 },
    (_, i) => `Person A now lives in NYC and this detailed sentence ${i} keeps the memory chunkable.`,
  ).join(" ");

  const extraction: ExtractionResult = {
    facts: [
      {
        ...fact(longContent),
        entityRef: "person-a",
        structuredAttributes: { city: "NYC" },
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  await orchestrator.persistExtraction(extraction, storage, null, {
    validAt: "2026-01-02T00:00:00.000Z",
  });

  const firstChunkIndex = events.indexOf("chunk");
  const supersessionIndex = events.indexOf("supersession");
  const artifactIndex = events.indexOf("artifact");
  const graphIndex = events.indexOf("graph");
  const touchIndex = events.indexOf("touch");

  assert.notEqual(firstChunkIndex, -1, "precondition: recursive chunking wrote chunks");
  assert.notEqual(supersessionIndex, -1, "precondition: temporal supersession rewrote old fact");
  assert.notEqual(artifactIndex, -1, "precondition: verbatim artifact was written");
  assert.notEqual(graphIndex, -1, "precondition: graph edge write was attempted");
  assert.notEqual(touchIndex, -1, "precondition: catalog touch was recorded");
  assert.ok(
    touchIndex > supersessionIndex && touchIndex > artifactIndex && touchIndex > graphIndex,
    `catalog touch must follow supersession, artifact, and graph writes; saw ${events.join(" -> ")}`,
  );
});
