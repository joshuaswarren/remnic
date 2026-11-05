/**
 * Codex P2 PRRT_kwDORJXyws6zzdG4 (#3311) — promotion-target writes must share
 * the fact-dedup commit window.
 *
 * With extractionQueueConcurrency > 1 and shared auto-promotion enabled, two
 * sessions extracting the same fact into DIFFERENT source namespaces can both
 * pass the shared-namespace dedup gate (`hasFactContentHash`) before either
 * promotion writes: the persist-time gate runs outside the commit window that
 * protects the source writes, and the promotion destination write ran without
 * any window at all. writeMemory mints a fresh id per write, so both
 * promotions land distinct active shared copies — exactly the duplicate class
 * `persistUnderFactDedupWindow` exists to prevent for source writes.
 *
 * The fix wraps each promotion destination write in
 * `persistUnderFactDedupWindow` keyed on the DESTINATION storage dir, so the
 * second promotion's in-window recheck observes the first promotion's
 * committed hash and suppresses instead of duplicating. The invariant these
 * tests assert — exactly one active shared copy survives a concurrent
 * same-fact promotion pair — holds for every interleaving once the window is
 * in place, because recheck+write are atomic per destination dir; before the
 * fix the duplicate depends on the interleaving (two symmetric pipelines in
 * lockstep both gate-miss before either write commits).
 *
 * These tests drive the real persistExtraction path (no LLM network; every
 * gate that would call one is off) with two real source namespaces and the
 * real shared destination, and assert the durable outcome.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import type { ExtractionResult, PluginConfig } from "./types.js";
import type { LocalLlmClient } from "./local-llm.js";
import type { PersistExtractionFn } from "./testing/orchestrator-lite.js";
import type { StorageManager } from "./storage.js";

// Fixture contract for the private Orchestrator surface this suite drives.
interface OrchestratorFixture {
  localLlm?: unknown;
  chatCompletion?: unknown;
  getStorage?: unknown;
  persistExtraction?: unknown;
}

// Named owner contract for the private internals this suite drives.
interface OrchestratorInternals {
  localLlm: LocalLlmClient;
  getStorage: (ns: string) => Promise<StorageManager>;
  persistExtraction: PersistExtractionFn;
}

function asInternals<T extends object>(value: OrchestratorFixture): T {
  // SAFETY: the fixture provides the members the persist path reads; the
  // remaining contract members are unused by these tests.
  return value as T;
}

async function makeHarness(): Promise<{
  orchestrator: Orchestrator;
  persist: OrchestratorInternals;
  memoryDir: string;
  shared: StorageManager;
  teamA: StorageManager;
  teamB: StorageManager;
}> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-promotion-dedup-"));
  const config: PluginConfig = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    // Minimize every gate that needs a model or corpus-scale machinery so the
    // fact reaches the normal (non-chunked) write path.
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    qmdEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    // Shared auto-promotion from every source namespace into the default
    // "shared" namespace (both default off — the deployment profile this
    // finding targets).
    namespacesEnabled: true,
    autoPromoteToSharedEnabled: true,
  });
  const orchestrator = new Orchestrator(config);
  const internals = asInternals<OrchestratorInternals>(orchestrator);
  internals.localLlm = asInternals<LocalLlmClient>({ chatCompletion: async () => null });
  const shared = await internals.getStorage("shared");
  const teamA = await internals.getStorage("team-a");
  const teamB = await internals.getStorage("team-b");
  await Promise.all([shared, teamA, teamB].map((s) => s.ensureDirectories()));
  return { orchestrator, persist: internals, memoryDir, shared, teamA, teamB };
}

function factResult(content: string): ExtractionResult {
  const result = {
    facts: [
      {
        content,
        category: "fact",
        // confidenceTier(0.96) === "explicit", which the default
        // autoPromoteMinConfidenceTier ("explicit") admits.
        confidence: 0.96,
        tags: [],
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
  // SAFETY: literal carries the full extraction-result shape persistExtraction
  // consumes for a single fact candidate.
  return result as ExtractionResult;
}

async function activeFactCopies(storage: StorageManager): Promise<number> {
  const memories = await storage.readAllMemories();
  return memories.filter(
    (m) => m.frontmatter.category === "fact" && (m.frontmatter.status ?? "active") === "active",
  ).length;
}

const FACT = "Deployment rollbacks complete within five minutes.";

test("the same fact promoted from two namespaces lands once in shared (serial baseline)", async () => {
  const { persist, memoryDir, shared, teamA, teamB } = await makeHarness();
  try {
    const first = await persist.persistExtraction(
      factResult(FACT),
      teamA,
      null,
      { sessionKey: "agent:test:a", principal: "test" },
      undefined,
      null,
      "User mentioned that deployment rollbacks complete within five minutes.",
    );
    const second = await persist.persistExtraction(
      factResult(FACT),
      teamB,
      null,
      { sessionKey: "agent:test:b", principal: "test" },
      undefined,
      null,
      "User mentioned that deployment rollbacks complete within five minutes.",
    );

    // Each source namespace keeps its own copy (cross-namespace source writes
    // never dedup), and the second promotion dedups through the shared gate.
    assert.equal(first.persistedIds.length, 1, "first source write persists");
    assert.equal(second.persistedIds.length, 1, "second source write persists in its own namespace");
    assert.equal(await activeFactCopies(teamA), 1);
    assert.equal(await activeFactCopies(teamB), 1);
    assert.equal(await activeFactCopies(shared), 1, "shared namespace holds exactly one promoted copy");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent same-fact promotions from different namespaces leave exactly one active shared copy", async () => {
  const { persist, memoryDir, shared, teamA, teamB } = await makeHarness();
  try {
    const sourceText = "User mentioned that deployment rollbacks complete within five minutes.";
    // Two real sessions, different source namespaces, same fact, one shared
    // destination. Before the fix this interleaving (both pipelines gate-miss
    // in lockstep before either promotion writes) landed two distinct active
    // shared copies; after the fix the destination window serializes the
    // promotions and the invariant holds for every interleaving.
    const [a, b] = await Promise.all([
      persist.persistExtraction(
        factResult(FACT),
        teamA,
        null,
        { sessionKey: "agent:test:a", principal: "test" },
        undefined,
        null,
        sourceText,
      ),
      persist.persistExtraction(
        factResult(FACT),
        teamB,
        null,
        { sessionKey: "agent:test:b", principal: "test" },
        undefined,
        null,
        sourceText,
      ),
    ]);

    // Each source namespace still persists its own copy — the window only
    // serializes the shared DESTINATION.
    assert.equal(await activeFactCopies(teamA), 1, "team-a keeps its source copy");
    assert.equal(await activeFactCopies(teamB), 1, "team-b keeps its source copy");
    assert.equal(a.persistedIds.length, 1);
    assert.equal(b.persistedIds.length, 1);
    assert.equal(
      await activeFactCopies(shared),
      1,
      "exactly one active shared copy survives the concurrent promotion pair",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
