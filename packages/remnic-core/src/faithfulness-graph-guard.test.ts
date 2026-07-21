/**
 * Issue #1576 — pending-review facts must NOT originate graph edges.
 *
 * When `extractionFaithfulnessGate="enforce"` routes an unsupported or
 * contradicted fact to `pending_review`, the persist path still builds entity
 * edges via `GraphIndex.onMemoryWritten`, so an unfaithful extraction in the
 * review queue could change graph traversal/ranking for active memories even
 * though direct recall filters later drop the pending file. The guard mirrors
 * the existing supersession/promotion/artifact guards (codex P2
 * PRRT_kwDORJXyws6OblI1's sibling thread PRRT_kwDORJXyws6OblI0).
 *
 * These tests exercise the real `persistExtraction` path end-to-end (no LLM
 * network — the local LLM is stubbed to return controlled verdicts) and read
 * the entity graph JSONL directly to prove the guard.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { readEdges } from "./graph.js";
import type { ExtractionResult, PluginConfig } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { BufferTurn, ConversationThread } from "./types.js";
import type { PersistExtractionFn } from "./testing/orchestrator-lite.js";
import type { StorageManager } from "./storage.js";

/**
 * Stub local LLM whose `chatCompletion` only answers faithfulness-gate calls
 * (operation === "extraction-faithfulness"). The verdict is chosen by a marker
 * in the fact text so each persisted fact gets a deterministic, controllable
 * verdict with no network. Non-faithfulness calls return null (fail-open skip).
 */
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
    // Graph: entity only (isolate the assertion; time/causal off).
    multiGraphMemoryEnabled: true,
    entityGraphEnabled: true,
    timeGraphEnabled: false,
    causalGraphEnabled: false,
    // Faithfulness gate in enforce mode.
    extractionFaithfulnessGate: "enforce",
    extractionFaithfulnessContextChars: 400,
    extractionFaithfulnessTimeoutMs: 2000,
    // Minimize competing gates so the fact reaches the write + graph stage.
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
    // fact0 → entailed (active). Establishes entityRef "widget-factory" so the
    // next E1 fact has a sibling to edge to. Alone, fact0 has no sibling yet.
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

    // fact1 → unsupported (pending_review). Under the bug it would originate an
    // entity edge to fact0; under the guard it must NOT.
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

    // fact1 must be written with status pending_review (the gate ran).
    const memsAfter1 = await storage.readAllMemories();
    const mem1 = memsAfter1.find((m) => m.frontmatter.id === id1);
    assert.ok(mem1, "fact1 memory readable");
    assert.equal(
      mem1!.frontmatter.status,
      "pending_review",
      "unsupported fact must be pending_review under enforce",
    );

    // After fact0 + fact1: NO entity edges at all. fact0 had no E1 sibling when
    // written; fact1 is pending_review and must be guarded out of the graph.
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

    // Control: an ACTIVE fact with the same entityRef DOES create entity edges
    // (proving the graph is wired and only pending_review is excluded).
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
    // fact2 (active) originates edges; fact1 (pending_review) never does.
    assert.ok(
      edgesAfter2.some((e) => e.from.includes(id2!)),
      "active fact2 must be the source of an entity edge",
    );
    assert.ok(
      !edgesAfter2.some((e) => e.from.includes(id1!)),
      "pending_review fact1 must never originate an entity edge even after a later active fact",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});


/**
 * Thread-enabled harness for issue #1635: time + causal graph ON (so
 * thread-predecessor edges are built), faithfulness gate in enforce mode.
 * Entity graph is left OFF to isolate the thread-episode predecessor
 * mechanism (entity-sibling edges are a separate, out-of-scope path).
 */
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

/** ExtractionResult with two facts (order preserved by the persist loop). */
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
    // fact content containing "closed permanently" → unsupported → pending_review.
    (orchestrator as unknown as { localLlm: LocalLlmClient }).localLlm =
      faithfulnessStubLocalLlm((c) =>
        c.includes("closed permanently") ? "unsupported" : "entailed",
      );

    const getStorage = orchestrator as unknown as {
      getStorage: (ns: string) => Promise<StorageManager>;
    };
    const storage = await getStorage.getStorage("default");
    await storage.ensureDirectories();

    // Establish a real thread (mirrors runExtraction's processTurn step) so
    // appendEpisodeIds has a thread file to write episode ids into.
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

    const persist = orchestrator as unknown as {
      persistExtraction: PersistExtractionFn;
      appendPersistedThreadEpisodes: (
        threadId: string,
        persistedIds: string[]
      ) => Promise<void>;
    };

    const sourceText =
      "The widget factory reopened this quarter after being closed permanently last year.";

    // --- Flush 1: an active fact + a pending_review fact, same thread ---
    const { persistedIds: flush1 } = await persist.persistExtraction(
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

    // runExtraction's append step (the real helper; filters pending_review).
    await persist.appendPersistedThreadEpisodes(threadId, flush1);

    // PART (a): the thread FILE must hold the active id but NOT the pending id.
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

    // The pending fact IS durable (with status pending_review) — proves the
    // gate routed it correctly; the guard is about its absence from the thread.
    const memsAfter1 = await storage.readAllMemories();
    const pendingMem = memsAfter1.find((m) => m.frontmatter.id === pendingId);
    assert.ok(pendingMem, "pending_review fact is durable");
    assert.equal(
      pendingMem!.frontmatter.status,
      "pending_review",
      "unsupported fact is pending_review under enforce",
    );

    // --- Flush 2: an active fact in the SAME thread ---
    const { persistedIds: flush2 } = await persist.persistExtraction(
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
    await persist.appendPersistedThreadEpisodes(threadId, flush2);

    // PART (a)+(b): no predecessor edge may reference the pending fact. Under
    // the bug, flush 1 would have appended pendingId to the thread file, flush
    // 2's loadThread would re-seed it into threadEpisodeIdsForGraph, and the
    // active fact2 would build a time/causal predecessor edge to it.
    const pendingPath = path.relative(memoryDir, pendingMem!.path);
    for (const gtype of ["time", "causal"] as const) {
      const edges = await readEdges(memoryDir, gtype);
      assert.ok(
        !edges.some((e) => e.from === pendingPath || e.to === pendingPath),
        `no ${gtype} edge references the pending_review fact path (${pendingPath}); got ${edges.length} edges`,
      );
    }

    // Control: the graph + threading are wired — the active fact2 builds a
    // time predecessor edge to the active fact1 (which IS in the thread file).
    const timeEdges = await readEdges(memoryDir, "time");
    assert.ok(
      timeEdges.length > 0,
      "active fact2 builds a time predecessor edge (control: graph+threading wired)",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
