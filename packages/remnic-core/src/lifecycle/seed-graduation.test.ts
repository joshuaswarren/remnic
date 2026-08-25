import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { parseConfig } from "../config.js";
import type { EmbeddingFallback } from "../embedding-fallback.js";
import type { ExtractionEngine } from "../extraction.js";
import {
  LifecyclePolicyCoordinator,
  type LifecyclePolicyCoordinatorDeps,
} from "../orchestration/lifecycle-policy-coordinator.js";
import { RecallHandleHistoryStore } from "../recall-state.js";
import { StorageManager } from "../storage.js";
import type { MemoryFile, MemoryFrontmatter } from "../types.js";
import {
  SEED_GRADUATION_DEFAULTS,
  evaluateSeedGraduation,
  parseSeedGraduationConfig,
  runSeedGraduationPass,
  type SeedGraduationConfig,
} from "./seed-graduation.js";

const ENABLED: SeedGraduationConfig = { enabled: true, minCorroborations: 1 };

const SEED_TEXT = "The launch moved to September twelfth after the vendor call.";
// Restates the seed in similar wording (the wearable support-corpus pair).
const RESTATE_TEXT = "Launch moved to September twelfth after the vendor call.";
const UNRELATED_TEXT = "Quarterly budget planning covered the new office lease.";
// Restates the seed's core content with flipped negation polarity.
const CONTRADICT_TEXT = "The launch was not moved to September twelfth after the vendor call.";
const NEGATED_UNRELATED_TEXT =
  "The office lease was not approved during quarterly budget planning.";

function fakeMemory(overrides: {
  id: string;
  content: string;
  created: string;
  source?: string;
  status?: MemoryFrontmatter["status"];
  structuredAttributes?: Record<string, string>;
  lineage?: string[];
}): MemoryFile {
  return {
    path: `facts/${overrides.id}.md`,
    content: overrides.content,
    frontmatter: {
      id: overrides.id,
      category: "fact",
      created: overrides.created,
      updated: overrides.created,
      source: overrides.source ?? "extraction",
      confidence: 0.7,
      confidenceTier: "inferred",
      tags: [],
      status: overrides.status,
      structuredAttributes: overrides.structuredAttributes,
      lineage: overrides.lineage,
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("seedGraduation defaults to disabled with minCorroborations 2", () => {
  assert.deepEqual(SEED_GRADUATION_DEFAULTS, { enabled: false, minCorroborations: 2 });
  assert.deepEqual(parseSeedGraduationConfig(undefined), SEED_GRADUATION_DEFAULTS);
  assert.deepEqual(parseSeedGraduationConfig({}), SEED_GRADUATION_DEFAULTS);
  assert.deepEqual(parseSeedGraduationConfig({ enabled: "true", minCorroborations: "3" }), {
    enabled: true,
    minCorroborations: 3,
  });
});

test("seedGraduation rejects invalid values instead of defaulting", () => {
  assert.throws(() => parseSeedGraduationConfig("yes"), /seedGraduation must be an object/);
  assert.throws(() => parseSeedGraduationConfig([1]), /seedGraduation must be an object/);
  assert.throws(
    () => parseSeedGraduationConfig({ enabled: "maybe" }),
    /seedGraduation\.enabled must be a boolean/,
  );
  assert.throws(
    () => parseSeedGraduationConfig({ minCorroborations: 0 }),
    /minCorroborations must be an integer in \[1, 50\]/,
  );
  assert.throws(
    () => parseSeedGraduationConfig({ minCorroborations: 1.5 }),
    /minCorroborations must be an integer in \[1, 50\]/,
  );
  assert.throws(
    () => parseConfig({ memoryDir: "/tmp/remnic-seed-graduation-invalid", seedGraduation: "yes" }),
    /seedGraduation must be an object/,
  );
});

test("parseConfig wires seedGraduation; conservative pins it off", () => {
  const memoryDir = "/tmp/remnic-seed-graduation-parse";
  const defaults = parseConfig({ memoryDir });
  assert.deepEqual(defaults.seedGraduation, SEED_GRADUATION_DEFAULTS);
  assert.equal(defaults.seedGraduation.enabled, false);

  const optedIn = parseConfig({
    memoryDir,
    seedGraduation: { enabled: true, minCorroborations: 3 },
  });
  assert.deepEqual(optedIn.seedGraduation, { enabled: true, minCorroborations: 3 });

  assert.equal(
    parseConfig({ memoryDir, memoryOsPreset: "conservative" }).seedGraduation.enabled,
    false,
    "the conservative preset pins seed graduation off",
  );
  assert.equal(
    parseConfig({
      memoryDir,
      memoryOsPreset: "balanced",
      seedGraduation: { enabled: true },
    }).seedGraduation.enabled,
    true,
  );
});

// ---------------------------------------------------------------------------
// Gate — echo suppression (pure)
// ---------------------------------------------------------------------------

test("evidence from the seed's own session never corroborates (self-echo)", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    structuredAttributes: { sessionKey: "session-a" },
  });
  const echo = fakeMemory({
    id: "echo-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    structuredAttributes: { sessionKey: "session-a" },
  });
  const decision = evaluateSeedGraduation(seed, [echo], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.corroborationCount, 0);
  assert.equal(decision.echoSuppressedCount, 1);
});

