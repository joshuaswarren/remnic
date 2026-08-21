import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { graphFilePath, GraphIndex, type GraphConfig } from "../graph.js";
import {
  blendGraphExpandedRecallScore,
  GraphRecallCoordinator,
} from "./graph-recall-coordinator.js";
import type { PluginConfig, QmdSearchResult } from "../types.js";
import { StorageManager } from "../storage.js";

const AS_OF = "2026-01-01T00:00:00.000Z";
const HISTORICAL_VALID_AT = "2025-01-01T00:00:00.000Z";

type NamespaceFixture = {
  name: string;
  dir: string;
  storage: StorageManager;
  seedPath: string;
  intermediatePath: string;
  cleanPath: string;
  secondCleanPath?: string;
  stalePath: string;
};

function makeConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return parseConfig({
    openaiApiKey: "test-key",
    graphRecallEnabled: true,
    multiGraphMemoryEnabled: true,
    maxGraphTraversalSteps: 2,
    graphTraversalPageRankIterations: 0,
    graphPathScoring: {
      enabled: true,
      invalidNodePenalty: 0.2,
      includePathInProvenance: true,
    },
    ...overrides,
  });
}

async function appendEdge(
  dir: string,
  from: string,
  to: string,
  weight = 1,
): Promise<void> {
  const file = graphFilePath(dir, "entity");
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(
    file,
    `${JSON.stringify({
      from,
      to,
      type: "entity",
      weight,
      label: "test",
      ts: AS_OF,
    })}\n`,
    "utf8",
  );
}

async function createNamespace(
  root: string,
  name: string,
  intermediateStatus: "active" | "superseded" = "active",
  includeSecondClean = false,
): Promise<NamespaceFixture> {
  const dir = path.join(root, name);
  const storage = new StorageManager(dir);
  await storage.ensureDirectories();
  await storage.writeMemory("fact", `${name} seed`, {
    source: "test",
    validAt: HISTORICAL_VALID_AT,
  });
  await storage.writeMemory("fact", `${name} intermediate`, {
    source: "test",
    status: intermediateStatus,
    validAt:
      intermediateStatus === "superseded"
        ? "2026-02-01T00:00:00.000Z"
        : HISTORICAL_VALID_AT,
  });
  await storage.writeMemory("fact", `${name} clean`, {
    source: "test",
    validAt: HISTORICAL_VALID_AT,
  });
  if (includeSecondClean) {
    await storage.writeMemory("fact", `${name} second clean`, {
      source: "test",
      validAt: HISTORICAL_VALID_AT,
    });
  }
  await storage.writeMemory("fact", `${name} stale`, {
    source: "test",
    validAt: HISTORICAL_VALID_AT,
  });
  const paths = await storage.collectActiveMemoryPaths();
  const memories = await storage.readAllMemories();
  const find = (text: string): string => {
    const memory = memories.find((item) => item.content.includes(text));
    assert.ok(memory, `missing ${text}`);
    return path.relative(dir, memory.path).split(path.sep).join("/");
  };
  const seedPath = find(`${name} seed`);
  const intermediatePath = find(`${name} intermediate`);
  const cleanPath = find(`${name} clean`);
  const secondCleanPath = includeSecondClean ? find(`${name} second clean`) : undefined;
  const stalePath = find(`${name} stale`);
  await appendEdge(dir, seedPath, cleanPath, 1);
  if (secondCleanPath) await appendEdge(dir, seedPath, secondCleanPath, 0.95);
  await appendEdge(dir, seedPath, intermediatePath, 0.9);
  await appendEdge(dir, intermediatePath, stalePath, 1);
  assert.equal(paths.length, includeSecondClean ? 5 : 4);
  return { name, dir, storage, seedPath, intermediatePath, cleanPath, secondCleanPath, stalePath };
}

