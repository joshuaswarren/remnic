
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

interface OrchestratorFixture {
  localLlm?: unknown;
  chatCompletion?: unknown;
  getStorage?: unknown;
  persistExtraction?: unknown;
}

interface OrchestratorInternals {
  localLlm: LocalLlmClient;
  getStorage: (ns: string) => Promise<StorageManager>;
  persistExtraction: PersistExtractionFn;
}

  // SAFETY: the fixture provides the members the persist path reads; the
  // remaining contract members are unused by these tests.
function asInternals<T extends object>(value: OrchestratorFixture): T {
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
    extractionJudgeEnabled: false,
    temporalSupersessionEnabled: false,
    contradictionDetectionEnabled: false,
    chunkingEnabled: false,
    embeddingFallbackEnabled: false,
    qmdEnabled: false,
    extractionMinChars: 0,
    extractionMinImportanceLevel: "trivial",
    inlineSourceAttributionEnabled: false,
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
        confidence: 0.96,
        tags: [],
      },
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  // SAFETY: literal carries the full extraction-result shape persistExtraction
  // consumes for a single fact candidate.
  };
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
