import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir } from "node:fs/promises";

import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { ContentHashIndex } from "./storage.js";
import {
  hasCitation,
  parseCitation,
  stripCitation,
  attachCitation,
} from "./source-attribution.js";
import type { ExtractionResult } from "./types.js";

/**
 * Issue #369 — Orchestrator-level source attribution end-to-end.
 *
 * These tests call persistExtraction directly (the same entry point used by
 * the buffer extraction path and proactive extraction) and verify that:
 *   - The default configuration is a no-op (backwards compat).
 *   - Enabling `inlineSourceAttributionEnabled` causes each persisted fact
 *     to carry a compact provenance tag inside the fact body.
 *   - Custom format templates are honored.
 *   - Round-trip from write through readAllMemories preserves the tag, so
 *     recall injection sees the citation verbatim.
 */

function makeFact(content: string): {
  content: string;
  category: "fact";
  tags: string[];
  confidence: number;
} {
  return { content, category: "fact", tags: [], confidence: 0.9 };
}

async function makeOrchestrator(
  configOverrides: Record<string, unknown> = {},
): Promise<{ orchestrator: any; storage: any; memoryDir: string }> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-source-attribution-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    ...configOverrides,
  });
  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  return { orchestrator, storage, memoryDir };
}

test("persistExtraction is a no-op by default — no inline citation is injected", async () => {
  const { orchestrator, storage } = await makeOrchestrator();

  const factBody =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);
  assert.equal(hasCitation(written.content), false);
  // Raw body must be untouched for existing downstream consumers.
  assert.ok(written.content.includes(factBody));
});

test("ingestReplayBatch splits mixed source timestamps before persisting valid_at", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    threadingEnabled: false,
  });

  const firstFact = "The BEAM fixture records the passphrase as alpine tea.";
  const secondFact = "The BEAM fixture records the depot as cedar hall.";
  const observedSourceGroups: Array<
    Array<{ sourceValidAt: string | undefined; contextOnly: boolean }>
  > = [];
  orchestrator.extraction = {
    extract: async (turns: any[]) => {
      const sourceGroup = turns.map((turn) => ({
        sourceValidAt: turn.sourceValidAt,
        contextOnly: turn.extractionContextOnly === true,
      }));
      observedSourceGroups.push(sourceGroup);
      const firstTarget = turns.find(
        (turn) => turn.extractionContextOnly !== true,
      );
      const factBody =
        firstTarget?.sourceValidAt === "2025-01-01T00:00:00Z"
          ? firstFact
          : secondFact;
      return {
        facts: [makeFact(factBody)],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      } as ExtractionResult;
    },
  };

  await orchestrator.ingestReplayBatch(
    [
      {
        source: "openclaw",
        sessionKey: "beam-source-validity",
        role: "user",
        content: "Earlier source-dated turn.",
        timestamp: "2025-01-01T00:00:00Z",
        sourceValidAt: "2025-01-01T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-source-validity",
        role: "assistant",
        content: "Earlier source-dated response.",
        timestamp: "2025-01-01T00:00:00Z",
        sourceValidAt: "2025-01-01T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-source-validity",
        role: "user",
        content: "Later source-dated turn.",
        timestamp: "2025-01-02T03:04:05Z",
        sourceValidAt: "2025-01-02T03:04:05Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-source-validity",
        role: "assistant",
        content: "Later source-dated response.",
        timestamp: "2025-01-02T03:04:05Z",
        sourceValidAt: "2025-01-02T03:04:05Z",
      },
    ],
    { archiveLcm: false },
  );

  assert.deepEqual(observedSourceGroups, [
    [
      { sourceValidAt: "2025-01-01T00:00:00Z", contextOnly: false },
      { sourceValidAt: "2025-01-01T00:00:00Z", contextOnly: false },
    ],
    [
      { sourceValidAt: "2025-01-01T00:00:00Z", contextOnly: true },
      { sourceValidAt: "2025-01-01T00:00:00Z", contextOnly: true },
      { sourceValidAt: "2025-01-02T03:04:05Z", contextOnly: false },
      { sourceValidAt: "2025-01-02T03:04:05Z", contextOnly: false },
    ],
  ]);

  storage.invalidateAllMemoriesCacheForDir();
  const memories = await storage.readAllMemories();
  const firstWritten = memories.find((memory: any) => memory.content.includes(firstFact));
  const secondWritten = memories.find((memory: any) => memory.content.includes(secondFact));
  assert.ok(firstWritten, "first replay slice should persist its extracted fact");
  assert.ok(secondWritten, "second replay slice should persist its extracted fact");
  assert.equal(firstWritten.frontmatter.valid_at, "2025-01-01T00:00:00.000Z");
  assert.equal(secondWritten.frontmatter.valid_at, "2025-01-02T03:04:05.000Z");
});

