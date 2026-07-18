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

  const result = await executeMemoryPromote(orchestrator as never, { memoryId });

  assert.equal(result, `Memory not found in default: ${memoryId}`);
  assert.equal(storageCalls.at(-1)?.memoryId, memoryId);
});
