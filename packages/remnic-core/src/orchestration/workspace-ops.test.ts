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
