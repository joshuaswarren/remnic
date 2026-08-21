import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";

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
  const { persistedIds: firstIds } = await orchestrator.persistExtraction(first, storage, null);
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
  const { persistedIds: secondIds } = await orchestrator.persistExtraction(second, storage, null);

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

  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null);
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

  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null);
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

  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null);
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

  const { persistedIds: ids } = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(ids.length, 1, "unavailable backend must not block writes");
});

test("semantic merge: merge lookup honors the batch backend-outage short circuit (issue #2330)", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    semanticMerge: { enabled: true },
  });

  // Call 1 is fact 1's semantic-dedup lookup (returns no neighbors → keep).
  // Call 2 is fact 1's merge lookup — it fails, which must arm the batch
  // flag. Facts 2 and 3 must then perform NO further lookup: both the
  // semantic-dedup path and the merge gate bypass after the flag is set, or
  // every remaining fact pays another full backend timeout (finding D).
  let searchCalls = 0;
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return true;
    },
    async search(): Promise<Array<{ id: string; score: number; path: string }>> {
      searchCalls++;
      if (searchCalls >= 2) throw new Error("embedding backend down");
      return [];
    },
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };

  const result: ExtractionResult = {
    facts: [
      fact("The billing service deploys on Tuesdays at 09:00 UTC."),
      fact("The audit service deploys on Wednesdays at 10:00 UTC."),
      fact("The search service deploys on Thursdays at 11:00 UTC."),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const { persistedIds } = await orchestrator.persistExtraction(result, storage, null);
  assert.equal(persistedIds.length, 3, "backend outage must fail open: all facts written");
  assert.equal(
    searchCalls,
    2,
    `expected exactly 2 embedding searches (dedup + merge for fact 1); got ${searchCalls} — facts 2–3 must bypass both lookups after the outage signal`,
  );
});

// ---------------------------------------------------------------------------
// Merge-on-write vs the write path's own side effects (issue #2330 findings
// B and C). Both drive the REAL persistExtraction path with a deterministic
// neighbor index and merge judge.
// ---------------------------------------------------------------------------

interface LocalLlmSeam {
  localLlm: {
    chatCompletion: (
      messages: Array<{ role: string; content: string }>,
    ) => Promise<{ content: string } | null>;
  };
}

/** The local-llm seam the production merge-judge call routes through. */
function installMergingJudge(orchestrator: unknown, judge: { calls: number }): void {
  (orchestrator as LocalLlmSeam).localLlm = {
    chatCompletion: async (messages) => {
      if (
        messages[0]?.role !== "system" ||
        !messages[0].content.startsWith("You maintain a long-term memory store")
      ) {
        return null;
      }
      judge.calls++;
      const input = JSON.parse(messages[1]?.content ?? "{}") as {
        new?: { content?: string };
        existing?: Array<{ id?: string; content?: string }>;
      };
      const target = input.existing?.[0];
      if (
        !target?.id ||
        typeof target.content !== "string" ||
        typeof input.new?.content !== "string"
      ) {
        return {
          content: JSON.stringify({
            decision: "create",
            targetId: null,
            mergedContent: null,
            reason: "no candidate",
          }),
        };
      }
      return {
        content: JSON.stringify({
          decision: "merge",
          targetId: target.id,
          mergedContent: `${target.content} ${input.new.content}`.trim(),
          reason: "deterministic regression judge",
        }),
      };
    },
  };
}

