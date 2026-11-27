
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

interface OrchestratorTestSurface {
  persistExtraction: (
    result: ExtractionResult,
    storage: StorageManager,
    threadId: string | null,
    sourceContext?: { sourceConnector?: string; validAt?: string },
  ) => Promise<string[]>;
  getStorage: (namespace: string) => Promise<StorageManager>;
}

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
      chunkingEnabled: false,
      multiGraphMemoryEnabled: false,
      factDeduplicationEnabled: true,
      verbatimArtifactsEnabled: true,
      verbatimArtifactCategories: ["fact"],
      verbatimArtifactsMinConfidence: 0.5,
    });
    const orchestrator = new Orchestrator(
      config,
    ) as unknown as OrchestratorTestSurface;
    const storage = await orchestrator.getStorage("default");
    await storage.ensureDirectories();

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

    const all = await storage.readAllMemories();
    const facts = all.filter(
      (m: MemoryFile) => m.frontmatter.category === "fact" && m.content.includes("rollback anchor"),
    );
    assert.equal(facts.length, 1, "the fact .md must be durable");

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
