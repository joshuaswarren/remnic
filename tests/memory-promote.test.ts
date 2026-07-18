import test from "node:test";
import assert from "node:assert/strict";
import { executeMemoryPromote } from "../src/memory-promote.js";

function buildOrchestrator() {
  const storageCalls: Array<{ namespace: string; memoryId?: string }> = [];
  const storage = {
    getMemoryById: async (memoryId: string) => {
      storageCalls.push({ namespace: "default", memoryId });
      return null;
    },
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      memoryDir: "/tmp/remnic-memory-promote-test",
      queryAwareIndexingEnabled: false,
    },
    getStorage: async (namespace: string) => {
      storageCalls.push({ namespace });
      return storage;
    },
  };
  return { orchestrator, storageCalls };
}

test("memory promotion treats null optional namespaces as omitted", async () => {
  const { orchestrator, storageCalls } = buildOrchestrator();

  const result = await executeMemoryPromote(orchestrator as never, {
    memoryId: "fact-42",
    fromNamespace: null as unknown as string,
    toNamespace: null as unknown as string,
  });

  assert.equal(result, "Memory not found in default: fact-42");
  assert.deepEqual(storageCalls, [
    { namespace: "default" },
    { namespace: "default", memoryId: "fact-42" },
  ]);
});

test("memory promotion looks up legacy IDs longer than the filename grammar", async () => {
  const { orchestrator, storageCalls } = buildOrchestrator();
  const memoryId = `legacy:${"x".repeat(300)}`;

  const result = await executeMemoryPromote(orchestrator as never, {
    memoryId,
  });

  assert.equal(result, `Memory not found in default: ${memoryId}`);
  assert.equal(storageCalls.at(-1)?.memoryId, memoryId);
});

test("memory promotion preserves provenance tags before source tags", async () => {
  let promotedTags: readonly string[] | undefined;
  const sourceMemory = {
    content: "Synthetic source memory",
    frontmatter: {
      category: "fact",
      confidence: 0.8,
      tags: Array.from({ length: 50 }, (_, index) => `source-${index}`),
    },
  };
  const sourceStorage = {
    getMemoryById: async () => sourceMemory,
  };
  const destinationStorage = {
    writeSealedMemory: async (envelope: { tags: readonly string[] }) => {
      promotedTags = envelope.tags;
      return { id: "promoted-1", tombstoneBlocked: false };
    },
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      memoryDir: "/tmp/remnic-memory-promote-test",
      queryAwareIndexingEnabled: false,
    },
    getStorage: async (namespace: string) =>
      namespace === "default" ? sourceStorage : destinationStorage,
  };

  const result = await executeMemoryPromote(orchestrator as never, {
    memoryId: "fact-42",
    note: "reviewed",
  });

  assert.equal(result, "Promoted default:fact-42 → shared:promoted-1");
  assert.deepEqual(promotedTags?.slice(0, 3), [
    "promoted",
    "promotedFrom:default:fact-42",
    "note:reviewed",
  ]);
  assert.equal(promotedTags?.length, 50);
  assert.equal(promotedTags?.includes("source-46"), true);
  assert.equal(promotedTags?.includes("source-47"), false);
});
