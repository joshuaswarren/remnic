
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { readEdges } from "./graph.js";
import { searchHarmonicRetrieval } from "./harmonic-retrieval.js";
import type { ExtractionResult, PluginConfig } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { BufferTurn, ConversationThread } from "./types.js";
import type { PersistExtractionFn } from "./testing/orchestrator-lite.js";
import type { StorageManager } from "./storage.js";

function faithfulnessStubLocalLlm(
  verdictForFactContent: (factContent: string) => "entailed" | "unsupported",
): LocalLlmClient {
  return {
    chatCompletion: async (
      messages: Array<{ role: string; content: string }>,
      options: { operation?: string } = {},
    ) => {
      if (options.operation !== "extraction-faithfulness") return null;
      const userMsg = messages.find((m) => m.role === "user");
      // The batch prompt emits one `FACT: "<text>"` line per fact, each
      // followed by `Respond with the JSON array entry for index <i>`. The
      // gate maps verdicts back to facts by that index, so return one entry
      // per fact in prompt order. (Single-fact callers still get one entry.)
      const factMatches = [...(userMsg?.content ?? "").matchAll(/FACT: "([^"]*)"/g)];
      const entries = factMatches.map((m, i) => ({
        index: i,
        verdict: verdictForFactContent(m[1] ?? ""),
        rationale: "stub verdict",
      }));
      return {
        content: JSON.stringify(
          entries.length > 0 ? entries : [{ index: 0, verdict: "entailed" as const, rationale: "stub" }],
        ),
      };
    },
  } as unknown as LocalLlmClient;
}

interface OrchHarness {
  orchestrator: Orchestrator;
  memoryDir: string;
}

async function makeHarness(): Promise<OrchHarness> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-faithfulness-graph-"),
  );
  const config: PluginConfig = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    extractionFaithfulnessGate: "enforce",
    extractionFaithfulnessContextChars: 400,
    extractionFaithfulnessTimeoutMs: 2000,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    qmdEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    harmonicRetrievalEnabled: true,
    abstractionAnchorsEnabled: true,
  });
  const orchestrator = new Orchestrator(config);
  return { orchestrator, memoryDir };
}