test("identical source without session anchors is never independent (fail closed)", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "extraction",
  });
  const lookalike = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "extraction",
  });
  const decision = evaluateSeedGraduation(seed, [lookalike], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.echoSuppressedCount, 1);
});

test("a session that recalled the seed cannot corroborate it (quoted-back echo)", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
    structuredAttributes: { sessionKey: "session-a" },
  });
  // Different session AND different source — passes the anchor rules, but the
  // session's recall history shows the seed was injected there: pure echo.
  const readback = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "extraction",
    structuredAttributes: { sessionKey: "session-b" },
  });
  const decision = evaluateSeedGraduation(seed, [readback], {
    config: ENABLED,
    recalledBySession: (sessionKey) =>
      sessionKey === "session-b" ? [["seed-1", "other-mem"]] : [],
  });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.echoSuppressedCount, 1);
  // Same evidence, but the session never recalled the seed → real corroboration.
  const clean = evaluateSeedGraduation(seed, [readback], {
    config: ENABLED,
    recalledBySession: () => [],
  });
  assert.equal(clean.decision, "promote");
});

test("a lineage descendant of the seed is derivation, not corroboration", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
  });
  const derived = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "extraction",
    lineage: ["seed-1"],
  });
  const decision = evaluateSeedGraduation(seed, [derived], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.echoSuppressedCount, 1);
});

test("independent later evidence from a different provenance corroborates", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
  });
  const independent = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [independent], { config: ENABLED });
  assert.equal(decision.decision, "promote");
  assert.deepEqual(decision.corroborating, [
    { memoryId: "ev-1", source: "wearable:limitless" },
  ]);
});

test("minCorroborations counts distinct corroborating memories", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
  });
  const evidence = [
    fakeMemory({
      id: "ev-1",
      content: RESTATE_TEXT,
      created: "2026-08-02T10:00:00.000Z",
      source: "wearable:limitless",
    }),
    fakeMemory({
      id: "ev-2",
      content: `Noted separately: ${RESTATE_TEXT}`,
      created: "2026-08-03T10:00:00.000Z",
      source: "extraction",
    }),
  ];
  const one = evaluateSeedGraduation(seed, evidence, {
    config: { enabled: true, minCorroborations: 2 },
  });
  // ev-2 restates via a superset of tokens; both count → promotes at 2.
  assert.equal(one.decision, "promote");
  assert.equal(one.corroborationCount, 2);

  const short = evaluateSeedGraduation(seed, [evidence[0]], {
    config: { enabled: true, minCorroborations: 2 },
  });
  assert.equal(short.decision, "hold");
  assert.ok(short.reasons.includes("corroboration-below-min:1/2"));
});

test("low token coverage is not corroboration and is not echo", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
  });
  const unrelated = fakeMemory({
    id: "ev-1",
    content: UNRELATED_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [unrelated], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.corroborationCount, 0);
  assert.equal(decision.echoSuppressedCount, 0);
});