async function seedMergeTarget(memoryDir: string, id: string, content: string): Promise<string> {
  const dir = path.join(memoryDir, "facts", "2026-08-01");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  await writeFile(
    file,
    [
      "---",
      `id: ${id}`,
      "category: fact",
      "created: 2026-08-01T00:00:00.000Z",
      "updated: 2026-08-01T00:00:00.000Z",
      "source: extraction",
      "confidence: 0.9",
      "confidenceTier: explicit",
      "status: active",
      "importanceScore: 0.9",
      "importanceLevel: high",
      "---",
      "",
      content,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

async function readdirRecursive(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, encoding: "utf8" }).catch(() => []);
  return entries.map((entry) => path.join(root, entry));
}

test("semantic merge: a merged write still stores the verbatim artifact (finding B)", async () => {
  installCapturingLogger();
  const TARGET = "The billing service deploys on Tuesdays.";
  const INCOMING = "The billing service deploys each Tuesday morning.";
  const { orchestrator, storage, memoryDir } = await makeOrchestrator({
    semanticMerge: { enabled: true },
    versioningEnabled: true,
    verbatimArtifactsEnabled: true,
    verbatimArtifactCategories: ["fact"],
    verbatimArtifactsMinConfidence: 0.5,
  });
  const targetFile = await seedMergeTarget(memoryDir, "fact-e2e-target", TARGET);
  const judge = { calls: 0 };
  installMergingJudge(orchestrator, judge);
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return true;
    },
    async search(query: string): Promise<Array<{ id: string; score: number; path: string }>> {
      return query === INCOMING ? [{ id: "fact-e2e-target", score: 0.85, path: "" }] : [];
    },
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };

  const result: ExtractionResult = {
    facts: [{ content: INCOMING, category: "fact", tags: [], confidence: 0.9 }],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;
  const { persistedIds } = await orchestrator.persistExtraction(result, storage, null);

  assert.equal(judge.calls, 1, "the judge must have been consulted exactly once");
  assert.equal(persistedIds.length, 0, "a merged fact creates no new fragment");
  const merged = await readFile(targetFile, "utf8");
  assert.ok(merged.includes(INCOMING), "the target must hold the merged body");
  assert.ok(merged.includes("derived_via:"), "the target must carry merge provenance");

  // Finding B: the same extraction's verbatim anchor must exist, anchored to
  // the MERGED target id — not dropped by the merge's early exit.
  const artifactDir = path.join(memoryDir, "artifacts");
  const artifactFiles = (await readdirRecursive(artifactDir)).filter((f) => f.endsWith(".md"));
  assert.ok(artifactFiles.length > 0, "a verbatim artifact must be stored for the merged write");
  const anchors = await Promise.all(artifactFiles.map((f) => readFile(f, "utf8")));
  assert.ok(
    anchors.some((a) => a.includes("sourceMemoryId: fact-e2e-target") && a.includes(INCOMING)),
    "the artifact must be anchored to the merged target and carry the incoming text",
  );
});

test("semantic merge: a target with a promoted shared copy bypasses the merge (finding C)", async () => {
  installCapturingLogger();
  const FIRST = "The audit service tracks quarterly access reviews.";
  const PARAPHRASE = "The audit service also logs quarterly access reviews.";
  const { orchestrator, storage } = await makeOrchestrator({
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    autoPromoteToSharedEnabled: true,
    semanticMerge: { enabled: true },
    versioningEnabled: true,
  });
  const judge = { calls: 0 };
  installMergingJudge(orchestrator, judge);
  let firstFactId: string | null = null;
  orchestrator.embeddingFallback = {
    async isAvailable() {
      return true;
    },
    async search(query: string): Promise<Array<{ id: string; score: number; path: string }>> {
      if (query === PARAPHRASE && firstFactId) {
        return [{ id: firstFactId, score: 0.85, path: "" }];
      }
      return [];
    },
    async indexFile() {
      /* noop */
    },
    async removeFromIndex() {
      /* noop */
    },
  };

  const oneFact = (content: string): ExtractionResult =>
    ({
      facts: [{ content, category: "fact", tags: [], confidence: 0.95 }],
      entities: [],
      relationships: [],
      questions: [],
      profileUpdates: [],
    }) as ExtractionResult;

  // Extraction 1 creates the fact and auto-promotes a shared copy linked by
  // sourceMemoryId — the state whose reconciliation only the create path owns.
  const first = await orchestrator.persistExtraction(oneFact(FIRST), storage, null);
  assert.equal(first.persistedIds.length, 1);
  firstFactId = first.persistedIds[0];
  const sharedStorage = await orchestrator.getStorage("shared");
  const sharedBefore = await sharedStorage.readAllMemories();
  const promotedCopy = sharedBefore.find(
    (m: { frontmatter: { sourceMemoryId?: string } }) =>
      m.frontmatter.sourceMemoryId === firstFactId,
  );
  assert.ok(promotedCopy, "extraction 1 must have promoted a shared copy (test precondition)");
  const bodyBefore = (await storage.getMemoryByIdIncludingArchived(firstFactId))?.content;

  // Extraction 2 lands in the merge band for the promoted target: the merge
  // would strand the shared copy at the pre-merge body, so it must bypass.
  const second = await orchestrator.persistExtraction(oneFact(PARAPHRASE), storage, null);
  assert.equal(judge.calls, 1, "the merge judge must have run for the in-band paraphrase");
  assert.equal(second.persistedIds.length, 1, "the paraphrase must be created, not merged");
  const bodyAfter = (await storage.getMemoryByIdIncludingArchived(firstFactId))?.content;
  assert.equal(bodyAfter, bodyBefore, "the promoted target must keep its pre-merge body");
  const sharedAfter = await sharedStorage.readAllMemories();
  const copyAfter = sharedAfter.find(
    (m: { frontmatter: { sourceMemoryId?: string } }) =>
      m.frontmatter.sourceMemoryId === firstFactId,
  );
  assert.ok(copyAfter, "the promoted shared copy must survive the bypass");
  assert.equal(copyAfter.content, promotedCopy.content, "the shared copy must be untouched");
});