test("ingestReplayBatch queues source timestamps chronologically without future context", async () => {
  const { orchestrator } = await makeOrchestrator({
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    threadingEnabled: false,
  });

  const observedSourceGroups: Array<
    Array<{ sourceValidAt: string | undefined; contextOnly: boolean; content: string }>
  > = [];
  orchestrator.extraction = {
    extract: async (turns: any[]) => {
      observedSourceGroups.push(
        turns.map((turn) => ({
          sourceValidAt: turn.sourceValidAt,
          contextOnly: turn.extractionContextOnly === true,
          content: turn.content,
        })),
      );
      return {
        facts: [makeFact(`Observed slice ${observedSourceGroups.length}.`)],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      } as ExtractionResult;
    },
  };

  await orchestrator.ingestReplayBatch(
    [
      {
        source: "openclaw",
        sessionKey: "beam-future-context",
        role: "user",
        content: "Later source-dated turn must not become earlier context.",
        timestamp: "2025-01-03T00:00:00Z",
        sourceValidAt: "2025-01-03T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-future-context",
        role: "assistant",
        content: "Later source-dated response must not become earlier context.",
        timestamp: "2025-01-03T00:00:00Z",
        sourceValidAt: "2025-01-03T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-future-context",
        role: "user",
        content: "Earlier source-dated turn.",
        timestamp: "2025-01-01T00:00:00Z",
        sourceValidAt: "2025-01-01T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-future-context",
        role: "assistant",
        content: "Earlier source-dated response.",
        timestamp: "2025-01-01T00:00:00Z",
        sourceValidAt: "2025-01-01T00:00:00Z",
      },
    ],
    { archiveLcm: false },
  );

  assert.deepEqual(observedSourceGroups, [
    [
      {
        sourceValidAt: "2025-01-01T00:00:00Z",
        contextOnly: false,
        content: "Earlier source-dated turn.",
      },
      {
        sourceValidAt: "2025-01-01T00:00:00Z",
        contextOnly: false,
        content: "Earlier source-dated response.",
      },
    ],
    [
      {
        sourceValidAt: "2025-01-01T00:00:00Z",
        contextOnly: true,
        content: "Earlier source-dated turn.",
      },
      {
        sourceValidAt: "2025-01-01T00:00:00Z",
        contextOnly: true,
        content: "Earlier source-dated response.",
      },
      {
        sourceValidAt: "2025-01-03T00:00:00Z",
        contextOnly: false,
        content: "Later source-dated turn must not become earlier context.",
      },
      {
        sourceValidAt: "2025-01-03T00:00:00Z",
        contextOnly: false,
        content: "Later source-dated response must not become earlier context.",
      },
    ],
  ]);
});

test("ingestReplayBatch globally queues source timestamps across sessions", async () => {
  const { orchestrator } = await makeOrchestrator({
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    threadingEnabled: false,
  });

  const observedTargets: Array<{
    sessionKey: string | undefined;
    sourceValidAt: string | undefined;
    content: string;
  }> = [];
  orchestrator.extraction = {
    extract: async (turns: any[]) => {
      const firstTarget = turns.find(
        (turn) => turn.extractionContextOnly !== true,
      );
      observedTargets.push({
        sessionKey: firstTarget?.sessionKey,
        sourceValidAt: firstTarget?.sourceValidAt,
        content: firstTarget?.content,
      });
      return {
        facts: [makeFact(`Observed cross-session slice ${observedTargets.length}.`)],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      } as ExtractionResult;
    },
  };

  await orchestrator.ingestReplayBatch(
    [
      {
        source: "openclaw",
        sessionKey: "beam-cross-session-later",
        role: "user",
        content: "Later session source-dated turn.",
        timestamp: "2025-01-03T00:00:00Z",
        sourceValidAt: "2025-01-03T00:00:00Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-cross-session-earlier",
        role: "user",
        content: "Earlier session source-dated turn.",
        timestamp: "2025-01-01T00:00:00Z",
        sourceValidAt: "2025-01-01T00:00:00Z",
      },
    ],
    { archiveLcm: false },
  );

  assert.deepEqual(observedTargets, [
    {
      sessionKey: "beam-cross-session-earlier",
      sourceValidAt: "2025-01-01T00:00:00Z",
      content: "Earlier session source-dated turn.",
    },
    {
      sessionKey: "beam-cross-session-later",
      sourceValidAt: "2025-01-03T00:00:00Z",
      content: "Later session source-dated turn.",
    },
  ]);
});

