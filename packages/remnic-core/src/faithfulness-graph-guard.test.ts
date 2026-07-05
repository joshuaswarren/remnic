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
      // The prompt emits `FACT: "<text>"` — fact text never contains a raw
      // double-quote, so capture up to the closing quote.
      const match = userMsg?.content.match(/FACT: "([^"]*)"/);
      const factContent = match ? (match[1] ?? "") : "";
      const verdict = verdictForFactContent(factContent);
      return {
        content: JSON.stringify([
          { index: 0, verdict, rationale: "stub verdict" },
        ]),
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
    const storage = await (orchestrator as unknown as {
      getStorage: (ns: string) => Promise<{
        ensureDirectories: () => Promise<void>;
        readAllMemories: () => Promise<
          Array<{
            path: string;
            frontmatter: { id: string; status?: string };
          }>
        >;
      }>;
    }).getStorage("default");
    await storage.ensureDirectories();

    const sourceText =
      "The widget factory produces widgets. It launched last year. The team is small.";

    const ids0 = await (orchestrator as unknown as {
      persistExtraction: (
        r: ExtractionResult,
        s: unknown,
        t: unknown,
        ctx: unknown,
        bn: unknown,
        plan: unknown,
        src: string,
      ) => Promise<string[]>;
    }).persistExtraction(
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
    const ids1 = await (orchestrator as unknown as {
      persistExtraction: (
        r: ExtractionResult,
        s: unknown,
        t: unknown,
        ctx: unknown,
        bn: unknown,
        plan: unknown,
        src: string,
      ) => Promise<string[]>;
    }).persistExtraction(
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
    const ids2 = await (orchestrator as unknown as {
      persistExtraction: (
        r: ExtractionResult,
        s: unknown,
        t: unknown,
        ctx: unknown,
        bn: unknown,
        plan: unknown,
        src: string,
      ) => Promise<string[]>;
    }).persistExtraction(
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
