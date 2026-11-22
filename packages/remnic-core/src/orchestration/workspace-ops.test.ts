import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageManager } from "../storage.js";
import { WorkspaceOpsCoordinator, type WorkspaceOpsDeps } from "./workspace-ops.js";
import type { AccessTrackingEntry, PluginConfig } from "../types.js";

test("gatherTodayFacts excludes support passport cards from day-summary input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-workspace-passport-"));
  try {
    await mkdir(root, { recursive: true });
    const storage = new StorageManager(root);
    await storage.writeMemory("preference", "Private support statement", {
      tags: ["support-passport-card"],
      source: "support-passport",
    });
    await storage.writeMemory("fact", "Public project update", {
      source: "test",
    });
    const coordinator = new WorkspaceOpsCoordinator({
      config: {
        defaultNamespace: "default",
        daySummaryTimezone: "UTC",
      } as unknown as PluginConfig,
      storageRouter: {
        storageFor: async () => storage,
      },
    } as unknown as WorkspaceOpsDeps);

    const gathered = await coordinator.gatherTodayFacts(undefined, {
      now: new Date(),
      timeZone: "UTC",
    });

    assert.equal(gathered.includes("Private support statement"), false);
    assert.equal(gathered.includes("Public project update"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("flushAccessTracking keeps duplicate memory IDs scoped by memory path", async () => {
  const defaultPath = path.join("/memory", "namespaces", "default", "facts", "same-id.md");
  const sharedPath = path.join("/memory", "namespaces", "shared", "facts", "same-id.md");
  const memories = [
    {
      path: defaultPath,
      frontmatter: { id: "same-id", accessCount: 2 },
    },
    {
      path: sharedPath,
      frontmatter: { id: "same-id", accessCount: 7 },
    },
  ];
  const flushed = new Map<string, AccessTrackingEntry[]>();
  const config = {
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      ["default:same-id", { memoryId: "same-id", memoryPath: defaultPath, count: 1, lastAccessed: "2026-07-19T00:00:00.000Z" }],
      ["shared:same-id", { memoryId: "same-id", memoryPath: sharedPath, count: 1, lastAccessed: "2026-07-19T00:00:01.000Z" }],
    ]),
    readAllMemoriesForNamespaces: async () => memories,
    namespaceFromPath: (memoryPath: string) => (memoryPath.includes(`${path.sep}shared${path.sep}`) ? "shared" : "default"),
    storageRouter: {
      storageFor: async (namespace: string) => ({
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          flushed.set(namespace, entries);
        },
      }),
    },
  } as unknown as WorkspaceOpsDeps);

  await coordinator.flushAccessTracking();

  assert.deepEqual(flushed.get("default"), [
    {
      memoryId: "same-id",
      memoryPath: defaultPath,
      newCount: 3,
      lastAccessed: "2026-07-19T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(flushed.get("shared"), [
    {
      memoryId: "same-id",
      memoryPath: sharedPath,
      newCount: 8,
      lastAccessed: "2026-07-19T00:00:01.000Z",
    },
  ]);
});
test("flushAccessTracking reads buffered namespaces outside configured policies", async () => {
  const projectPath = path.join("/memory", "namespaces", "project-x", "facts", "same-id.md");
  const memories = [{ path: projectPath, frontmatter: { id: "same-id", accessCount: 4 } }];
  const readNamespaces: string[][] = [];
  let flushed: AccessTrackingEntry[] = [];
  const config = {
    namespacesEnabled: true,
    memoryDir: "/memory",
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      [
        "project-x:same-id",
        {
          memoryId: "same-id",
          memoryPath: projectPath,
          namespace: "project-x",
          count: 1,
          lastAccessed: "2026-07-19T00:00:00.000Z",
        },
      ],
    ]),
    readAllMemoriesForNamespaces: async (namespaces: string[]) => {
      readNamespaces.push(namespaces);
      return memories;
    },
    namespaceFromPath: (memoryPath: string) =>
      memoryPath.includes(`${path.sep}project-x${path.sep}`) ? "project-x" : "default",
    storageRouter: {
      storageFor: async (namespace: string) => ({
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          if (namespace === "project-x") flushed = entries;
        },
      }),
    },
  } as unknown as WorkspaceOpsDeps);

  await coordinator.flushAccessTracking();

  assert.deepEqual(readNamespaces, [["default", "shared", "project-x"]]);
  assert.deepEqual(flushed, [
    {
      memoryId: "same-id",
      memoryPath: projectPath,
      newCount: 5,
      lastAccessed: "2026-07-19T00:00:00.000Z",
    },
  ]);
});