function makeCoordinator(
  config: PluginConfig,
  fixtures: Map<string, NamespaceFixture>,
  readAllMemoriesCalls?: { count: number },
  graphIndexes?: Map<string, GraphIndex>,
): GraphRecallCoordinator {
  const indexes = new Map<string, GraphIndex>();
  for (const fixture of fixtures.values()) {
    indexes.set(
      fixture.dir,
      graphIndexes?.get(fixture.dir) ??
        new GraphIndex(fixture.dir, config as unknown as GraphConfig),
    );
    if (readAllMemoriesCalls) {
      const originalHot = fixture.storage.readAllMemories.bind(fixture.storage);
      fixture.storage.readAllMemories = async (...args: Parameters<StorageManager["readAllMemories"]>) => {
        readAllMemoriesCalls.count += 1;
        return originalHot(...args);
      };
      const originalCold = fixture.storage.readAllColdMemories.bind(fixture.storage);
      fixture.storage.readAllColdMemories = async () => {
        readAllMemoriesCalls.count += 1;
        return originalCold();
      };
      const originalArchived = fixture.storage.readArchivedMemories.bind(fixture.storage);
      fixture.storage.readArchivedMemories = async () => {
        readAllMemoriesCalls.count += 1;
        return originalArchived();
      };
    }
  }
  const defaultFixture = fixtures.values().next().value as NamespaceFixture;
  return new GraphRecallCoordinator({
    getConfig: () => config,
    getStorage: () => defaultFixture.storage,
    storageFor: async (namespace) => {
      const fixture = fixtures.get(namespace);
      assert(fixture, `missing namespace fixture: ${namespace}`);
      return fixture.storage;
    },
    graphIndexFor: (storage) => {
      const index = indexes.get(storage.dir);
      assert(index, `missing graph index: ${storage.dir}`);
      return index;
    },
    namespaceFromPath: () => defaultFixture.name,
    resolveColdQmdResultForRecall: async () => null,
    storageForAbsoluteQmdResultPath: async (resultPath) => {
      for (const fixture of fixtures.values()) {
        if (resultPath.startsWith(`${fixture.dir}${path.sep}`)) {
          return { storage: fixture.storage, dir: fixture.dir, namespace: fixture.name };
        }
      }
      return null;
    },
    readQmdResultMemory: async (resultPath, storage) =>
      storage.readMemoryByPath(resultPath),
  });
}

function seedResult(fixture: NamespaceFixture): QmdSearchResult {
  return {
    docid: fixture.seedPath,
    path: path.join(fixture.dir, fixture.seedPath),
    snippet: "seed",
    score: 0.5,
    namespace: fixture.name,
  };
}
async function expand(
  coordinator: GraphRecallCoordinator,
  results: QmdSearchResult[],
  namespaces: string[],
  recallResultLimit = 1,
) {
  return coordinator.expandResultsViaGraph({
    memoryResults: results,
    recallNamespaces: namespaces,
    recallResultLimit,
    asOf: AS_OF,
  });
}

async function createHistoricalCapCandidates(
  fixture: NamespaceFixture,
  futureCount = 45,
): Promise<{ candidatePaths: string[]; validPath: string }> {
  await Promise.all(
    Array.from({ length: futureCount + 1 }, (_, index) =>
      fixture.storage.writeMemory("fact", `historical scan candidate ${index}`, {
        source: "test",
      }),
    ),
  );
  const memories = (await fixture.storage.readAllMemories()).filter((memory) =>
    memory.content.startsWith("historical scan candidate "),
  );
  assert.equal(memories.length, futureCount + 1);
  const candidatePaths: string[] = [];
  for (let index = 0; index <= futureCount; index += 1) {
    const memory = memories.find(
      (candidate) => candidate.content === `historical scan candidate ${index}`,
    );
    assert.ok(memory);
    candidatePaths.push(path.relative(fixture.dir, memory.path).split(path.sep).join("/"));
    assert.equal(
      await fixture.storage.writeMemoryFrontmatter(memory, {
        status: "active",
        valid_at: index === futureCount ? HISTORICAL_VALID_AT : "2026-02-01T00:00:00.000Z",
      }),
      true,
    );
  }
  const validPath = candidatePaths[futureCount];
  assert.ok(validPath);
  return { candidatePaths, validPath };
}

function makeHistoricalCapGraphIndex(
  fixture: NamespaceFixture,
  candidatePaths: string[],
): GraphIndex {
  return {
    spreadingActivation: async () =>
      candidatePaths.map((candidatePath, index) => ({
        path: candidatePath,
        score: 1 - index / 1000,
        seed: fixture.seedPath,
        hopDepth: 1,
        decayedWeight: 1,
        graphType: "entity" as const,
        edgeConfidence: 1,
        activationPath: {
          nodeIds: [fixture.seedPath, candidatePath],
          edgeConfidences: [1],
          graphTypes: ["entity"],
        },
      })),
  } as unknown as GraphIndex;
}

