import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
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
  await storage.writeMemory("fact", `${name} seed`, { source: "test" });
  await storage.writeMemory("fact", `${name} intermediate`, {
    source: "test",
    status: intermediateStatus,
  });
  await storage.writeMemory("fact", `${name} clean`, { source: "test" });
  if (includeSecondClean) {
    await storage.writeMemory("fact", `${name} second clean`, { source: "test" });
  }
  await storage.writeMemory("fact", `${name} stale`, { source: "test" });
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
): GraphRecallCoordinator {
  const indexes = new Map<string, GraphIndex>();
  for (const fixture of fixtures.values()) {
    indexes.set(fixture.dir, new GraphIndex(fixture.dir, config as unknown as GraphConfig));
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
    storageFor: async (namespace) => fixtures.get(namespace)!.storage,
    graphIndexFor: (storage) => indexes.get(storage.dir)!,
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
) {
  return coordinator.expandResultsViaGraph({
    memoryResults: results,
    recallNamespaces: namespaces,
    recallResultLimit: 1,
    asOf: AS_OF,
  });
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

test("missing memory status defaults to active for path scoring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-path-status-"));
  try {
    const fixture = await createNamespace(root, "default");
    const originalReadAllMemories = fixture.storage.readAllMemories.bind(fixture.storage);
    fixture.storage.readAllMemories = async (
      ...args: Parameters<StorageManager["readAllMemories"]>
    ) =>
      (await originalReadAllMemories(...args)).map((memory) =>
        memory.path.endsWith(fixture.intermediatePath)
          ? {
              ...memory,
              frontmatter: {
                ...memory.frontmatter,
                status: undefined,
                invalid_at: AS_OF,
              },
            }
          : memory,
      );
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
