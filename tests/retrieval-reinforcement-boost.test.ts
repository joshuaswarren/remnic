/**
 * Tests for reinforcement recall boost (issue #687 PR 3/4).
 *
 * Covers:
 *   - Boost applied when feature is on and memory has reinforcement_count
 *   - No boost when feature flag is off (default)
 *   - Boost capped at reinforcementRecallBoostMax
 *   - Boost surfaced in X-ray scoreDecomposition.reinforcementBoost
 *   - Config parsing: defaults, clamping, invalid-value rejection
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { Orchestrator } from "@remnic/core/orchestrator";
import { parseConfig } from "@remnic/core/config";
import {
  buildXraySnapshot,
  type RecallXrayResult,
} from "@remnic/core/recall-xray";
import { SecureStoreLockedError } from "@remnic/core/secure-store/index";

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTmpDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function namespaceIdentityToken(namespace: string): string {
  const bytes = new TextEncoder().encode(namespace.trim());
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ns-${hex || "default"}`;
}

async function makeOrchestrator(
  memoryDir: string,
  overrides: Record<string, unknown> = {},
): Promise<Orchestrator> {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    qmdEnabled: false,
    embeddingFallbackEnabled: false,
    transcriptEnabled: false,
    hourlySummariesEnabled: false,
    knowledgeIndexEnabled: false,
    compoundingInjectEnabled: false,
    memoryBoxesEnabled: false,
    temporalMemoryTreeEnabled: false,
    injectQuestions: false,
    // Disable recency/access/importance boosts so score arithmetic is deterministic
    // and tests can assert exact score values.
    recencyWeight: 0,
    boostAccessCount: false,
    feedbackEnabled: false,
    negativeExamplesEnabled: false,
    intentRoutingEnabled: false,
    queryAwareIndexingEnabled: false,
    lifecyclePolicyEnabled: false,
    ...overrides,
  });
  return new Orchestrator(config);
}

/** Write a minimal memory markdown file with frontmatter. */
async function writeMemory(
  dir: string,
  id: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const fm: Record<string, unknown> = {
    id,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    category: "fact",
    status: "active",
    ...extra,
  };
  // Use bare unquoted YAML scalars so the parser returns the correct JS types.
  // Quoting a string in YAML keeps the quotes as part of the value, which makes
  // Date parsing produce NaN for timestamp fields.
  const yamlLines = Object.entries(fm).map(([k, v]) => {
    if (typeof v === "string") return `${k}: ${v}`;
    return `${k}: ${JSON.stringify(v)}`;
  });
  const content = `---\n${yamlLines.join("\n")}\n---\n\ntest memory ${id}\n`;
  const filePath = path.join(dir, `${id}.md`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

// ─── Config parsing ───────────────────────────────────────────────────────────

test("reinforcementRecallBoostEnabled defaults to false", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostEnabled, false);
});

test("reinforcementRecallBoostWeight defaults to 0.05", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0.05);
});

test("reinforcementRecallBoostMax defaults to 0.3", () => {
  const config = parseConfig({ openaiApiKey: "sk-test" });
  assert.strictEqual(config.reinforcementRecallBoostMax, 0.3);
});

test("reinforcementRecallBoostEnabled coerces string 'true'", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostEnabled: "true",
  });
  assert.strictEqual(config.reinforcementRecallBoostEnabled, true);
});

test("reinforcementRecallBoostWeight accepts valid [0,1] value", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostWeight: 0.1,
  });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0.1);
});

test("reinforcementRecallBoostWeight accepts 0 (disable scaling)", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostWeight: 0,
  });
  assert.strictEqual(config.reinforcementRecallBoostWeight, 0);
});

test("reinforcementRecallBoostMax accepts valid [0,1] value", () => {
  const config = parseConfig({
    openaiApiKey: "sk-test",
    reinforcementRecallBoostMax: 0.5,
  });
  assert.strictEqual(config.reinforcementRecallBoostMax, 0.5);
});