test("evidence written at or before the seed does not corroborate", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
  });
  const earlier = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const sameMoment = fakeMemory({
    id: "ev-2",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "extraction",
  });
  const decision = evaluateSeedGraduation(seed, [earlier, sameMoment], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.corroborationCount, 0);
});

test("disabled config holds with the disabled reason (zero-value semantics)", () => {
  const seed = fakeMemory({
    id: "seed-1",
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
  });
  const decision = evaluateSeedGraduation(seed, [], { config: SEED_GRADUATION_DEFAULTS });
  assert.equal(decision.decision, "hold");
  assert.deepEqual(decision.reasons, ["seed-graduation-disabled"]);
});

// ---------------------------------------------------------------------------
// Gate — contradiction during the corroboration window (issue #2974)
// ---------------------------------------------------------------------------

function seedMemory(overrides: Partial<Parameters<typeof fakeMemory>[0]> & { id: string }): MemoryFile {
  return fakeMemory({
    content: SEED_TEXT,
    created: "2026-08-01T10:00:00.000Z",
    status: "pending_review",
    source: "wearable:bee",
    ...overrides,
  });
}

test("an independent negated restatement holds the seed even with enough corroborations", () => {
  const seed = seedMemory({ id: "seed-1" });
  const corroborator = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const contradictor = fakeMemory({
    id: "ev-2",
    content: CONTRADICT_TEXT,
    created: "2026-08-03T10:00:00.000Z",
    source: "extraction",
  });
  const decision = evaluateSeedGraduation(seed, [corroborator, contradictor], {
    config: ENABLED,
  });
  assert.equal(decision.decision, "hold", "contradiction vetoes graduation");
  assert.deepEqual(decision.contradicting, [{ memoryId: "ev-2", source: "extraction" }]);
  assert.ok(decision.reasons.includes("contradiction-observed:1"));
});

test("a negated seed restated positively is held (polarity symmetry)", () => {
  const seed = seedMemory({ id: "seed-1", content: CONTRADICT_TEXT });
  const positive = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [positive], { config: ENABLED });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.contradicting.length, 1);
});

test("a same-session negation is a draft correction, not a contradiction", () => {
  const seed = seedMemory({
    id: "seed-1",
    structuredAttributes: { sessionKey: "session-a" },
  });
  const retraction = fakeMemory({
    id: "ev-2",
    content: CONTRADICT_TEXT,
    created: "2026-08-03T10:00:00.000Z",
    source: "extraction",
    structuredAttributes: { sessionKey: "session-a" },
  });
  const corroborator = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [retraction, corroborator], {
    config: ENABLED,
  });
  assert.equal(decision.decision, "promote");
  assert.equal(decision.contradicting.length, 0);
});

test("a polarity flip without core-content restatement neither contradicts nor corroborates", () => {
  const seed = seedMemory({ id: "seed-1" });
  const negatedUnrelated = fakeMemory({
    id: "ev-2",
    content: NEGATED_UNRELATED_TEXT,
    created: "2026-08-03T10:00:00.000Z",
    source: "extraction",
  });
  const corroborator = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [negatedUnrelated, corroborator], {
    config: ENABLED,
  });
  assert.equal(decision.decision, "promote");
  assert.equal(decision.contradicting.length, 0);
});

test("recall echo does not suppress a contradiction: denying a recalled seed is a correction", () => {
  const seed = seedMemory({
    id: "seed-1",
    structuredAttributes: { sessionKey: "session-a" },
  });
  const contradictor = fakeMemory({
    id: "ev-2",
    content: CONTRADICT_TEXT,
    created: "2026-08-03T10:00:00.000Z",
    source: "extraction",
    structuredAttributes: { sessionKey: "session-b" },
  });
  const decision = evaluateSeedGraduation(seed, [contradictor], {
    config: ENABLED,
    recalledBySession: (sessionKey) =>
      sessionKey === "session-b" ? [["seed-1"]] : [],
  });
  assert.equal(decision.decision, "hold");
  assert.equal(decision.contradicting.length, 1);
});