test("real coordinator demotes stale paths before the namespace cap and repeats deterministically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-coordinator-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded", true);
    const cleanFixture = await createNamespace(root, "clean", "active");
    const fixtures = new Map([[fixture.name, fixture], [cleanFixture.name, cleanFixture]]);
    const coordinator = makeCoordinator(makeConfig(), fixtures);
    const first = await expand(coordinator, [seedResult(fixture)], [fixture.name]);
    const second = await expand(coordinator, [seedResult(fixture)], [fixture.name]);
    assert.equal(first.merged.length, 4);
    assert.equal(first.expandedPaths.length, 3);
    assert.equal(first.expandedPaths[0]?.path.endsWith(fixture.cleanPath), true);
    assert.equal(first.expandedPaths[1]?.path.endsWith(fixture.secondCleanPath ?? ""), true);
    assert.equal(first.expandedPaths[2]?.path.endsWith(fixture.stalePath), true);
    assert.equal(first.expandedPaths.slice(0, 2).some((entry) => entry.path.endsWith(fixture.stalePath)), false);
    assert.deepEqual(first.merged, second.merged);
    assert.deepEqual(first.expandedPaths, second.expandedPaths);
    const capped = await expand(
      coordinator,
      [seedResult(fixture), seedResult(cleanFixture)],
      [fixture.name, cleanFixture.name],
    );
    assert.ok(capped.merged.some((item) => item.namespace === cleanFixture.name));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("retains a superseded graph candidate at its historical asOf but not now", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-historical-candidate-"));
  try {
    const fixture = await createNamespace(root, "default");
    const candidate = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.cleanPath),
    );
    assert.ok(candidate);
    assert.equal(
      await fixture.storage.writeMemoryFrontmatter(candidate, {
        status: "superseded",
        valid_at: "2025-01-01T00:00:00.000Z",
        invalid_at: "2026-06-01T00:00:00.000Z",
      }),
      true,
    );

    const fixtures = new Map([[fixture.name, fixture]]);
    const coordinator = makeCoordinator(makeConfig(), fixtures);
    const historical = await expand(coordinator, [seedResult(fixture)], [fixture.name]);
    const current = await coordinator.expandResultsViaGraph({
      memoryResults: [seedResult(fixture)],
      recallNamespaces: [fixture.name],
      recallResultLimit: 1,
    });

    assert.equal(
      historical.expandedPaths.some((entry) => entry.path.endsWith(fixture.cleanPath)),
      true,
    );
    assert.equal(
      current.expandedPaths.some((entry) => entry.path.endsWith(fixture.cleanPath)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fills the current-time graph cap after rejecting expired candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-current-cap-"));
  try {
    const fixture = await createNamespace(root, "default");
    const expired = [];
    for (let index = 0; index < 8; index += 1) {
      await fixture.storage.writeMemory("fact", `expired graph candidate ${index}`, {
        source: "test",
      });
    }
    const memories = (await fixture.storage.readAllMemories()).filter((memory) =>
      memory.content.startsWith("expired graph candidate "),
    );
    assert.equal(memories.length, 8);
    for (const memory of memories) {
      const relativePath = path.relative(fixture.dir, memory.path).split(path.sep).join("/");
      expired.push(relativePath);
      assert.equal(
        await fixture.storage.writeMemoryFrontmatter(memory, {
          status: "active",
          invalid_at: "2000-01-01T00:00:00.000Z",
        }),
        true,
      );
    }
    const candidates = [
      ...expired.map((candidatePath, index) => ({
        path: candidatePath,
        score: 1 - index / 1000,
      })),
      {
        path: fixture.cleanPath,
        score: 0.5,
      },
    ];
    const fakeIndex = {
      spreadingActivation: async () =>
        candidates.map((candidate) => ({
          ...candidate,
          seed: fixture.seedPath,
          hopDepth: 1,
          decayedWeight: candidate.score,
          graphType: "entity" as const,
          edgeConfidence: 1,
          activationPath: {
            nodeIds: [fixture.seedPath, candidate.path],
            edgeConfidences: [1],
            graphTypes: ["entity"],
          },
        })),
    } as unknown as GraphIndex;
    const coordinator = makeCoordinator(
      makeConfig({
        temporalBiTemporal: true,
        temporalExpiredInInjection: false,
      }),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );
    const result = await coordinator.expandResultsViaGraph({
      memoryResults: [seedResult(fixture)],
      recallNamespaces: [fixture.name],
      recallResultLimit: 1,
    });

    assert.deepEqual(
      result.expandedPaths.map((entry) => entry.path),
      [path.join(fixture.dir, fixture.cleanPath)],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("excludes an archived graph candidate from historical expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-historical-archived-"));
  try {
    const fixture = await createNamespace(root, "default");
    const candidate = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.cleanPath),
    );
    assert.ok(candidate);
    assert.equal(
      await fixture.storage.writeMemoryFrontmatter(candidate, {
        status: "archived",
        valid_at: "2025-01-01T00:00:00.000Z",
        invalid_at: "2026-06-01T00:00:00.000Z",
      }),
      true,
    );

    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );

    assert.equal(
      result.expandedPaths.some((entry) => entry.path.endsWith(fixture.cleanPath)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loads valid_at onto active intermediate path state before historical scoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-valid-at-"));
  try {
    const fixture = await createNamespace(root, "default");
    const intermediate = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.intermediatePath),
    );
    assert.ok(intermediate);
    assert.equal(
      await fixture.storage.writeMemoryFrontmatter(intermediate, {
        valid_at: "2025-01-01T00:00:00.000Z",
      }),
      true,
    );

    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );
    const stale = result.expandedPaths.find((entry) => entry.path.endsWith(fixture.stalePath));
    assert.ok(stale);
    assert.equal(stale.pathPenaltyApplied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains an active cold candidate in disabled and enabled graph scoring modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-cold-candidate-"));
  try {
    const fixture = await createNamespace(root, "default");
    const cleanMemory = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.cleanPath),
    );
    assert.ok(cleanMemory);
    const moved = await fixture.storage.migrateMemoryToTier(cleanMemory, "cold");
    assert.equal(moved.changed, true);
    const coldPath = path.relative(fixture.dir, moved.targetPath).split(path.sep).join("/");
    await appendEdge(fixture.dir, fixture.seedPath, coldPath, 1);

    const fixtures = new Map([[fixture.name, fixture]]);
    const disabledReads = { count: 0 };
    const disabled = await expand(
      makeCoordinator(makeConfig({ graphPathScoring: { enabled: false } }), fixtures, disabledReads),
      [seedResult(fixture)],
      [fixture.name],
    );
    assert.equal(disabledReads.count, 0);

    const enabledReads = { count: 0 };
    const enabled = await expand(
      makeCoordinator(makeConfig(), fixtures, enabledReads),
      [seedResult(fixture)],
      [fixture.name],
    );
    assert.equal(enabledReads.count, 0);

    const disabledCandidate = disabled.merged.find((item) => item.path === moved.targetPath);
    const enabledCandidate = enabled.merged.find((item) => item.path === moved.targetPath);
    assert.ok(disabledCandidate);
    assert.ok(enabledCandidate);
    assert.equal(disabledCandidate.namespace, fixture.name);
    assert.equal(enabledCandidate.namespace, fixture.name);
    assert.deepEqual(
      {
        docid: enabledCandidate.docid,
        path: enabledCandidate.path,
        namespace: enabledCandidate.namespace,
        snippet: enabledCandidate.snippet,
      },
      {
        docid: disabledCandidate.docid,
        path: disabledCandidate.path,
        namespace: disabledCandidate.namespace,
        snippet: disabledCandidate.snippet,
      },
    );
    assert.equal(enabledCandidate.score, disabledCandidate.score);
    assert.equal("pathPenaltyApplied" in disabledCandidate, false);
    assert.equal(enabledCandidate.pathPenaltyApplied, false);
    assert.deepEqual(enabledCandidate.pathNodeIds, [fixture.seedPath, coldPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real coordinator demotes a path through an archived intermediate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-archive-"));
  try {
    const fixture = await createNamespace(root, "default");
    const intermediate = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.intermediatePath),
    );
    assert.ok(intermediate);
    const intermediateId = intermediate.frontmatter.id;
    assert.ok(await fixture.storage.archiveMemory(intermediate));
    const archived = await fixture.storage.readArchivedMemories();
    const archivedIntermediate = archived.find((memory) => memory.frontmatter.id === intermediateId);
    assert.ok(archivedIntermediate);
    assert.equal(path.basename(archivedIntermediate.path, ".md"), intermediateId);
    const config = makeConfig();
    const coordinator = makeCoordinator(config, new Map([[fixture.name, fixture]]));
    const result = await expand(coordinator, [seedResult(fixture)], [fixture.name]);
    const stale = result.expandedPaths.find((entry) => entry.path.endsWith(fixture.stalePath));
    const clean = result.expandedPaths.find((entry) => entry.path.endsWith(fixture.cleanPath));
    assert.ok(clean);
    assert.ok(stale);
    assert.deepEqual(stale.pathNodeIds, [fixture.seedPath, fixture.intermediatePath, fixture.stalePath]);
    const activation = await new GraphIndex(
      fixture.dir,
      config as unknown as GraphConfig,
    ).spreadingActivation([fixture.seedPath], config.maxGraphTraversalSteps);
    const expectedScore = (candidatePath: string, penalty: number): number => {
      const candidate = activation.find((item) => item.path === candidatePath);
      assert.ok(candidate);
      return (
        blendGraphExpandedRecallScore({
          graphActivationScore: candidate.score,
          seedRecallScore: 0.5,
          activationWeight: config.graphExpansionActivationWeight,
          blendMin: config.graphExpansionBlendMin,
          blendMax: config.graphExpansionBlendMax,
        }) * penalty
      );
    };
    assert.equal(clean.score, expectedScore(fixture.cleanPath, 1));
    assert.equal(stale.score, expectedScore(fixture.stalePath, config.graphPathScoring.invalidNodePenalty));
    assert.equal(stale.pathPenaltyApplied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled boolean and parsed string false preserve output and skip corpus reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-disabled-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const fixtures = new Map([[fixture.name, fixture]]);
    const reads = { count: 0 };
    const falseConfig = makeConfig({ graphPathScoring: { enabled: false } });
    const stringConfig = makeConfig({ graphPathScoring: { enabled: "false" } });
    const oldActivation = await new GraphIndex(
      fixture.dir,
      falseConfig as unknown as GraphConfig,
    ).spreadingActivation([fixture.seedPath], falseConfig.maxGraphTraversalSteps);
    const expectedCandidate = oldActivation.find(
      (candidate) => candidate.path === fixture.cleanPath,
    );
    assert.ok(expectedCandidate);
    const expectedPath = path.join(fixture.dir, expectedCandidate.path);
    const expectedScore = blendGraphExpandedRecallScore({
      graphActivationScore: expectedCandidate.score,
      seedRecallScore: 0.5,
      activationWeight: falseConfig.graphExpansionActivationWeight,
      blendMin: falseConfig.graphExpansionBlendMin,
      blendMax: falseConfig.graphExpansionBlendMax,
    });
    const falseRun = await expand(makeCoordinator(falseConfig, fixtures, reads), [seedResult(fixture)], [fixture.name]);
    const stringRun = await expand(makeCoordinator(stringConfig, fixtures, reads), [seedResult(fixture)], [fixture.name]);
    const retained = falseRun.merged.find((item) => item.path === expectedPath);
    assert.ok(retained);
    assert.equal(retained.path, expectedPath);
    assert.equal(retained.score, expectedScore);
    assert.deepEqual(falseRun, stringRun);
    assert.equal(reads.count, 0);
    for (const item of [...falseRun.merged, ...falseRun.expandedPaths]) {
      assert.equal("pathNodeIds" in item, false);
      assert.equal("pathPenaltyApplied" in item, false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("disabled graph path scoring excludes activation results that match seeds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-seed-exclusion-"));
  try {
    const fixture = await createNamespace(root, "default");
    const fakeIndex = {
      spreadingActivation: async () => [
        {
          path: fixture.seedPath,
          score: 1,
          seed: fixture.seedPath,
          hopDepth: 0,
          decayedWeight: 1,
          graphType: "entity" as const,
          edgeConfidence: 1,
        },
        {
          path: fixture.cleanPath,
          score: 0.8,
          seed: fixture.seedPath,
          hopDepth: 1,
          decayedWeight: 1,
          graphType: "entity" as const,
          edgeConfidence: 1,
        },
      ],
    } as unknown as GraphIndex;
    const coordinator = makeCoordinator(
      makeConfig({ graphPathScoring: { enabled: false } }),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );

    const result = await expand(coordinator, [seedResult(fixture)], [fixture.name]);

    assert.deepEqual(
      result.expandedPaths.map((entry) => entry.path),
      [path.join(fixture.dir, fixture.cleanPath)],
    );
    assert.equal(
      result.merged.filter((item) => item.path.endsWith(fixture.seedPath)).length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing memory status defaults to active for path scoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-status-"));
  try {
    const fixture = await createNamespace(root, "default");
    const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      const memory = await originalReadMemoryByPath(filePath);
      if (!memory || !memory.path.endsWith(fixture.intermediatePath)) return memory;
      return {
        ...memory,
        frontmatter: {
          ...memory.frontmatter,
          status: undefined,
          invalid_at: AS_OF,
        },
      };
    };
    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );
    const stale = result.expandedPaths.find((entry) => entry.path.endsWith(fixture.stalePath));
    assert.equal(stale?.pathPenaltyApplied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("malformed intermediate status remains neutral for path scoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-malformed-status-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      const memory = await originalReadMemoryByPath(filePath);
      if (!memory || !memory.path.endsWith(fixture.intermediatePath)) return memory;
      return {
        ...memory,
        frontmatter: {
          ...memory.frontmatter,
          status: "malformed" as never,
          invalid_at: AS_OF,
        },
      };
    };
    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );
    const stale = result.expandedPaths.find((entry) => entry.path.endsWith(fixture.stalePath));
    assert.equal(stale?.pathPenaltyApplied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memoizes shared missing graph path state within one namespace expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-state-cache-"));
  try {
    const fixture = await createNamespace(root, "default");
    await fixture.storage.writeMemory("fact", "default cache first", {
      source: "test",
      validAt: HISTORICAL_VALID_AT,
    });
    await fixture.storage.writeMemory("fact", "default cache second", {
      source: "test",
      validAt: HISTORICAL_VALID_AT,
    });
    const memories = await fixture.storage.readAllMemories();
    const firstMemory = memories.find((memory) => memory.content === "default cache first");
    const secondMemory = memories.find((memory) => memory.content === "default cache second");
    assert.ok(firstMemory);
    assert.ok(secondMemory);
    const firstPath = path.relative(fixture.dir, firstMemory.path).split(path.sep).join("/");
    const secondPath = path.relative(fixture.dir, secondMemory.path).split(path.sep).join("/");
    const sharedMissingNode = "shared-missing-node";
    await appendEdge(fixture.dir, fixture.seedPath, sharedMissingNode);
    await appendEdge(fixture.dir, sharedMissingNode, firstPath);
    await appendEdge(fixture.dir, sharedMissingNode, secondPath);

    const missingPath = path.join(fixture.dir, sharedMissingNode);
    let missingReads = 0;
    const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      if (filePath === missingPath) missingReads += 1;
      return originalReadMemoryByPath(filePath);
    };
    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
      2,
    );
    assert.ok(result.expandedPaths.some((entry) => entry.path.endsWith(firstPath)));
    assert.ok(result.expandedPaths.some((entry) => entry.path.endsWith(secondPath)));
    assert.equal(missingReads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("provenance ids are optional while penalty boolean remains enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-provenance-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const fixtures = new Map([[fixture.name, fixture]]);
    const withIds = await expand(makeCoordinator(makeConfig(), fixtures), [seedResult(fixture)], [fixture.name]);
    const withoutIds = await expand(
      makeCoordinator(makeConfig({ graphPathScoring: { enabled: true, includePathInProvenance: false } }), fixtures),
      [seedResult(fixture)],
      [fixture.name],
    );
    const withStale = withIds.merged.find((item) => item.path.endsWith(fixture.stalePath));
    const withoutStale = withoutIds.merged.find((item) => item.path.endsWith(fixture.stalePath));
    assert.equal(withStale?.pathPenaltyApplied, true);
    assert.equal(withoutStale?.pathPenaltyApplied, true);
    assert.ok(withStale?.pathNodeIds);
    assert.equal("pathNodeIds" in (withoutStale ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("namespace corpus state stays isolated for equal intermediate ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-namespaces-"));
  try {
    const stale = await createNamespace(root, "stale", "superseded");
    const clean = await createNamespace(root, "clean", "active");
    const cleanIntermediate = (await clean.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(clean.intermediatePath),
    );
    assert.ok(cleanIntermediate);
    assert.equal(
      await clean.storage.writeMemoryFrontmatter(cleanIntermediate, {
        valid_at: "2025-01-01T00:00:00.000Z",
      }),
      true,
    );
    const fixtures = new Map([stale, clean].map((item) => [item.name, item]));
    const result = await expand(
      makeCoordinator(makeConfig(), fixtures),
      [seedResult(stale), seedResult(clean)],
      [stale.name, clean.name],
    );
    assert.equal(result.merged.find((item) => item.namespace === stale.name && item.path.endsWith(stale.stalePath))?.pathPenaltyApplied, true);
    assert.equal(result.merged.find((item) => item.namespace === clean.name && item.path.endsWith(clean.stalePath))?.pathPenaltyApplied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed and absent coordinator asOf use a finite current instant", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-asof-fallback-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const coordinator = makeCoordinator(
      makeConfig(),
      new Map([[fixture.name, fixture]]),
    );
    const common = {
      memoryResults: [seedResult(fixture)],
      recallNamespaces: [fixture.name],
      recallResultLimit: 1,
    };
    const malformed = await coordinator.expandResultsViaGraph({
      ...common,
      asOf: "not-a-date",
    });
    const absent = await coordinator.expandResultsViaGraph(common);
    const malformedStale = malformed.expandedPaths.find((entry) =>
      entry.path.endsWith(fixture.stalePath),
    );
    const absentStale = absent.expandedPaths.find((entry) =>
      entry.path.endsWith(fixture.stalePath),
    );
    assert.equal(malformedStale?.pathPenaltyApplied, true);
    assert.equal(absentStale?.pathPenaltyApplied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deadline stops remaining graph state reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-deadline-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const reads: string[] = [];
    const originalNow = Date.now;
    let now = 1_000;
    try {
      Date.now = () => now;
      const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
      fixture.storage.readMemoryByPath = async (filePath: string) => {
        reads.push(filePath);
        if (reads.length === 1) now += 200;
        return originalReadMemoryByPath(filePath);
      };
      const coordinator = makeCoordinator(
        makeConfig(),
        new Map([[fixture.name, fixture]]),
      );
      await coordinator.expandResultsViaGraph({
        memoryResults: [seedResult(fixture)],
        recallNamespaces: [fixture.name],
        recallResultLimit: 1,
        asOf: AS_OF,
        deadlineAtMs: now + 100,
      });
    } finally {
      Date.now = originalNow;
    }

    assert.equal(reads.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real coordinator demotes a path through a cold intermediate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-cold-intermediate-"));
  try {
    const fixture = await createNamespace(root, "default", "superseded");
    const intermediate = (await fixture.storage.readAllMemories()).find((memory) =>
      memory.path.endsWith(fixture.intermediatePath),
    );
    assert.ok(intermediate);
    const moved = await fixture.storage.migrateMemoryToTier(intermediate, "cold");
    assert.equal(moved.changed, true);
    const coordinator = makeCoordinator(
      makeConfig(),
      new Map([[fixture.name, fixture]]),
    );
    const result = await expand(
      coordinator,
      [seedResult(fixture)],
      [fixture.name],
    );
    const stale = result.expandedPaths.find((entry) =>
      entry.path.endsWith(fixture.stalePath),
    );
    assert.equal(stale?.pathPenaltyApplied, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects traversal graph nodes before reading outside storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-traversal-"));
  try {
    const fixture = await createNamespace(root, "default");
    const outsidePath = path.join(root, "outside.md");
    await writeFile(
      outsidePath,
      "---\nid: outside\ncategory: fact\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nsource: test\nconfidence: 0.9\nstatus: active\n---\n\noutside\n",
      "utf8",
    );
    await appendEdge(fixture.dir, fixture.seedPath, "../outside.md");
    const reads: string[] = [];
    const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      reads.push(filePath);
      return originalReadMemoryByPath(filePath);
    };
    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );
    assert.equal(result.expandedPaths.some((entry) => entry.path === outsidePath), false);
    assert.equal(reads.includes(outsidePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlink graph nodes before reading outside storage", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-symlink-"));
  try {
    const fixture = await createNamespace(root, "default");
    const outsidePath = path.join(root, "outside.md");
    await writeFile(
      outsidePath,
      "---\nid: outside\ncategory: fact\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\nsource: test\nconfidence: 0.9\nstatus: active\n---\n\noutside\n",
      "utf8",
    );
    const linkPath = path.join(fixture.dir, "linked.md");
    await symlink(outsidePath, linkPath);
    await appendEdge(fixture.dir, fixture.seedPath, "linked.md");
    const reads: string[] = [];
    const originalReadMemoryByPath = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      reads.push(filePath);
      return originalReadMemoryByPath(filePath);
    };
    const result = await expand(
      makeCoordinator(makeConfig(), new Map([[fixture.name, fixture]])),
      [seedResult(fixture)],
      [fixture.name],
    );
    assert.equal(reads.includes(linkPath), false);
    assert.equal(reads.includes(outsidePath), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters active candidates that start after historical asOf before the expansion cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-historical-cap-"));
  try {
    const fixture = await createNamespace(root, "default");
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        fixture.storage.writeMemory("fact", `historical cap candidate ${index}`, {
          source: "test",
        }),
      ),
    );
    const memories = (await fixture.storage.readAllMemories()).filter((memory) =>
      memory.content.startsWith("historical cap candidate "),
    );
    assert.equal(memories.length, 9);
    const candidatePaths: string[] = [];
    for (const memory of memories) {
      const relativePath = path.relative(fixture.dir, memory.path).split(path.sep).join("/");
      candidatePaths.push(relativePath);
      assert.equal(
        await fixture.storage.writeMemoryFrontmatter(memory, {
          status: "active",
          valid_at: "2025-01-01T00:00:00.000Z",
        }),
        true,
      );
    }
    const invalidPath = candidatePaths[0];
    assert.ok(invalidPath);
    const invalidMemory = memories[0];
    assert.ok(invalidMemory);
    assert.equal(
      await fixture.storage.writeMemoryFrontmatter(invalidMemory, {
        valid_at: "2026-02-01T00:00:00.000Z",
      }),
      true,
    );

    const fakeIndex = {
      spreadingActivation: async () =>
        candidatePaths.map((candidatePath, index) => ({
          path: candidatePath,
          score: 1 - index / 1000,
          seed: fixture.seedPath,
          hopDepth: 1,
          decayedWeight: 1,
          graphType: "entity" as const,
          edgeConfidence: 1,
          activationPath: {
            nodeIds: [fixture.seedPath, candidatePath],
            edgeConfidences: [1],
            graphTypes: ["entity"],
          },
        })),
    } as unknown as GraphIndex;
    const coordinator = makeCoordinator(
      makeConfig(),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );

    const result = await expand(coordinator, [seedResult(fixture)], [fixture.name], 1);

    assert.equal(result.expandedPaths.length, 8);
    assert.equal(
      result.expandedPaths.some((entry) => entry.path.endsWith(invalidPath)),
      false,
    );
    for (const candidatePath of candidatePaths.slice(1)) {
      assert.equal(
        result.expandedPaths.some((entry) => entry.path.endsWith(candidatePath)),
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scans the historical candidate window before the enabled expansion cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-historical-enabled-cap-"));
  try {
    const fixture = await createNamespace(root, "default");
    const { candidatePaths, validPath } = await createHistoricalCapCandidates(fixture);
    const fakeIndex = makeHistoricalCapGraphIndex(fixture, candidatePaths);
    const readCount = { count: 0 };
    const originalRead = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      readCount.count += 1;
      return originalRead(filePath);
    };
    const coordinator = makeCoordinator(
      makeConfig(),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );

    const result = await expand(coordinator, [seedResult(fixture)], [fixture.name], 1);

    assert.equal(result.expandedPaths.length, 1);
    assert.equal(result.expandedPaths[0]?.path.endsWith(validPath), true);
    assert.ok(readCount.count <= 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scans the historical candidate window before the disabled expansion cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-historical-disabled-cap-"));
  try {
    const fixture = await createNamespace(root, "default");
    const { candidatePaths, validPath } = await createHistoricalCapCandidates(fixture);
    const fakeIndex = makeHistoricalCapGraphIndex(fixture, candidatePaths);
    const readCount = { count: 0 };
    const originalRead = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      readCount.count += 1;
      return originalRead(filePath);
    };
    const coordinator = makeCoordinator(
      makeConfig({ graphPathScoring: { enabled: false } }),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );

    const result = await expand(coordinator, [seedResult(fixture)], [fixture.name], 1);

    assert.equal(result.expandedPaths.length, 1);
    assert.equal(result.expandedPaths[0]?.path.endsWith(validPath), true);
    assert.ok(readCount.count <= 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("caps graph path state reads at 200 candidates with deterministic output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-read-cap-"));
  try {
    const fixture = await createNamespace(root, "default", "active");
    for (let index = 0; index < 250; index += 1) {
      await fixture.storage.writeMemory("fact", `bounded-${index}`, {
        validAt: HISTORICAL_VALID_AT,
      });
    }
    const memories = (await fixture.storage.readAllMemories()).filter((memory) =>
      memory.content.startsWith("bounded-"),
    );
    assert.equal(memories.length, 250);
    const candidates = memories.map((memory, index) => {
      const relativePath = path.relative(fixture.dir, memory.path).split(path.sep).join("/");
      return {
        path: relativePath,
        score: 1 - index / 1000,
        seed: fixture.seedPath,
        hopDepth: 1,
        decayedWeight: 1,
        graphType: "entity" as const,
        edgeConfidence: 1,
        activationPath: {
          nodeIds: [fixture.seedPath, relativePath],
          edgeConfidences: [1],
          graphTypes: ["entity"],
        },
      };
    });
    const fakeIndex = {
      spreadingActivation: async () => candidates,
    } as unknown as GraphIndex;
    const readCount = { count: 0 };
    const originalRead = fixture.storage.readMemoryByPath.bind(fixture.storage);
    fixture.storage.readMemoryByPath = async (filePath: string) => {
      readCount.count += 1;
      return originalRead(filePath);
    };
    const coordinator = makeCoordinator(
      makeConfig(),
      new Map([[fixture.name, fixture]]),
      undefined,
      new Map([[fixture.dir, fakeIndex]]),
    );
    const first = await expand(coordinator, [seedResult(fixture)], [fixture.name], 100);
    const second = await expand(coordinator, [seedResult(fixture)], [fixture.name], 100);

    assert.equal(
      readCount.count,
      400,
      JSON.stringify({ first: first.expandedPaths.length, second: second.expandedPaths.length }),
    );
    assert.equal(first.expandedPaths.length, 200);
    assert.deepEqual(
      first.expandedPaths.map(({ path: resultPath, score }) => [resultPath, score]),
      second.expandedPaths.map(({ path: resultPath, score }) => [resultPath, score]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