function factResult(content: string, entityRef: string): ExtractionResult {
  return {
    facts: [
      {
        content,
        category: "fact",
        tags: [],
        confidence: 0.9,
        entityRef,
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as unknown as ExtractionResult;
}

test("pending_review fact gets no graph edge; an active fact with the same entityRef does (faithfulness #1576 guard)", async () => {
  const { orchestrator, memoryDir } = await makeHarness();
  try {
    (orchestrator as unknown as { localLlm: LocalLlmClient }).localLlm =
      faithfulnessStubLocalLlm((c) =>
        c.includes("closed permanently") ? "unsupported" : "entailed",
      );
    // getStorage + persistExtraction are private; reach them through a named production-typed surface.
    const persist = orchestrator as unknown as {
      getStorage: (ns: string) => Promise<StorageManager>;
      persistExtraction: PersistExtractionFn;
    };
    const storage = await persist.getStorage("default");
    await storage.ensureDirectories();

    const sourceText =
      "The widget factory produces widgets. It launched last year. The team is small.";

    const { persistedIds: ids0 } = await persist.persistExtraction(
      factResult("The widget factory produces widgets daily.", "widget-factory"),
      storage,
      null,
      { sessionKey: "agent:test:main", principal: "test" },
      undefined,
      null,
      sourceText,
    );
    const id0 = ids0[0];
    assert.ok(id0, "fact0 persisted");

    const { persistedIds: ids1 } = await persist.persistExtraction(
      factResult(
        "The widget factory closed permanently.",
        "widget-factory",
      ),
      storage,
      null,
      { sessionKey: "agent:test:main", principal: "test" },
      undefined,
      null,
      sourceText,
    );
    const id1 = ids1[0];
    assert.ok(id1, "fact1 persisted");

    const memsAfter1 = await storage.readAllMemories();
    const mem1 = memsAfter1.find((m) => m.frontmatter.id === id1);
    assert.ok(mem1, "fact1 memory readable");
    assert.equal(
      mem1!.frontmatter.status,
      "pending_review",
      "unsupported fact must be pending_review under enforce",
    );

    const edgesAfter1 = await readEdges(memoryDir, "entity");
    assert.equal(
      edgesAfter1.length,
      0,
      `pending_review fact must originate no graph edge (got ${edgesAfter1.length} entity edges)`,
    );
    assert.ok(
      !edgesAfter1.some((e) => e.from.includes(id1!) || e.from.includes(id0!)),
      "neither fact0 nor fact1 originates an entity edge",
    );
    const harmonicAfter1 = await searchHarmonicRetrieval({
      memoryDir,
      query: "widget factory",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.ok(
      harmonicAfter1.some((result) => result.node.sourceMemoryIds?.includes(id0!)),
      "active fact must appear in harmonic node sources",
    );
    assert.ok(
      !harmonicAfter1.some((result) => result.node.sourceMemoryIds?.includes(id1!)),
      "pending_review fact must not appear in harmonic node sources",
    );

    const { persistedIds: ids2 } = await persist.persistExtraction(
      factResult("The widget factory reopened this quarter.", "widget-factory"),
      storage,
      null,
      { sessionKey: "agent:test:main", principal: "test" },
      undefined,
      null,
      sourceText,
    );
    const id2 = ids2[0];
    assert.ok(id2, "fact2 persisted");

    const edgesAfter2 = await readEdges(memoryDir, "entity");
    assert.ok(
      edgesAfter2.length > 0,
      "active fact with a shared entityRef must create entity edges (control)",
    );
    assert.ok(
      edgesAfter2.some((e) => e.from.includes(id2!)),
      "active fact2 must be the source of an entity edge",
    );
    assert.ok(
      !edgesAfter2.some((e) => e.from.includes(id1!)),
      "pending_review fact1 must never originate an entity edge even after a later active fact",
    );
    const harmonicAfter2 = await searchHarmonicRetrieval({
      memoryDir,
      query: "widget factory",
      maxResults: 10,
      anchorsEnabled: true,
    });
    assert.ok(
      harmonicAfter2.some((result) => result.node.sourceMemoryIds?.includes(id2!)),
      "active fact must appear in harmonic node sources",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


async function makeThreadHarness(): Promise<OrchHarness> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-faithfulness-thread-"),
  );
  const config: PluginConfig = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: false,
    timeGraphEnabled: true,
    causalGraphEnabled: true,
    extractionFaithfulnessGate: "enforce",
    extractionFaithfulnessContextChars: 400,
    extractionFaithfulnessTimeoutMs: 2000,
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    qmdEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
  });
  const orchestrator = new Orchestrator(config);
  return { orchestrator, memoryDir };
}

function twoFactResult(
  contentA: string,
  entityRefA: string,
  contentB: string,
  entityRefB: string,
): ExtractionResult {
  return {
    facts: [
      { content: contentA, category: "fact", tags: [], confidence: 0.9, entityRef: entityRefA },
      { content: contentB, category: "fact", tags: [], confidence: 0.9, entityRef: entityRefB },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as unknown as ExtractionResult;
}

test("pending_review id must NOT enter persisted thread episodes across a cross-flush (#1635)", async () => {
  const { orchestrator, memoryDir } = await makeThreadHarness();
  try {
    (orchestrator as unknown as { localLlm: LocalLlmClient }).localLlm =
      faithfulnessStubLocalLlm((c) =>
        c.includes("closed permanently") ? "unsupported" : "entailed",
      );

    const getStorage = orchestrator as unknown as {
      getStorage: (ns: string) => Promise<StorageManager>;
    };
    const storage = await getStorage.getStorage("default");
    await storage.ensureDirectories();

    const threading = orchestrator as unknown as {
      threading: {
        processTurn: (turn: BufferTurn, ids: string[]) => Promise<string>;
        loadThread: (id: string) => Promise<ConversationThread | null>;
      };
    };
    const seedTurn: BufferTurn = {
      role: "user",
      content: "Tell me about the widget factory.",
      timestamp: "2026-07-06T10:00:00.000Z",
      sessionKey: "agent:test:main",
    };
    const threadId = await threading.threading.processTurn(seedTurn, []);
    assert.ok(threadId, "thread established via processTurn");

    const persistUntyped: unknown = orchestrator;
    // SAFETY: the harness reads only persistExtraction and
    // appendPersistedThreadEpisodes off the orchestrator; each test asserts
    // the fields it consumes.
    const persist = persistUntyped as {
      persistExtraction: PersistExtractionFn;
      appendPersistedThreadEpisodes: (
        threadId: string,
        persistedIds: string[],
        pendingReviewIds: string[]
      ) => Promise<void>;
    };

    const sourceText =
      "The widget factory reopened this quarter after being closed permanently last year.";

    const { persistedIds: flush1, pendingReviewIds: pendingReviewIds1 } = await persist.persistExtraction(
      twoFactResult(
        "The widget factory reopened this quarter.", "wf-active",
        "The widget factory closed permanently last year.", "wf-pending",
      ),
      storage,
      threadId,
      { sessionKey: "agent:test:main", principal: "test" },
      undefined,
      null,
      sourceText,
    );
    const [activeId1, pendingId] = flush1;
    assert.ok(activeId1, "flush1 active fact persisted");
    assert.ok(pendingId, "flush1 pending_review fact persisted");

    await persist.appendPersistedThreadEpisodes(threadId, flush1, pendingReviewIds1);

    const threadAfter1 = await threading.threading.loadThread(threadId);
    assert.ok(threadAfter1, "thread file readable after flush 1");
    assert.ok(
      threadAfter1!.episodeIds.includes(activeId1),
      "active fact id is in persisted thread episodes",
    );
    assert.ok(
      !threadAfter1!.episodeIds.includes(pendingId),
      "pending_review id must NOT enter persisted thread episodes (#1635)",
    );

    const memsAfter1 = await storage.readAllMemories();
    const pendingMem = memsAfter1.find((m) => m.frontmatter.id === pendingId);
    assert.ok(pendingMem, "pending_review fact is durable");
    assert.equal(
      pendingMem!.frontmatter.status,
      "pending_review",
      "unsupported fact is pending_review under enforce",
    );

    const { persistedIds: flush2, pendingReviewIds: pendingReviewIds2 } = await persist.persistExtraction(
      factResult("The widget factory hired ten new engineers.", "wf-active"),
      storage,
      threadId,
      { sessionKey: "agent:test:main", principal: "test" },
      undefined,
      null,
      sourceText,
    );
    const activeId2 = flush2[0];
    assert.ok(activeId2, "flush2 active fact persisted");
    await persist.appendPersistedThreadEpisodes(threadId, flush2, pendingReviewIds2);

    const pendingPath = path.relative(memoryDir, pendingMem!.path);
    for (const gtype of ["time", "causal"] as const) {
      const edges = await readEdges(memoryDir, gtype);
      assert.ok(
        !edges.some((e) => e.from === pendingPath || e.to === pendingPath),
        `no ${gtype} edge references the pending_review fact path (${pendingPath}); got ${edges.length} edges`,
      );
    }

    const timeEdges = await readEdges(memoryDir, "time");
    assert.ok(
      timeEdges.length > 0,
      "active fact2 builds a time predecessor edge (control: graph+threading wired)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