test("flushAccessTracking selects the buffered path within one namespace", async () => {
  const firstPath = path.join("/memory", "facts", "first.md");
  const secondPath = path.join("/memory", "facts", "second.md");
  const memories = [
    { path: secondPath, frontmatter: { id: "same-id", accessCount: 7 } },
    { path: firstPath, frontmatter: { id: "same-id", accessCount: 2 } },
  ];
  let flushed: AccessTrackingEntry[] = [];
  const config = {
    namespacesEnabled: false,
    memoryDir: "/memory",
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      ["default:same-id", { memoryId: "same-id", memoryPath: "facts/first.md", count: 1, lastAccessed: "2026-07-19T00:00:00.000Z" }],
    ]),
    readAllMemoriesForNamespaces: async () => memories,
    namespaceFromPath: () => "default",
    storageRouter: {
      storageFor: async () => ({
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          flushed = entries;
        },
      }),
    },
  } as unknown as WorkspaceOpsDeps);

  await coordinator.flushAccessTracking();

  assert.deepEqual(flushed, [
    {
      memoryId: "same-id",
      memoryPath: firstPath,
      newCount: 3,
      lastAccessed: "2026-07-19T00:00:00.000Z",
    },
  ]);
});

test("flushAccessTracking resolves collection-prefixed QMD paths", async () => {
  const memoryPath = path.join("/memory", "facts", "same-id.md");
  const memories = [{ path: memoryPath, frontmatter: { id: "same-id", accessCount: 2 } }];
  let flushed: AccessTrackingEntry[] = [];
  const config = {
    namespacesEnabled: false,
    memoryDir: "/memory",
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      [
        "default:collection/facts/same-id.md",
        {
          memoryId: "same-id",
          memoryPath: "collection/facts/same-id.md",
          count: 1,
          lastAccessed: "2026-07-19T00:00:00.000Z",
        },
      ],
    ]),
    readAllMemoriesForNamespaces: async () => memories,
    namespaceFromPath: () => "default",
    storageRouter: {
      storageFor: async () => ({
        dir: "/memory",
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          flushed = entries;
        },
      }),
    },
  } as unknown as WorkspaceOpsDeps);

  await coordinator.flushAccessTracking();

  assert.deepEqual(flushed, [
    {
      memoryId: "same-id",
      memoryPath,
      newCount: 3,
      lastAccessed: "2026-07-19T00:00:00.000Z",
    },
  ]);
});

test("flushAccessTracking coalesces aliases for one memory", async () => {
  const memoryPath = path.join("/memory", "facts", "same-id.md");
  const memories = [{ path: memoryPath, frontmatter: { id: "same-id", accessCount: 2 } }];
  let flushed: AccessTrackingEntry[] = [];
  const config = {
    namespacesEnabled: false,
    memoryDir: "/memory",
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      [
        "default:collection/facts/same-id.md",
        {
          memoryId: "same-id",
          memoryPath: "collection/facts/same-id.md",
          count: 1,
          lastAccessed: "2026-07-19T00:00:01.000Z",
        },
      ],
      [
        "default:facts/same-id.md",
        {
          memoryId: "same-id",
          memoryPath: "facts/same-id.md",
          count: 1,
          lastAccessed: "2026-07-19T00:00:00.000Z",
        },
      ],
    ]),
    readAllMemoriesForNamespaces: async () => memories,
    namespaceFromPath: () => "default",
    storageRouter: {
      storageFor: async () => ({
        dir: "/memory",
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          flushed = entries;
        },
      }),
    },
  } as unknown as WorkspaceOpsDeps);

  await coordinator.flushAccessTracking();

  assert.deepEqual(flushed, [
    {
      memoryId: "same-id",
      memoryPath,
      newCount: 4,
      lastAccessed: "2026-07-19T00:00:01.000Z",
    },
  ]);
});

test("trackMemoryAccess keeps same-id accesses separate by path", () => {
  const firstPath = path.join("/memory", "facts", "first", "same-id.md");
  const secondPath = path.join("/memory", "facts", "second", "same-id.md");
  const accessTrackingBuffer = new Map<string, AccessTrackingEntry & { count: number }>();
  const config = {
    accessTrackingEnabled: true,
    accessTrackingBufferMaxSize: 100,
    memoryDir: "/memory",
    defaultNamespace: "default",
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer,
    namespaceFromPath: () => "default",
  } as unknown as WorkspaceOpsDeps);

  coordinator.trackMemoryAccess(["same-id", "same-id"], [firstPath, secondPath]);

  assert.equal(accessTrackingBuffer.size, 2);
  assert.deepEqual(
    Array.from(accessTrackingBuffer.values()).map((entry) => ({
      memoryId: entry.memoryId,
      memoryPath: entry.memoryPath,
      count: entry.count,
    })),
    [
      { memoryId: "same-id", memoryPath: firstPath, count: 1 },
      { memoryId: "same-id", memoryPath: secondPath, count: 1 },
    ],
  );
});

