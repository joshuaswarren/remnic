import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { parseConfig } from "@remnic/core/config";
import {
  isAboveImportanceThreshold,
  scoreImportance,
} from "@remnic/core/importance";
import { initLogger, type LoggerBackend } from "@remnic/core/logger";
import { Orchestrator } from "@remnic/core/orchestrator";
import { normalizeEntityName, parseEntityFile } from "@remnic/core/storage";
import type { ExtractionResult, ImportanceLevel } from "@remnic/core/types";

// ---------------------------------------------------------------------------
// Logger capture helper
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
  // Enable debug so the importance-gate skip/metric log is captured.
  initLogger(backend, true);
  return { entries };
}

function makeFact(
  overrides: Partial<{
    content: string;
    category: string;
    tags: string[];
    confidence: number;
  }> = {},
): {
  content: string;
  category: string;
  tags: string[];
  confidence: number;
} {
  return {
    content: overrides.content ?? "A neutral placeholder fact.",
    category: overrides.category ?? "fact",
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? 0.9,
  };
}

async function makeOrchestrator(
  overrides: Partial<{ extractionMinImportanceLevel: ImportanceLevel }> = {},
): Promise<{ orchestrator: any; storage: any; memoryDir: string }> {
  const memoryDir = await mkdtemp(
    path.join(os.tmpdir(), "engram-importance-gate-"),
  );
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    chunkingEnabled: false,
    ...overrides,
  });
  const orchestrator = new Orchestrator(config) as any;
  const storage = await orchestrator.getStorage("default");
  await storage.ensureDirectories();
  return { orchestrator, storage, memoryDir };
}

// ---------------------------------------------------------------------------
// Pure helper: isAboveImportanceThreshold
// ---------------------------------------------------------------------------

test("isAboveImportanceThreshold enforces inclusive lower bound", () => {
  // Exact match passes.
  assert.equal(isAboveImportanceThreshold("low", "low"), true);
  assert.equal(isAboveImportanceThreshold("normal", "normal"), true);
  // Higher levels pass.
  assert.equal(isAboveImportanceThreshold("critical", "low"), true);
  assert.equal(isAboveImportanceThreshold("high", "normal"), true);
  // Lower levels fail.
  assert.equal(isAboveImportanceThreshold("trivial", "low"), false);
  assert.equal(isAboveImportanceThreshold("low", "normal"), false);
  assert.equal(isAboveImportanceThreshold("normal", "high"), false);
});

// ---------------------------------------------------------------------------
// Regression guard: category boosts survive into the scored level.
//
// Corrections at a pre-boost raw score that would otherwise land at "low"
// must still pass the default "normal" gate, because scoreImportance() applies
// the +0.15 correction boost before deriving the level.
// ---------------------------------------------------------------------------

test("scoreImportance surfaces correction boost into the level used by the gate", () => {
  // "maybe" fires a LOW_PATTERNS hit (-0.15) against the 0.5 baseline, so
  // the raw score lands at ~0.35 — "low" for a plain fact. The correction
  // category boost (+0.15) pushes the same content to 0.50, which is
  // "normal". Without this boost, legitimate corrections would be gated
  // under the default "low"/"normal" thresholds.
  const content = "maybe that setting is incorrect";

  const asFact = scoreImportance(content, "fact", []);
  const asCorrection = scoreImportance(content, "correction", []);

  // Sanity: the correction boost is visible in the numeric score.
  assert.ok(
    asCorrection.score >= asFact.score + 0.1 - 1e-9,
    `expected correction boost, got fact=${asFact.score} correction=${asCorrection.score}`,
  );
  assert.equal(asFact.level, "low");
  assert.equal(asCorrection.level, "normal");

  // Regression guard: correction-category content at this raw range passes
  // the "normal" gate, while the same text without the boost does NOT.
  assert.equal(isAboveImportanceThreshold(asCorrection.level, "normal"), true);
  assert.equal(isAboveImportanceThreshold(asFact.level, "normal"), false);
});

// ---------------------------------------------------------------------------
// Orchestrator.persistExtraction() end-to-end gate behavior
// ---------------------------------------------------------------------------