test("ingestReplayBatch preserves undated replay batches without synthetic valid_at slicing", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    threadingEnabled: false,
  });

  const observedSourceGroups: Array<
    Array<{ sourceValidAt: string | undefined; content: string }>
  > = [];
  const undatedFact = "The BEAM undated fixture stores the project codename as river glass.";
  orchestrator.extraction = {
    extract: async (turns: any[]) => {
      observedSourceGroups.push(
        turns.map((turn) => ({
          sourceValidAt: turn.sourceValidAt,
          content: turn.content,
        })),
      );
      return {
        facts: [makeFact(undatedFact)],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      } as ExtractionResult;
    },
  };

  await orchestrator.ingestReplayBatch(
    [
      {
        source: "openclaw",
        sessionKey: "beam-undated-replay",
        role: "user",
        content: "[Turn 1] The codename is river glass.",
        timestamp: "2026-05-11T09:00:00.000Z",
      },
      {
        source: "openclaw",
        sessionKey: "beam-undated-replay",
        role: "assistant",
        content: "[Turn 2] I will remember river glass.",
        timestamp: "2026-05-11T09:00:00.001Z",
      },
    ],
    { archiveLcm: false },
  );

  assert.deepEqual(observedSourceGroups, [
    [
      {
        sourceValidAt: undefined,
        content: "[Turn 1] The codename is river glass.",
      },
      {
        sourceValidAt: undefined,
        content: "[Turn 2] I will remember river glass.",
      },
    ],
  ]);

  storage.invalidateAllMemoriesCacheForDir();
  const memories = await storage.readAllMemories();
  const written = memories.find((memory: any) => memory.content.includes(undatedFact));
  assert.ok(written, "undated replay batch should still persist extracted facts");
  assert.equal(written.frontmatter.valid_at, undefined);
});

test("context-only replay turns do not satisfy the normal user-turn threshold", async () => {
  const { orchestrator } = await makeOrchestrator({
    extractionMinChars: 0,
    extractionMinUserTurns: 1,
    threadingEnabled: false,
  });

  let extractCalls = 0;
  orchestrator.extraction = {
    extract: async () => {
      extractCalls += 1;
      return {
        facts: [makeFact("The BEAM fixture records the depot as cedar hall.")],
        entities: [],
        relationships: [],
        questions: [],
        profileUpdates: [],
      } as ExtractionResult;
    },
  };

  const contextOnlyUser = {
    role: "user",
    content: "What does the fixture call the depot?",
    timestamp: "2025-01-01T00:00:00Z",
    sourceValidAt: "2025-01-01T00:00:00Z",
    extractionContextOnly: true,
    sessionKey: "beam-source-validity",
  };
  const assistantTarget = {
    role: "assistant",
    content: "It calls the depot cedar hall.",
    timestamp: "2025-01-02T03:04:05Z",
    sourceValidAt: "2025-01-02T03:04:05Z",
    sessionKey: "beam-source-validity",
  };

  await orchestrator.runExtraction(
    [contextOnlyUser, assistantTarget],
    {
      clearBufferAfterExtraction: false,
      skipCharThreshold: true,
      bufferKey: "beam-source-validity",
    },
  );

  assert.equal(
    extractCalls,
    0,
    "context-only user turns must not satisfy the normal threshold",
  );

  await orchestrator.runExtraction(
    [contextOnlyUser, assistantTarget],
    {
      clearBufferAfterExtraction: false,
      skipCharThreshold: true,
      skipUserTurnThreshold: true,
      bufferKey: "beam-source-validity",
    },
  );

  assert.equal(
    extractCalls,
    1,
    "replay/import callers may explicitly bypass the user-turn threshold",
  );
});

test("persistExtraction injects the inline citation when the flag is enabled", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
  });

  const factBody =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written, "persisted memory must be readable");

  assert.ok(
    hasCitation(written.content),
    `expected citation in stored content, got: ${written.content}`,
  );
  const parsed = parseCitation(written.content);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "planner");
  assert.equal(parsed!.session, "main");
  assert.ok(parsed!.ts && parsed!.ts.length > 0);

  // Downstream consumers can recover the raw fact body.
  assert.equal(stripCitation(written.content), factBody);
});

