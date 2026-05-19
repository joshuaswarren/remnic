import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parseConfig } from "@remnic/core/config";
import { initLogger, type LoggerBackend } from "@remnic/core/logger";
import { Orchestrator } from "@remnic/core/orchestrator";
import type { ExtractionResult } from "@remnic/core/types";

// ---------------------------------------------------------------------------
// Integration tests for the write-time semantic dedup guard (issue #373).
//
// These tests bypass the extraction engine entirely and call
// Orchestrator.persistExtraction() with synthetic facts. We stub the
// EmbeddingFallback so we can deterministically control the cosine scores
// returned for each candidate fact.
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

type EmbeddingStub = {
  available: boolean;
  /**
   * Map from content (or content prefix) → hits to return. The stub tries
   * exact match first, then falls back to "default".
   */
  hitsByContent: Map<string, Array<{ id: string; score: number; path: string }>>;
};

function stubEmbeddingFallback(orchestrator: any, stub: EmbeddingStub): void {
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return stub.available;
    },
    async search(
      query: string,
      _limit: number,
    ): Promise<Array<{ id: string; score: number; path: string }>> {
      const hits = stub.hitsByContent.get(query) ?? stub.hitsByContent.get("default") ?? [];
      return hits;
    },
    // indexFile/removeFromIndex are no-ops for these tests.
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };
}

async function makeOrchestrator(
  overrides: Record<string, unknown> = {},
): Promise<{ orchestrator: any; storage: any; memoryDir: string }> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-semantic-dedup-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    // embeddingFallback stays on so our stub's isAvailable() is consulted.
    embeddingFallbackEnabled: true,
    chunkingEnabled: false,
    // Turn off graph / threading / factArchival writers that touch QMD.
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

test("semantic dedup: drops near-duplicate paraphrase on write", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  // Stub embeddings so the first fact returns an empty index ("no neighbors"),
  // then the second fact returns a high-similarity hit that should trip the
  // dedup guard.
  const stub: EmbeddingStub = {
    available: true,
    hitsByContent: new Map(),
  };
  stub.hitsByContent.set(
    "The production database uses Postgres 16 on port 5432 in the us-east region.",
    [],
  );
  stub.hitsByContent.set(
    "Production DB is Postgres 16 listening on 5432 and lives in us-east.",
    [
      { id: "existing-mem-1", score: 0.97, path: "/tmp/existing.md" },
      { id: "existing-mem-2", score: 0.62, path: "/tmp/other.md" },
    ],
  );
  stubEmbeddingFallback(orchestrator, stub);

  const first: ExtractionResult = {
    facts: [
      fact(
        "The production database uses Postgres 16 on port 5432 in the us-east region.",
      ),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
  const firstIds = await orchestrator.persistExtraction(first, storage, null);
  assert.equal(firstIds.length, 1, "first fact must be persisted");

  const second: ExtractionResult = {
    facts: [
      fact(
        "Production DB is Postgres 16 listening on 5432 and lives in us-east.",
      ),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
  const secondIds = await orchestrator.persistExtraction(second, storage, null);

  assert.equal(
    secondIds.length,
    0,
    "semantic near-duplicate must be skipped",
  );

  assert.equal(stub.hitsByContent.size, 2, "dedup fixture must include both searches");
});

test("semantic dedup: keeps facts when top score is below threshold", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  const stub: EmbeddingStub = {
    available: true,
    hitsByContent: new Map([
      ["default", [{ id: "neighbor", score: 0.5, path: "/tmp/x.md" }]],
    ]),
  };
  stubEmbeddingFallback(orchestrator, stub);

  const result: ExtractionResult = {
    facts: [
      fact("The staging environment is deployed via GitHub Actions weekly."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const ids = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(ids.length, 1, "low-similarity fact must be persisted");
});

test("semantic dedup: disabled flag bypasses embedding check entirely", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticDedupEnabled: false,
  });

  // Even with an overwhelming similarity score, dedup is disabled so the
  // fact must land.
  let searchCalls = 0;
  const stub: EmbeddingStub = {
    available: true,
    hitsByContent: new Map([
      ["default", [{ id: "collision", score: 0.99, path: "/tmp/x.md" }]],
    ]),
  };
  stubEmbeddingFallback(orchestrator, stub);
  const origSearch = orchestrator.embeddingFallback.search.bind(
    orchestrator.embeddingFallback,
  );
  orchestrator.embeddingFallback.search = async (...args: [string, number]) => {
    searchCalls++;
    return origSearch(...args);
  };

  const result: ExtractionResult = {
    facts: [
      fact("The staging environment runs on Kubernetes with 3 replicas."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const ids = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(ids.length, 1);
  assert.equal(
    searchCalls,
    0,
    "embedding search must not be called when semanticDedupEnabled=false",
  );
});

test("semantic dedup: threshold config controls when to skip", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticDedupThreshold: 0.5,
  });

  const stub: EmbeddingStub = {
    available: true,
    hitsByContent: new Map([
      ["default", [{ id: "neighbor", score: 0.6, path: "/tmp/x.md" }]],
    ]),
  };
  stubEmbeddingFallback(orchestrator, stub);

  const result: ExtractionResult = {
    facts: [
      fact("The CI pipeline publishes npm packages to the public registry."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const ids = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(
    ids.length,
    0,
    "lower threshold (0.5) must cause 0.6 score to trip the guard",
  );
});

test("semantic dedup: candidates config is forwarded to search", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticDedupCandidates: 7,
  });

  const seenLimits: number[] = [];
  const stub: EmbeddingStub = {
    available: true,
    hitsByContent: new Map(),
  };
  stubEmbeddingFallback(orchestrator, stub);
  const origSearch = orchestrator.embeddingFallback.search.bind(
    orchestrator.embeddingFallback,
  );
  orchestrator.embeddingFallback.search = async (
    query: string,
    limit: number,
  ) => {
    seenLimits.push(limit);
    return origSearch(query, limit);
  };

  const result: ExtractionResult = {
    facts: [
      fact("The deployment script rotates secrets at 03:00 UTC daily."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  await orchestrator.persistExtraction(result, storage, null);

  assert.ok(seenLimits.length >= 1, "embeddingFallback.search should be called");
  assert.equal(
    seenLimits[0],
    7,
    "semanticDedupCandidates must be forwarded as the search limit",
  );
});

test("semantic dedup: unavailable backend falls open (fact is persisted)", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  // Backend reports unavailable — the dedup guard must fail-open.
  const stub: EmbeddingStub = {
    available: false,
    hitsByContent: new Map(),
  };
  stubEmbeddingFallback(orchestrator, stub);

  const result: ExtractionResult = {
    facts: [
      fact("The mobile app caches responses for 10 minutes by default."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const ids = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(ids.length, 1, "unavailable backend must not block writes");
});
