import { createHash } from "node:crypto";
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
  let promotedAttributes: Readonly<Record<string, string>> | undefined;
  let promotedContent: string | undefined;
  const sourceMemory = {
    content: "Synthetic source memory\n[Attributes: locationCity=Austin]",
    frontmatter: {
      category: "fact",
      confidence: 0.8,
      tags: Array.from({ length: 50 }, (_, index) => `source-${index}`),
      structuredAttributes: { locationCity: "Austin" },
    },
  };
  const sourceStorage = {
    getMemoryById: async () => sourceMemory,
  };
  const destinationStorage = {
    writeSealedMemory: async (envelope: {
      content: string;
      tags: readonly string[];
      rawStructuredAttributes?: Readonly<Record<string, string>>;
    }) => {
      promotedContent = envelope.content;
      promotedTags = envelope.tags;
      promotedAttributes = envelope.rawStructuredAttributes;
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
  assert.equal(promotedContent, "Synthetic source memory");

  assert.equal(result, "Promoted default:fact-42 → shared:promoted-1");
  assert.deepEqual(promotedTags?.slice(0, 3), [
    "promoted",
    "promotedFrom:default:fact-42",
    "note:reviewed",
  ]);
  assert.equal(promotedTags?.length, 50);
  assert.equal(promotedTags?.includes("source-46"), true);
  assert.equal(promotedTags?.includes("source-47"), false);
  assert.equal(promotedAttributes?.promotedFromMemoryId, "fact-42");
});

test("memory promotion preserves origin for long legacy IDs", async () => {
  const memoryId = `legacy:${"x".repeat(300)}`;
  const memoryIdHash = createHash("sha256").update(memoryId).digest("hex");
  let promotedTags: readonly string[] | undefined;
  let promotedAttributes: Readonly<Record<string, string>> | undefined;
  const sourceStorage = {
    getMemoryById: async () => ({
      content: "Synthetic legacy memory",
      frontmatter: { category: "fact", confidence: 0.8 },
    }),
  };
  const destinationStorage = {
    writeSealedMemory: async (envelope: {
      tags: readonly string[];
      rawStructuredAttributes?: Readonly<Record<string, string>>;
    }) => {
      promotedTags = envelope.tags;
      promotedAttributes = envelope.rawStructuredAttributes;
      return { id: "promoted-long", tombstoneBlocked: false };
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
    memoryId,
  });

  assert.equal(result, `Promoted default:${memoryId} → shared:promoted-long`);
  assert.equal(
    promotedTags?.includes(`promotedFromHash:${memoryIdHash}`),
    true,
  );
  assert.equal(
    promotedTags?.some((tag) => tag.includes(memoryId)),
    false,
  );
  assert.equal(promotedAttributes?.promotedFromNamespace, "default");
  assert.equal(promotedAttributes?.promotedFromMemoryId, memoryId);
  assert.equal(promotedAttributes?.promotedFromMemoryIdHash, memoryIdHash);
});
