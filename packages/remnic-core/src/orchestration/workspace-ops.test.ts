import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { WorkspaceOpsCoordinator, type WorkspaceOpsDeps } from "./workspace-ops.js";
import type { AccessTrackingEntry, PluginConfig } from "../types.js";

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
    defaultNamespace: "default",
    sharedNamespace: "shared",
    namespacePolicies: [],
  } as unknown as PluginConfig;
  const coordinator = new WorkspaceOpsCoordinator({
    config,
    accessTrackingBuffer: new Map([
      ["default:same-id", { memoryId: "same-id", memoryPath: firstPath, count: 1, lastAccessed: "2026-07-19T00:00:00.000Z" }],
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
