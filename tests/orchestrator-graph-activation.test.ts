import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "@remnic/core/config";
import { Orchestrator } from "@remnic/core/orchestrator";

function namespaceIdentityToken(namespace: string): string {
  const bytes = new TextEncoder().encode(namespace.trim());
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ns-${hex || "default"}`;
}

test("buildGraphEdge writes fallback session adjacency when enabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-adj-enabled-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    graphWriteSessionAdjacencyEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg);

  let captured: any = null;
  (orchestrator as any).graphIndexFor = () => ({
    onMemoryWritten: async (opts: any) => {
      captured = opts;
    },
  });

  await (orchestrator as any).buildGraphEdge(
    { dir: memoryDir },
    "facts/2026-02-24/current.md",
    undefined,
    "current",
    "content",
    [],
    new Map(),
    undefined,
    undefined,
    "facts/2026-02-24/previous.md",
  );

  assert.ok(captured);
  assert.deepEqual(captured.recentInThread, ["facts/2026-02-24/previous.md"]);
});

test("buildGraphEdge skips fallback session adjacency when disabled", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-adj-disabled-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
    graphWriteSessionAdjacencyEnabled: false,
  });
  const orchestrator = new Orchestrator(cfg);

  let captured: any = null;
  (orchestrator as any).graphIndexFor = () => ({
    onMemoryWritten: async (opts: any) => {
      captured = opts;
    },
  });

  await (orchestrator as any).buildGraphEdge(
    { dir: memoryDir },
    "facts/2026-02-24/current.md",
    undefined,
    "current",
    "content",
    [],
    new Map(),
    undefined,
    undefined,
    "facts/2026-02-24/previous.md",
  );

  assert.ok(captured);
  assert.deepEqual(captured.recentInThread, []);
});

test("graph expansion resolves namespace QMD collection paths before seeding", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-qmd-seed-"));
  const namespace = "team-project-alpha";
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
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
    multiGraphMemoryEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg);
  const storage = await (orchestrator as any).storageRouter.storageFor(namespace);
  const { id: memoryId } = await storage.writeMemory(
    "fact",
    "Graph seed memory for namespace collection paths.",
  );
  const memory = await storage.getMemoryById(memoryId);
  assert.ok(memory);

  const relativeMemoryPath = path
    .relative(storage.dir, memory.path)
    .split(path.sep)
    .join("/");
  const collectionPath = [
    `openclaw-engram--${namespaceIdentityToken(namespace)}`,
    relativeMemoryPath,
  ].join("/");
  let observedSeeds: string[] = [];
  (orchestrator as any).graphIndexFor = () => ({
    spreadingActivation: async (seeds: string[]) => {
      observedSeeds = seeds;
      return [];
    },
  });

  await (orchestrator as any).expandResultsViaGraph({
    memoryResults: [
      {
        docid: memory.frontmatter.id,
        path: collectionPath,
        snippet: memory.content,
        score: 0.8,
      },
    ],
    recallNamespaces: [namespace],
    recallResultLimit: 5,
  });

  assert.deepEqual(observedSeeds, [relativeMemoryPath]);
});

test("graph expansion stops expanded memory reads after assembly deadline", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-graph-read-deadline-"));
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    multiGraphMemoryEnabled: true,
  });
  const orchestrator = new Orchestrator(cfg);
  const storage = await (orchestrator as any).storageRouter.storageFor("default");
  const { id: seedId } = await storage.writeMemory("fact", "Graph seed memory.");
  const { id: expandedId } = await storage.writeMemory("fact", "Expanded graph memory.");
  const seed = await storage.getMemoryById(seedId);
  const expanded = await storage.getMemoryById(expandedId);
  assert.ok(seed);
  assert.ok(expanded);

  const seedRelativePath = path.relative(storage.dir, seed.path).split(path.sep).join("/");
  const expandedRelativePath = path
    .relative(storage.dir, expanded.path)
    .split(path.sep)
    .join("/");
  const deadlineAtMs = 1_100;
  const originalDateNow = Date.now;
  let nowMs = 1_000;
  let expandedReads = 0;
  const originalReadMemoryByPath = storage.readMemoryByPath.bind(storage);
  (storage as any).readMemoryByPath = async (...args: unknown[]) => {
    expandedReads += 1;
    return originalReadMemoryByPath(...(args as [string]));
  };
  (orchestrator as any).graphIndexFor = () => ({
    spreadingActivation: async () => {
      nowMs = deadlineAtMs + 1;
      return [
        {
          path: expandedRelativePath,
          score: 0.7,
          seed: seedRelativePath,
          hopDepth: 1,
          decayedWeight: 0.7,
          graphType: "semantic",
          edgeConfidence: 0.9,
        },
      ];
    },
  });

  try {
    Date.now = () => nowMs;
    const result = await (orchestrator as any).expandResultsViaGraph({
      memoryResults: [
        {
          docid: seed.frontmatter.id,
          path: seed.path,
          snippet: seed.content,
          score: 0.8,
        },
      ],
      recallNamespaces: ["default"],
      recallResultLimit: 5,
      deadlineAtMs,
    });

    assert.equal(expandedReads, 0);
    assert.deepEqual(result.expandedPaths, []);
  } finally {
    Date.now = originalDateNow;
    (storage as any).readMemoryByPath = originalReadMemoryByPath;
  }
});