test("reinforcementRecallBoostWeight rejects out-of-range value", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        reinforcementRecallBoostWeight: 1.5,
      }),
    /reinforcementRecallBoostWeight/,
  );
});

test("reinforcementRecallBoostMax rejects negative value", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        reinforcementRecallBoostMax: -0.1,
      }),
    /reinforcementRecallBoostMax/,
  );
});

// ─── boostSearchResults unit-level tests ─────────────────────────────────────

test("no boost when reinforcementRecallBoostEnabled is false (default)", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-off-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-001", {
    reinforcement_count: 5,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: false,
  });
  (orchestrator as any).initPromise = null;

  // Access the private method directly for unit testing.
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-001",
        path: path.join(memoryDir, "facts", "fact-001.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("boost applied when feature on and memory has reinforcement_count", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-on-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-002", {
    reinforcement_count: 3,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-002",
        path: path.join(memoryDir, "facts", "fact-002.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // Expected boost = min(3 * 0.1, 1.0) = 0.3
  assert.ok(
    Math.abs(result[0].score - 0.8) < 1e-9,
    `expected score ≈ 0.8 but got ${result[0].score}`,
  );
  assert.ok(
    Math.abs((result[0].explain?.reinforcementBoost ?? 0) - 0.3) < 1e-9,
    `expected reinforcementBoost ≈ 0.3 but got ${result[0].explain?.reinforcementBoost}`,
  );
});

test("boost resolves QMD collection-prefixed namespace result paths", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-ns-");
  const namespace = "team";
  const namespaceDir = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(namespace),
  );
  const dayDir = path.join(namespaceDir, "facts", "2026-06-16");
  await mkdir(dayDir, { recursive: true });
  await writeMemory(dayDir, "fact-ns-001", {
    reinforcement_count: 2,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: namespace,
        readPrincipals: ["reader"],
        writePrincipals: ["writer"],
      },
    ],
    qmdCollection: "openclaw-engram",
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const collection = `openclaw-engram--${namespaceIdentityToken(namespace)}`;
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-ns-001",
        path: `${collection}/2026-06-16/fact-ns-001.md`,
        snippet: "test",
        score: 0.5,
      },
    ],
    ["default", namespace],
  );

  assert.equal(result.length, 1);
  assert.ok(
    Math.abs(result[0].score - 0.7) < 1e-9,
    `expected score ≈ 0.7 but got ${result[0].score}`,
  );
  assert.ok(
    Math.abs((result[0].explain?.reinforcementBoost ?? 0) - 0.2) < 1e-9,
    `expected reinforcementBoost ≈ 0.2 but got ${result[0].explain?.reinforcementBoost}`,
  );
});

test("namespace detection decodes QMD collection-prefixed result paths", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-ns-detect-");
  const namespace = "team";
  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: namespace,
        readPrincipals: ["reader"],
        writePrincipals: ["writer"],
      },
    ],
    qmdCollection: "openclaw-engram",
  });

  const collection = `openclaw-engram--${namespaceIdentityToken(namespace)}`;

  assert.equal(
    (orchestrator as any).namespaceFromPath(
      `${collection}/2026-06-16/fact-ns-001.md`,
    ),
    namespace,
  );
});