test("trackMemoryAccess coalesces absolute and relative paths for one file", () => {
  const absolutePath = path.join("/memory", "facts", "same-id.md");
  const relativePath = path.join("facts", "same-id.md");
  const accessTrackingBuffer = new Map<string, AccessTrackingEntry & { count: number }>();
  const config = {
    accessTrackingEnabled: true,
    accessTrackingBufferMaxSize: 100,
    memoryDir: "/memory",
    defaultNamespace: "default",
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer,
    namespaceFromPath: () => "default",
  } as unknown as WorkspaceOpsDeps);

  coordinator.trackMemoryAccess(["same-id", "same-id"], [absolutePath, relativePath]);

  assert.equal(accessTrackingBuffer.size, 1);
  assert.equal(Array.from(accessTrackingBuffer.values())[0]?.count, 2);
});
test("trackMemoryAccess preserves namespaces for relative paths", () => {
  const accessTrackingBuffer = new Map<string, AccessTrackingEntry & { count: number }>();
  const config = {
    accessTrackingEnabled: true,
    accessTrackingBufferMaxSize: 100,
    memoryDir: "/memory",
    defaultNamespace: "default",
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer,
    namespaceFromPath: () => "default",
  } as unknown as WorkspaceOpsDeps);

  coordinator.trackMemoryAccess(
    ["same-id", "same-id"],
    ["facts/same-id.md", "facts/same-id.md"],
    ["main", "shared"],
  );

  assert.deepEqual(
    Array.from(accessTrackingBuffer.entries()).map(([key, entry]) => ({
      key,
      memoryPath: entry.memoryPath,
    })),
    [
      { key: "main:/memory/facts/same-id.md", memoryPath: "facts/same-id.md" },
      { key: "shared:/memory/facts/same-id.md", memoryPath: "facts/same-id.md" },
    ],
  );
});

// COS-666e: flushAccessTracking scanned the whole corpus for every buffered update and resolved paths on each
// comparison: 100 updates x 130k memories x 2-3 resolves was a 40 s main-thread stall in production.
type FlushMemory = { path: string; frontmatter: { id: string; accessCount: number } };
type FlushBuffer = WorkspaceOpsDeps["accessTrackingBuffer"];

interface FlushOut {
  flushed: AccessTrackingEntry[];
}


function flushHarness(memories: FlushMemory[], buffered: FlushBuffer) {
  const out: FlushOut = { flushed: [] };
  const deps = {
    config: {
      namespacesEnabled: false,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacePolicies: [],
      memoryDir: "/memory",
    },
    accessTrackingBuffer: buffered,
    readAllMemoriesForNamespaces: async () => memories,
    namespaceFromPath: () => "default",
    storageRouter: {
      storageFor: async () => ({
        dir: "/memory",
        flushAccessTracking: async (entries: AccessTrackingEntry[]) => {
          out.flushed = entries;
        },
      }),
    },
  };
  // SAFETY: flushAccessTracking reads only the fields stubbed above; the full deps object is not worth building.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  return { out, coordinator: new WorkspaceOpsCoordinator(deps as unknown as WorkspaceOpsDeps) };
}

const stamp = "2026-07-19T00:00:00.000Z";

test("flushAccessTracking picks the first memory in corpus order when several match a buffered path or id", async () => {
  const first = path.join("/memory", "facts", "dup.md");
  const memories = [
    { path: first, frontmatter: { id: "dup-a", accessCount: 10 } },
    { path: path.join("/memory", "facts", "..", "facts", "dup.md"), frontmatter: { id: "dup-b", accessCount: 20 } }, // same resolved path
    { path: path.join("/memory", "facts", "other.md"), frontmatter: { id: "same-id", accessCount: 30 } },
    { path: path.join("/memory", "facts", "other2.md"), frontmatter: { id: "same-id", accessCount: 40 } },
  ];
  const buffered: FlushBuffer = new Map([
    ["default:dup", { memoryId: "x", memoryPath: path.join("facts", "dup.md"), count: 1, lastAccessed: stamp }],
    ["default:same-id", { memoryId: "same-id", count: 1, lastAccessed: stamp }],
  ]);
  const { out, coordinator } = flushHarness(memories, buffered);
  await coordinator.flushAccessTracking();
  const byPath = new Map(out.flushed.map((e) => [e.memoryPath, e.newCount]));
  assert.equal(byPath.get(first), 11);
  assert.equal(byPath.get(memories[2].path), 31);
  assert.equal(out.flushed.length, 2);
});

