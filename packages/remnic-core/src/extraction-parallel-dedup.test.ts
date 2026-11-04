/**
 * Issue #3312 — non-fact dedup registration must share the fact-dedup commit
 * window.
 *
 * writeMemory indexes content hashes for facts only (rule 44 #1579); every
 * other category used to register its hash in a post-write block that ran
 * after persistUnderFactDedupWindow had already released the per-dir commit
 * window. With extractionQueueConcurrency > 1 a second session's in-window
 * recheck could then miss and both sessions wrote the same preference —
 * duplicate active copies. The fix registers the hash inside the window
 * callback, so any later window holder observes the committed content.
 *
 * These tests drive the real persistExtraction path (no LLM network; every
 * gate that would call one is off) and assert the durable outcome: exactly
 * one active copy survives a concurrent same-content write pair.
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
}> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-parallel-dedup-"));
  const config: PluginConfig = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    // Minimize every gate that needs a model or corpus-scale machinery so the
    // preference reaches the normal (non-chunked) write path.
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    qmdEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
    // Real deployment profile: the artifact write sits between the window
    // release and hash registration, widening the exact gap under test.
    verbatimArtifactsEnabled: true,
    verbatimArtifactCategories: ["preference"],
  });
  const orchestrator = new Orchestrator(config);
  const internals = asInternals<OrchestratorInternals>(orchestrator);
  internals.localLlm = asInternals<LocalLlmClient>({ chatCompletion: async () => null });
  return { orchestrator, persist: internals, memoryDir };
}

function preferenceResult(content: string): ExtractionResult {
  const result = {
    facts: [
      {
        content,
        category: "preference",
        tags: [],
        confidence: 0.9,
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  };
  // SAFETY: literal carries the full extraction-result shape persistExtraction
  // consumes for a single preference candidate.
  return result as ExtractionResult;
}

async function activePreferenceCopies(storage: StorageManager): Promise<number> {
  const memories = await storage.readAllMemories();
  return memories.filter(
    (m) => m.frontmatter.category === "preference" && (m.frontmatter.status ?? "active") === "active",
  ).length;
}

const PREFERENCE = "Always answer with bullet points.";

test("a repeated identical preference persists once (serial baseline)", async () => {
  const { persist, memoryDir } = await makeHarness();
  try {
    const storage = await persist.getStorage("default");
    await storage.ensureDirectories();

    const first = await persist.persistExtraction(
      preferenceResult(PREFERENCE),
      storage,
      null,
      { sessionKey: "agent:test:a", principal: "test" },
      undefined,
      null,
      "User said they always want bullet points.",
    );
    const second = await persist.persistExtraction(
      preferenceResult(PREFERENCE),
      storage,
      null,
      { sessionKey: "agent:test:b", principal: "test" },
      undefined,
      null,
      "User said they always want bullet points.",
    );

    assert.equal(first.persistedIds.length, 1, "first write persists");
    assert.equal(second.persistedIds.length, 0, "second identical write is deduped");
    assert.equal(await activePreferenceCopies(storage), 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent identical preferences leave exactly one active copy", async () => {
  const { persist, memoryDir } = await makeHarness();
  try {
    const storage = await persist.getStorage("default");
    await storage.ensureDirectories();

    const sourceText = "User said they always want bullet points.";
    // The race was probabilistic before the fix (the window released before
    // registration); after it, this invariant holds for every interleaving.
    const [a, b] = await Promise.all([
      persist.persistExtraction(
        preferenceResult(PREFERENCE),
        storage,
        null,
        { sessionKey: "agent:test:a", principal: "test" },
        undefined,
        null,
        sourceText,
      ),
      persist.persistExtraction(
        preferenceResult(PREFERENCE),
        storage,
        null,
        { sessionKey: "agent:test:b", principal: "test" },
        undefined,
        null,
        sourceText,
      ),
    ]);

    assert.equal(
      a.persistedIds.length + b.persistedIds.length,
      1,
      "exactly one concurrent write may persist",
    );
    assert.equal(await activePreferenceCopies(storage), 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