test("namespace collection misses do not fall back to default storage", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-ns-miss-");
  const namespace = "team";
  const defaultDayDir = path.join(memoryDir, "facts", "2026-06-16");
  await mkdir(defaultDayDir, { recursive: true });
  await writeMemory(defaultDayDir, "fact-ns-001", {
    reinforcement_count: 9,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: namespace,
        readPrincipals: ["reader"],
        writePrincipals: ["writer"],
      },
    ],
    qmdCollection: "openclaw-engram",
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const collection = `openclaw-engram--${namespaceIdentityToken(namespace)}`;
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-ns-001",
        path: `${collection}/2026-06-16/fact-ns-001.md`,
        snippet: "stale namespace hit",
        score: 0.5,
      },
    ],
    ["default", namespace],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("invalid QMD collection prefixes do not strip into default storage", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-invalid-prefix-");
  const defaultDayDir = path.join(memoryDir, "facts", "2026-06-16");
  await mkdir(defaultDayDir, { recursive: true });
  await writeMemory(defaultDayDir, "fact-invalid-prefix", {
    reinforcement_count: 9,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    qmdCollection: "openclaw-engram",
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-invalid-prefix",
        path: "openclaw-engram--not-a-token/2026-06-16/fact-invalid-prefix.md",
        snippet: "invalid collection prefix",
        score: 0.5,
      },
    ],
    ["default"],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("namespace collection traversal paths do not escape storage root", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-traversal-");
  const namespace = "team";
  const defaultDayDir = path.join(memoryDir, "facts", "2026-06-16");
  await mkdir(defaultDayDir, { recursive: true });
  await writeMemory(defaultDayDir, "fact-traversal", {
    reinforcement_count: 9,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [
      {
        name: namespace,
        readPrincipals: ["reader"],
        writePrincipals: ["writer"],
      },
    ],
    qmdCollection: "openclaw-engram",
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const collection = `openclaw-engram--${namespaceIdentityToken(namespace)}`;
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-traversal",
        path: `${collection}/../../facts/2026-06-16/fact-traversal.md`,
        snippet: "traversal hit",
        score: 0.5,
      },
    ],
    ["default", namespace],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("date-relative QMD misses do not fall back to storage root basename", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-qmd-date-miss-");
  await writeMemory(memoryDir, "fact-001", {
    reinforcement_count: 9,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 1.0,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-001",
        path: "2026-06-16/fact-001.md",
        snippet: "missing dated hit",
        score: 0.5,
      },
    ],
    ["default"],
  );

  assert.equal(result.length, 1);
  assert.strictEqual(result[0].score, 0.5);
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

test("recall safety filtering is available without running score boosts", async () => {
  const memoryDir = await makeTmpDir("engram-recall-safety-filter-");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const active = await writeMemory(factsDir, "fact-active");
  const forgotten = await writeMemory(factsDir, "fact-forgotten", {
    status: "forgotten",
  });
  const superseded = await writeMemory(factsDir, "fact-superseded", {
    status: "superseded",
  });
  const dream = await writeMemory(factsDir, "fact-dream", {
    memoryKind: "dream",
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    temporalSupersessionEnabled: true,
    temporalSupersessionIncludeInRecall: false,
  });
  (orchestrator as any).initPromise = null;

  const filtered = await (orchestrator as any).filterSearchResultsForRecall(
    [
      { docid: "active", path: active, snippet: "active", score: 0.4 },
      { docid: "forgotten", path: forgotten, snippet: "forgotten", score: 0.9 },
      { docid: "superseded", path: superseded, snippet: "superseded", score: 0.8 },
      { docid: "dream", path: dream, snippet: "dream", score: 0.7 },
    ],
    undefined,
    { dropUnresolved: true },
  );

  assert.deepEqual(
    filtered.results.map((result: { path: string }) => path.basename(result.path)),
    ["fact-active.md"],
  );
});

test("absolute QMD result paths read through dynamic namespace owner storage", async () => {
  const memoryDir = await makeTmpDir("engram-recall-absolute-dynamic-ns-");
  const dynamicNamespace = "team-project-alpha";
  const dynamicFactsDir = path.join(
    memoryDir,
    "namespaces",
    namespaceIdentityToken(dynamicNamespace),
    "facts",
  );
  await mkdir(dynamicFactsDir, { recursive: true });
  const ownedPath = await writeMemory(dynamicFactsDir, "fact-owned");

  const orchestrator = await makeOrchestrator(memoryDir, {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  });
  (orchestrator as any).initPromise = null;

  const fallbackStorage = await (orchestrator as any).storageRouter.storageFor(
    "default",
  );
  let fallbackReads = 0;
  fallbackStorage.readMemoryByPath = async () => {
    fallbackReads += 1;
    return null;
  };

  const memory = await (orchestrator as any).readQmdResultMemory(
    ownedPath,
    fallbackStorage,
  );

  assert.equal(fallbackReads, 0);
  assert.equal(memory?.path, ownedPath);
  assert.equal(memory?.frontmatter.id, "fact-owned");
});

test("recall safety filtering drops QMD paths that fail resolution", async () => {
  const memoryDir = await makeTmpDir("engram-recall-safety-unresolved-qmd-");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const active = await writeMemory(factsDir, "fact-active");

  const orchestrator = await makeOrchestrator(memoryDir);
  (orchestrator as any).initPromise = null;
  const qmdCollection = (orchestrator as any).config.qmdCollection;

  const filtered = await (orchestrator as any).filterSearchResultsForRecall(
    [
      { docid: "active", path: active, snippet: "active", score: 0.4 },
      {
        docid: "escape",
        path: `${qmdCollection}/../other/fact.md`,
        snippet: "unchecked traversal hit",
        score: 0.9,
      },
    ],
    undefined,
    { dropUnresolved: true },
  );

  assert.deepEqual(
    filtered.results.map((result: { path: string }) => path.basename(result.path)),
    ["fact-active.md"],
  );
});

test("recall safety filtering does not return unchecked results after deadline", async () => {
  const memoryDir = await makeTmpDir("engram-recall-safety-deadline-");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const active = await writeMemory(factsDir, "fact-active");

  const orchestrator = await makeOrchestrator(memoryDir);
  (orchestrator as any).initPromise = null;
  let readAttempts = 0;
  (orchestrator as any).readQmdResultMemory = async () => {
    readAttempts += 1;
    return null;
  };

  const filtered = await (orchestrator as any).filterSearchResultsForRecall(
    [{ docid: "active", path: active, snippet: "active", score: 0.4 }],
    undefined,
    { deadlineAtMs: Date.now() - 1 },
  );

  assert.equal(readAttempts, 0);
  assert.deepEqual(filtered.results, []);
});

test("recall safety filtering keeps checked candidates when deadline expires mid-scan", async () => {
  const memoryDir = await makeTmpDir("engram-recall-safety-partial-deadline-");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const active = await writeMemory(factsDir, "fact-active");
  const unchecked = await writeMemory(factsDir, "fact-unchecked");

  const orchestrator = await makeOrchestrator(memoryDir);
  (orchestrator as any).initPromise = null;

  const realDateNow = Date.now;
  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    return nowCalls === 1 ? 1_000 : 2_000;
  };

  try {
    const filtered = await (orchestrator as any).filterSearchResultsForRecall(
      [
        { docid: "active", path: active, snippet: "active", score: 0.4 },
        { docid: "unchecked", path: unchecked, snippet: "unchecked", score: 0.9 },
      ],
      undefined,
      { deadlineAtMs: 1_500 },
    );

    assert.deepEqual(
      filtered.results.map((result: { path: string }) => path.basename(result.path)),
      ["fact-active.md"],
    );
  } finally {
    Date.now = realDateNow;
  }
});

test("recall safety filtering drops locked secure-store candidates", async () => {
  const memoryDir = await makeTmpDir("engram-recall-safety-secure-lock-");
  const factsDir = path.join(memoryDir, "facts");
  await mkdir(factsDir, { recursive: true });
  const locked = await writeMemory(factsDir, "fact-locked");

  const orchestrator = await makeOrchestrator(memoryDir);
  (orchestrator as any).initPromise = null;
  let readAttempts = 0;
  (orchestrator as any).readQmdResultMemory = async () => {
    readAttempts += 1;
    throw new SecureStoreLockedError("locked namespace store");
  };

  const filtered = await (orchestrator as any).filterSearchResultsForRecall(
    [{ docid: "locked", path: locked, snippet: "locked candidate", score: 0.9 }],
    undefined,
    {},
  );

  assert.equal(readAttempts, 1);
  assert.deepEqual(filtered.results, []);
});

test("boost capped at reinforcementRecallBoostMax", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-cap-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  await writeMemory(path.join(memoryDir, "facts"), "fact-003", {
    reinforcement_count: 100,
  });

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 0.25,
  });
  (orchestrator as any).initPromise = null;

  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-003",
        path: path.join(memoryDir, "facts", "fact-003.md"),
        snippet: "test",
        score: 0.5,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // Uncapped would be 100 * 0.1 = 10.0 but max is 0.25.
  // Expected score = 0.5 + 0.25 = 0.75.
  assert.ok(
    Math.abs(result[0].score - 0.75) < 1e-9,
    `expected score ≈ 0.75 but got ${result[0].score}`,
  );
  assert.ok(
    Math.abs((result[0].explain?.reinforcementBoost ?? 0) - 0.25) < 1e-9,
    `expected reinforcementBoost ≈ 0.25 but got ${result[0].explain?.reinforcementBoost}`,
  );
});