test("flushAccessTracking looks buffered paths up in an index, not by scanning the corpus per update", async (t) => {
  const corpus = 3000;
  const memories = Array.from({ length: corpus }, (_, i) => ({
    path: path.join("/memory", "facts", `m${i}.md`),
    frontmatter: { id: `m${i}`, accessCount: i },
  }));
  const buffered: FlushBuffer = new Map();
  for (let i = 0; i < 100; i++) {
    const at = 2900 - i * 20; // late in the corpus: a scan walks almost all of it
    buffered.set(`default:m${at}`, {
      memoryId: `m${at}`,
      memoryPath: i % 2 === 0 ? memories[at].path : path.join("facts", `m${at}.md`), // absolute, or relative to the memory dir
      count: 1,
      lastAccessed: stamp,
    });
  }
  const { out, coordinator } = flushHarness(memories, buffered);
  const resolve = t.mock.method(path, "resolve");
  await coordinator.flushAccessTracking();
  assert.equal(out.flushed.length, 100);
  assert.equal(out.flushed.find((e) => e.memoryId === "m2900")?.newCount, 2901);
  assert.equal(out.flushed.find((e) => e.memoryId === "m1000")?.newCount, 1001);
  assert.ok(resolve.mock.callCount() < corpus * 4, `${resolve.mock.callCount()} path.resolve calls for ${corpus} memories and 100 updates`);
});

test("flushAccessTracking with 100 updates over 20,000 memories finishes in well under a second", async () => {
  const memories = Array.from({ length: 20_000 }, (_, i) => ({
    path: path.join("/memory", "facts", `m${i}.md`),
    frontmatter: { id: `m${i}`, accessCount: 0 },
  }));
  const buffered: FlushBuffer = new Map();
  for (let i = 0; i < 100; i++) {
    const at = 19_999 - i * 7;
    buffered.set(`default:m${at}`, { memoryId: `m${at}`, memoryPath: memories[at].path, count: 1, lastAccessed: stamp });
  }
  const { out, coordinator } = flushHarness(memories, buffered);
  const started = performance.now();
  await coordinator.flushAccessTracking();
  const elapsed = performance.now() - started;
  assert.equal(out.flushed.length, 100);
  assert.ok(elapsed < 1000, `flush took ${Math.round(elapsed)} ms`); // the per-update corpus scan took several seconds here
});

test("flushAccessTracking takes the earlier memory when a relative path matches one as given and another under the memory dir", async () => {
  const underMemoryDir = path.join("/memory", "facts", "x.md");
  const memories = [
    { path: underMemoryDir, frontmatter: { id: "under-dir", accessCount: 5 } },
    { path: path.resolve("facts", "x.md"), frontmatter: { id: "as-given", accessCount: 50 } },
  ];
  const buffered: FlushBuffer = new Map([["default:x", { memoryId: "x", memoryPath: path.join("facts", "x.md"), count: 1, lastAccessed: stamp }]]);
  const { out, coordinator } = flushHarness(memories, buffered);
  await coordinator.flushAccessTracking();
  assert.deepEqual(out.flushed.map((e) => [e.memoryPath, e.newCount]), [[underMemoryDir, 6]]);
});

test("flushAccessTracking tries the plain path before the QMD collection candidates", async () => {
  const viaCandidate = path.join("/memory", "facts", "x.md");
  const viaPlainPath = path.join("/memory", "collection", "facts", "x.md");
  const memories = [
    { path: viaCandidate, frontmatter: { id: "cand-a", accessCount: 5 } },
    { path: viaPlainPath, frontmatter: { id: "plain-b", accessCount: 50 } },
  ];
  const buffered: FlushBuffer = new Map([["default:x", { memoryId: "x", memoryPath: "collection/facts/x.md", count: 1, lastAccessed: stamp }]]);
  const { out, coordinator } = flushHarness(memories, buffered);
  await coordinator.flushAccessTracking();
  assert.deepEqual(out.flushed.map((e) => [e.memoryPath, e.newCount]), [[viaPlainPath, 51]]);
});

test("validateLocalLlmModel warns to update persisted config instead of mutating it — #3562", async () => {
  // The validator detected config.localLlmMaxContext > the loaded model's
  // real window and silently rewrote the shared config object via a cast.
  // The contract: validation warns the user to fix their persisted config;
  // the config object is never mutated behind consumers' backs.
  const config = { localLlmMaxContext: 131072 };
  // SAFETY: validateLocalLlmModel reads only config + localLlm; the
  // remaining WorkspaceOpsDeps members are unused by this method.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the test stub is a deps partial
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    localLlm: {
      getLoadedModelInfo: async () => ({ id: "qwen-local", contextWindow: 32768 }),
    },
  } as unknown as WorkspaceOpsDeps);
  await coordinator.validateLocalLlmModel();
  assert.equal(
    config.localLlmMaxContext,
    131072,
    "validateLocalLlmModel must not rewrite config.localLlmMaxContext",
  );
});