test("persistExtraction drops trivial facts under the default 'low' gate", async () => {
  const { entries } = installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  // Each of these content strings hits TRIVIAL_PATTERNS in scoreImportance.
  const trivialInputs = [
    "hi",
    "k",
    "heartbeat",
  ];

  // Sanity: the importance scorer agrees these are trivial.
  for (const content of trivialInputs) {
    assert.equal(scoreImportance(content, "fact", []).level, "trivial");
  }

  const result: ExtractionResult = {
    facts: trivialInputs.map((content) => makeFact({ content })),
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
  );

  assert.equal(persistedIds.length, 0, "trivial facts must not be persisted");

  const metricLogs = entries.filter((e) =>
    e.message.includes("metric:importance_gated"),
  );
  assert.equal(metricLogs.length, trivialInputs.length);

  const skipLogs = entries.filter((e) =>
    e.message.includes("extraction: skip trivial"),
  );
  assert.equal(skipLogs.length, trivialInputs.length);
  assert.ok(skipLogs.some((e) => e.message.includes('"hi"')));
});

test("persistExtraction writes normal-importance facts under the default gate", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  const content =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  // Sanity: this lands at or above "normal" so it should pass the default gate.
  const scored = scoreImportance(content, "fact", []);
  assert.ok(
    isAboveImportanceThreshold(scored.level, "low"),
    `expected content to score above 'low', got ${scored.level}`,
  );

  const result: ExtractionResult = {
    facts: [makeFact({ content })],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
  );

  assert.equal(persistedIds.length, 1);
});

test("persistExtraction preserves structured entity sections on entity files", async () => {
  installCapturingLogger();
  const { orchestrator, storage, memoryDir } = await makeOrchestrator();

  const result: ExtractionResult = {
    facts: [],
    entities: [
      {
        name: "Jane Doe",
        type: "person",
        facts: ["Leads the roadmap."],
        structuredSections: [
          {
            key: "beliefs",
            title: "Beliefs",
            facts: ["Small teams move faster than committees."],
          },
        ],
      },
    ],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  await orchestrator.persistExtraction(result, storage, null);

  const canonical = normalizeEntityName("Jane Doe", "person");
  const raw = await (await import("node:fs/promises")).readFile(
    path.join(memoryDir, "entities", `${canonical}.md`),
    "utf-8",
  );
  const parsed = parseEntityFile(raw) as any;
  assert.deepEqual(parsed.structuredSections, [
    {
      key: "beliefs",
      title: "Beliefs",
      facts: ["Small teams move faster than committees."],
    },
  ]);
});

test("persistExtraction preserves correction boost so corrections pass 'normal' gate", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    extractionMinImportanceLevel: "normal",
  });

  const content = "maybe that setting is incorrect";
  // Pre-condition: same text as a plain fact would be gated at "normal".
  assert.equal(
    isAboveImportanceThreshold(
      scoreImportance(content, "fact", []).level,
      "normal",
    ),
    false,
  );

  const result: ExtractionResult = {
    facts: [makeFact({ content, category: "correction" })],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
  );

  assert.equal(
    persistedIds.length,
    1,
    "correction boost must carry fact above the 'normal' gate",
  );
});

test("persistExtraction honours a stricter 'high' gate override", async () => {
  installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator({
    extractionMinImportanceLevel: "high",
  });

  // A normal-importance fact that would pass the default gate but not "high".
  const content =
    "The production database is hosted on Postgres 16 and uses port 5432.";
  const scored = scoreImportance(content, "fact", []);
  assert.equal(
    isAboveImportanceThreshold(scored.level, "high"),
    false,
    "fixture must score below 'high' for this test to be meaningful",
  );

  const result: ExtractionResult = {
    facts: [makeFact({ content })],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(
    result,
    storage,
    null,
  );

  assert.equal(persistedIds.length, 0);
});

test("importance gate metric counter increments monotonically across a run", async () => {
  const { entries } = installCapturingLogger();
  const { orchestrator, storage } = await makeOrchestrator();

  const result: ExtractionResult = {
    facts: [
      makeFact({ content: "hi" }),
      makeFact({ content: "k" }),
      makeFact({ content: "thanks" }),
    ],
    entities: [],
    relationships: [],
    questions: [],
    profileUpdates: [],
  } as ExtractionResult;

  const persistedIds = await orchestrator.persistExtraction(result, storage, null);

  assert.deepEqual(persistedIds, []);

  const counters = entries
    .filter((e) => e.message.includes("metric:importance_gated"))
    .map((e) => {
      const match = e.message.match(/count=(\d+)/);
      return match ? Number(match[1]) : NaN;
    });
  assert.deepEqual(counters, [1, 2, 3]);
});