test("no boost for memory without reinforcement_count", async () => {
  const memoryDir = await makeTmpDir("engram-reinforce-no-count-");
  await mkdir(path.join(memoryDir, "facts"), { recursive: true });
  // No reinforcement_count field
  await writeMemory(path.join(memoryDir, "facts"), "fact-004", {});

  const orchestrator = await makeOrchestrator(memoryDir, {
    reinforcementRecallBoostEnabled: true,
    reinforcementRecallBoostWeight: 0.1,
    reinforcementRecallBoostMax: 0.3,
  });
  (orchestrator as any).initPromise = null;

  const baseScore = 0.6;
  const result = await (orchestrator as any).boostSearchResults(
    [
      {
        docid: "fact-004",
        path: path.join(memoryDir, "facts", "fact-004.md"),
        snippet: "test",
        score: baseScore,
      },
    ],
    ["global"],
  );

  assert.equal(result.length, 1);
  // No reinforcement boost; score may differ only due to recency/lifecycle adjustments.
  // The key assertion: reinforcementBoost is undefined on explain.
  assert.strictEqual(result[0].explain?.reinforcementBoost, undefined);
});

// ─── X-ray surface ────────────────────────────────────────────────────────────

test("X-ray scoreDecomposition carries reinforcementBoost when boost applied", () => {
  // This tests the pure RecallXrayResult / buildXraySnapshot path directly —
  // the orchestrator plumbing is integration-tested in recall-xray-capture.test.ts.
  const result: RecallXrayResult = {
    memoryId: "fact-005",
    path: "/memories/fact-005.md",
    servedBy: "hybrid",
    scoreDecomposition: {
      final: 0.75,
      reinforcementBoost: 0.25,
    },
    admittedBy: ["namespace-scope", "status-active"],
  };

  const snapshot = buildXraySnapshot({
    query: "test query",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id",
  });

  assert.equal(snapshot.results.length, 1);
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    0.25,
  );
  assert.strictEqual(snapshot.results[0].scoreDecomposition.final, 0.75);
});