test("persistExtraction honors a custom inline citation format template", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
    inlineSourceAttributionFormat: "[src:{agent}/{sessionId}@{date}]",
  });

  const factBody = "The cache invalidation interval is 30 seconds.";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:scout:alpha", principal: "scout" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);

  // Custom template uses a different bracket syntax, which the default
  // parser does not recognise — but we can still verify the text contains
  // the expected markers and that the raw body is unchanged.
  assert.ok(
    /\[src:scout\/alpha@\d{4}-\d{2}-\d{2}\]/.test(written.content),
    `expected custom citation template, got: ${written.content}`,
  );
  assert.ok(written.content.startsWith(factBody));
});

test("persistExtraction does not double-inject a citation on facts that already carry one", async () => {
  const { orchestrator, storage } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
  });

  // Simulate a fact that already carries a citation (e.g., relayed from an
  // upstream system or a legacy migrated fact). attachCitation must refuse
  // to overwrite existing provenance.
  const factBody =
    "The auth service rotates tokens every 24 hours. [Source: agent=upstream, session=legacy, ts=2025-01-01T00:00:00Z]";
  const result: ExtractionResult = {
    facts: [makeFact(factBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(persistedIds.length, 1);

  const memories = await storage.readAllMemories();
  const written = memories.find(
    (m: any) => m.frontmatter.id === persistedIds[0],
  );
  assert.ok(written);

  const parsed = parseCitation(written.content);
  assert.ok(parsed);
  assert.equal(parsed!.agent, "upstream");
  assert.equal(parsed!.session, "legacy");
  assert.equal(parsed!.ts, "2025-01-01T00:00:00Z");
});

// ---------------------------------------------------------------------------
// Fix #1 regression: Codex P2 — Canonicalize pre-tagged facts before hashing
// ---------------------------------------------------------------------------

test("dedup: pre-tagged fact is not re-persisted when canonical body is already in the hash index", async () => {
  // When a fact arrives with an existing citation (e.g. relayed from another
  // system), the dedup check must canonicalize to the raw body BEFORE hashing
  // so it matches the entry stored from the original write.
  const { orchestrator, storage, memoryDir } = await makeOrchestrator({
    inlineSourceAttributionEnabled: true,
    factDeduplicationEnabled: true,
  });

  // Inject a real ContentHashIndex so the dedup path is active.
  const stateDir = `${memoryDir}/state`;
  await mkdir(stateDir, { recursive: true });
  const hashIndex = new ContentHashIndex(stateDir);
  await hashIndex.load();
  (orchestrator as any).contentHashIndex = hashIndex;

  const rawBody = "The canary deploys complete in under two minutes.";

  // First persist: write the raw fact; the orchestrator appends its own citation
  // and also registers the raw-content hash in the index via contentHashSource.
  const firstResult: ExtractionResult = {
    facts: [makeFact(rawBody)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const firstIds = await orchestrator.persistExtraction(
    firstResult,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );
  assert.equal(firstIds.length, 1, "first persist must succeed");

  // Read back the persisted body so we have the exact cited form.
  const memories = await storage.readAllMemories();
  const firstMemory = memories.find((m: any) => m.frontmatter.id === firstIds[0]);
  assert.ok(firstMemory, "first memory must be readable");
  assert.ok(hasCitation(firstMemory.content), "first write must carry a citation");

  // Second persist: submit the ALREADY-CITED body as if it arrived from a relay.
  // The orchestrator must canonicalize before dedup and skip the write.
  const secondResult: ExtractionResult = {
    facts: [makeFact(firstMemory.content)],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const secondIds = await orchestrator.persistExtraction(
    secondResult,
    storage,
    null,
    { sessionKey: "agent:planner:main", principal: "planner" },
  );

  // The pre-tagged fact should be deduped — nothing new is persisted.
  assert.equal(
    secondIds.length,
    0,
    "pre-tagged duplicate must be caught by dedup after canonicalization",
  );

  // Confirm only one memory with that content exists on disk.
  const allMemories = await storage.readAllMemories();
  const matching = allMemories.filter(
    (m: any) => stripCitation(m.content) === rawBody,
  );
  assert.equal(
    matching.length,
    1,
    "only one copy of the fact must be stored",
  );
});