test("a superseded contradictor no longer holds the seed (review resolution unblocks)", () => {
  const seed = seedMemory({ id: "seed-1" });
  const resolved = fakeMemory({
    id: "ev-2",
    content: CONTRADICT_TEXT,
    created: "2026-08-03T10:00:00.000Z",
    source: "extraction",
    status: "superseded",
  });
  const corroborator = fakeMemory({
    id: "ev-1",
    content: RESTATE_TEXT,
    created: "2026-08-02T10:00:00.000Z",
    source: "wearable:limitless",
  });
  const decision = evaluateSeedGraduation(seed, [resolved, corroborator], {
    config: ENABLED,
  });
  assert.equal(decision.decision, "promote");
  assert.equal(decision.contradicting.length, 0);
});

// ---------------------------------------------------------------------------
// Pass — against a real StorageManager (acceptance cases)
// ---------------------------------------------------------------------------

function makeStorage(): { storage: StorageManager; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-seed-graduation-"));
  return { storage: new StorageManager(dir), dir };
}

test("pass: self-echo evidence does not promote a pending_review seed", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "extraction",
      status: "pending_review",
      structuredAttributes: { sessionKey: "session-a" },
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "extraction",
      structuredAttributes: { sessionKey: "session-a" },
    });
    const memories = await storage.readAllMemories();
    const summary = await runSeedGraduationPass({
      memories,
      storage,
      config: ENABLED,
    });
    assert.equal(summary.evaluated, 1);
    assert.equal(summary.promoted, 0, "same-session echo must not graduate the seed");
    assert.equal(summary.echoSuppressed, 1);
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.status === "pending_review",
    );
    assert.ok(seed, "seed stays pending_review");
    assert.equal(seed.frontmatter.structuredAttributes?.graduatedBy, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pass: independent corroboration promotes the seed in place with audit attributes", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    const memories = await storage.readAllMemories();
    const summary = await runSeedGraduationPass({
      memories,
      storage,
      config: ENABLED,
    });
    assert.equal(summary.promoted, 1);
    const rows = await storage.readAllMemories();
    const seed = rows.find((memory) => memory.frontmatter.source === "wearable:bee");
    assert.ok(seed);
    assert.equal(seed.frontmatter.status, "active", "graduated by corroboration");
    const attrs = seed.frontmatter.structuredAttributes ?? {};
    assert.equal(attrs.graduatedBy, "independent-corroboration");
    assert.equal(attrs.corroborationCount, "1");
    const evidence = rows.find((memory) => memory.frontmatter.source === "wearable:limitless");
    assert.ok(evidence);
    assert.equal(attrs.corroboratingMemoryIds, evidence.frontmatter.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pass: contradiction during the window holds the seed in place", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    await storage.writeMemory("fact", CONTRADICT_TEXT, {
      source: "extraction",
    });
    const memories = await storage.readAllMemories();
    const summary = await runSeedGraduationPass({
      memories,
      storage,
      config: ENABLED,
    });
    assert.equal(summary.evaluated, 1);
    assert.equal(summary.promoted, 0, "contradicted seed must not graduate");
    assert.equal(summary.held, 1);
    assert.equal(summary.contradictionHeld, 1);
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.ok(seed);
    assert.equal(seed.frontmatter.status, "pending_review", "held for review resolution");
    assert.equal(seed.frontmatter.structuredAttributes?.graduatedBy, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pass: a non-corroborated seed stays in its prior state", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", UNRELATED_TEXT, {
      source: "wearable:limitless",
    });
    const memories = await storage.readAllMemories();
    const summary = await runSeedGraduationPass({
      memories,
      storage,
      config: ENABLED,
    });
    assert.equal(summary.promoted, 0);
    assert.equal(summary.held, 1);
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.ok(seed);
    assert.equal(seed.frontmatter.status, "pending_review", "no corroboration, no change");
    assert.equal(seed.frontmatter.structuredAttributes?.graduatedBy, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pass: disabled config touches nothing", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    const memories = await storage.readAllMemories();
    const summary = await runSeedGraduationPass({
      memories,
      storage,
      config: SEED_GRADUATION_DEFAULTS,
    });
    assert.deepEqual(summary, {
      evaluated: 0,
      promoted: 0,
      held: 0,
      contradictionHeld: 0,
      echoSuppressed: 0,
      disabled: true,
    });
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.equal(seed?.frontmatter.status, "pending_review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring — parseConfig + lifecycle policy pass
// ---------------------------------------------------------------------------

function coordinatorDeps(
  storage: StorageManager,
  config: ReturnType<typeof parseConfig>,
  handleHistory?: RecallHandleHistoryStore,
): LifecyclePolicyCoordinatorDeps {
  return {
    config,
    getStorage: () => storage,
    extraction: {} as unknown as ExtractionEngine,
    embeddingFallback: {} as unknown as EmbeddingFallback,
    getEffectiveLifecycleThresholds: () => ({
      promoteHeatThreshold: 1,
      staleDecayThreshold: 0,
      archiveDecayThreshold: 0,
    }),
    async removeContentHashForMemory(): Promise<void> {},
    async saveContentHashIndexes(): Promise<void> {},
    getHandleHistory: handleHistory ? () => handleHistory : undefined,
  };
}

test("lifecycle pass: gate off makes zero promoteWearableMemory calls", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    const config = parseConfig({ memoryDir: dir });
    assert.equal(config.seedGraduation.enabled, false);

    let promoteCalls = 0;
    const original = storage.promoteWearableMemory.bind(storage);
    storage.promoteWearableMemory = async (id, attrs, confidence) => {
      promoteCalls += 1;
      return original(id, attrs, confidence);
    };

    const memories = await storage.readAllMemories();
    await new LifecyclePolicyCoordinator(coordinatorDeps(storage, config)).runLifecyclePolicyPass(
      memories,
      storage,
    );
    assert.equal(promoteCalls, 0, "disabled seed graduation must not call promoteWearableMemory");
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.equal(seed?.frontmatter.status, "pending_review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle pass: enabled independent corroboration promotes through the policy seam", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    const config = parseConfig({
      memoryDir: dir,
      seedGraduation: { enabled: true, minCorroborations: 1 },
    });
    const memories = await storage.readAllMemories();
    await new LifecyclePolicyCoordinator(coordinatorDeps(storage, config)).runLifecyclePolicyPass(
      memories,
      storage,
    );
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.equal(seed?.frontmatter.status, "active");
    assert.equal(seed?.frontmatter.structuredAttributes?.graduatedBy, "independent-corroboration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle pass: recall-handle history suppresses echo corroboration", async () => {
  const { storage, dir } = makeStorage();
  try {
    const seedWrite = await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
      structuredAttributes: { sessionKey: "session-a" },
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "extraction",
      structuredAttributes: { sessionKey: "session-b" },
    });
    const history = new RecallHandleHistoryStore(dir);
    await history.record("session-b", [seedWrite.id]);
    const config = parseConfig({
      memoryDir: dir,
      seedGraduation: { enabled: true, minCorroborations: 1 },
    });
    const memories = await storage.readAllMemories();
    await new LifecyclePolicyCoordinator(
      coordinatorDeps(storage, config, history),
    ).runLifecyclePolicyPass(memories, storage);
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.equal(seed?.frontmatter.status, "pending_review", "quoted-back echo must not graduate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle pass: contradiction during the window holds the seed through the policy seam", async () => {
  const { storage, dir } = makeStorage();
  try {
    await storage.writeMemory("fact", SEED_TEXT, {
      source: "wearable:bee",
      status: "pending_review",
    });
    await storage.writeMemory("fact", RESTATE_TEXT, {
      source: "wearable:limitless",
    });
    await storage.writeMemory("fact", CONTRADICT_TEXT, {
      source: "extraction",
    });
    const config = parseConfig({
      memoryDir: dir,
      seedGraduation: { enabled: true, minCorroborations: 1 },
    });
    const memories = await storage.readAllMemories();
    await new LifecyclePolicyCoordinator(coordinatorDeps(storage, config)).runLifecyclePolicyPass(
      memories,
      storage,
    );
    const seed = (await storage.readAllMemories()).find(
      (memory) => memory.frontmatter.source === "wearable:bee",
    );
    assert.equal(seed?.frontmatter.status, "pending_review", "contradiction holds the seed");
    assert.equal(seed?.frontmatter.structuredAttributes?.graduatedBy, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