test("X-ray scoreDecomposition omits reinforcementBoost when zero or absent", () => {
  const result: RecallXrayResult = {
    memoryId: "fact-006",
    path: "/memories/fact-006.md",
    servedBy: "hybrid",
    scoreDecomposition: {
      final: 0.6,
    },
    admittedBy: ["namespace-scope"],
  };

  const snapshot = buildXraySnapshot({
    query: "test query",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id-2",
  });

  assert.equal(snapshot.results.length, 1);
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    undefined,
  );
});

test("cloneResult in buildXraySnapshot drops reinforcementBoost=0", () => {
  const result: RecallXrayResult = {
    memoryId: "fact-007",
    path: "/memories/fact-007.md",
    servedBy: "direct-answer",
    scoreDecomposition: {
      final: 0.9,
      reinforcementBoost: 0, // zero should be dropped
    },
    admittedBy: [],
  };

  const snapshot = buildXraySnapshot({
    query: "test",
    results: [result],
    now: () => 1_700_000_000_000,
    snapshotIdGenerator: () => "test-snap-id-3",
  });

  assert.equal(snapshot.results.length, 1);
  // Zero boost must not appear in the snapshot.
  assert.strictEqual(
    snapshot.results[0].scoreDecomposition.reinforcementBoost,
    undefined,
  );
});
