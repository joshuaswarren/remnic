import assert from "node:assert/strict";
import test from "node:test";

import type { Orchestrator } from "./orchestrator.js";
import type { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";
import type { SealedMemoryEnvelope } from "./write-envelope.js";
import {
  InlineExplicitCaptureProcessor,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  validateExplicitCaptureInput,
} from "./explicit-capture.js";

function parseSingleNote(confidenceLine: string): ReturnType<typeof parseInlineExplicitCaptureNotes>[number] {
  const notes = parseInlineExplicitCaptureNotes(`
<memory_note>
content: Inline explicit capture content for testing
category: fact
${confidenceLine}
</memory_note>
`);
  assert.equal(notes.length, 1);
  return notes[0]!;
}

test("inline explicit capture rejects malformed confidence values", () => {
  for (const confidenceLine of ["confidence: abc", "confidence: 0.5x"]) {
    const note = parseSingleNote(confidenceLine);
    assert.throws(
      () => validateExplicitCaptureInput(note),
      /confidence must be a finite number/,
      `${confidenceLine} should be rejected`
    );
  }
});

test("inline explicit capture preserves valid confidence values", () => {
  const validated = validateExplicitCaptureInput(parseSingleNote("confidence: 0.5"));
  assert.equal(validated.confidence, 0.5);
});

test("inline explicit capture defaults omitted confidence", () => {
  const validated = validateExplicitCaptureInput(parseSingleNote(""));
  assert.equal(validated.confidence, 0.95);
});

type StoredMemory = {
  frontmatter: {
    id: string;
    category: string;
    status?: string;
    tags?: string[];
    sourceConnector?: string;
    blockedBy?: string;
  };
  content: string;
};
function createInlineCaptureProcessorProbe(
  options: {
    tombstoneBlocked?: boolean;
    authoritativeFactHashMiss?: boolean;
    tombstoneBlockedCaptureIndexHit?: boolean;
    failWrites?: boolean;
    failPrimaryWrites?: boolean;
    duplicateReadDelayMs?: number;
    lockBusyAttempts?: number;
  } = {}
) {
  const envelopes: SealedMemoryEnvelope[] = [];
  const lifecycleEvents: Array<{ eventType: string; actor: string }> = [];
  const maintenanceReasons: string[] = [];
  const requestedNamespaces: Array<string | undefined> = [];
  const memories: StoredMemory[] = [];
  const coldMemories: StoredMemory[] = [];
  const blockedIndexArguments: Array<{
    content: string;
    category: string;
    sourceConnector?: string;
  }> = [];
  let readAllCalls = 0;
  let activeReadAllCalls = 0;
  let maxConcurrentReadAllCalls = 0;
  let nextId = 1;
  let writeTail = Promise.resolve();
  let lockBusyAttemptsRemaining = options.lockBusyAttempts ?? 0;
  const storage = {
    readAllMemories: async () => {
      readAllCalls += 1;
      activeReadAllCalls += 1;
      maxConcurrentReadAllCalls = Math.max(maxConcurrentReadAllCalls, activeReadAllCalls);
      if (options.duplicateReadDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.duplicateReadDelayMs));
      }
      activeReadAllCalls -= 1;
      return memories.map((memory) => ({
        ...memory,
        frontmatter: { ...memory.frontmatter },
      }));
    },
    readAllColdMemories: async () =>
      coldMemories.map((memory) => ({
        ...memory,
        frontmatter: { ...memory.frontmatter },
      })),
    writeSealedMemory: async (envelope: SealedMemoryEnvelope) => {
      if (options.failWrites || (options.failPrimaryWrites && envelope.source === "explicit-inline")) {
        throw new Error("simulated sealed write failure");
      }
      const id = `memory-${nextId++}`;
      envelopes.push(envelope);
      memories.push({
        frontmatter: {
          id,
          category: envelope.category,
          ...(options.tombstoneBlocked ? { status: "pending_review", blockedBy: "tombstone-1" } : {}),
          tags: [...envelope.tags],
          sourceConnector: envelope.sourceConnector,
        },
        content: envelope.content,
      });
      return { id, tombstoneBlocked: options.tombstoneBlocked === true };
    },
    withTombstoneBlockedCaptureWriteLock: async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = writeTail;
      let release!: () => void;
      writeTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        if (lockBusyAttemptsRemaining > 0) {
          lockBusyAttemptsRemaining -= 1;
          throw new Error("tombstone-blocked capture write lock remained busy");
        }
        return await operation();
      } finally {
        release();
      }
    },
    ...(options.authoritativeFactHashMiss
      ? {
          hasFactContentHash: async () => false,
          isFactContentHashAuthoritative: () => true,
        }
      : {}),
    ...(options.tombstoneBlockedCaptureIndexHit !== undefined
      ? {
          checkTombstoneBlockedExplicitCapture: async (content: string, category: string, sourceConnector?: string) => {
            blockedIndexArguments.push({ content, category, sourceConnector });
            return {
              has: options.tombstoneBlockedCaptureIndexHit === true,
              authoritative: true,
            };
          },
          hasTombstoneBlockedExplicitCapture: async (content: string, category: string, sourceConnector?: string) => {
            blockedIndexArguments.push({ content, category, sourceConnector });
            return options.tombstoneBlockedCaptureIndexHit === true;
          },
          isTombstoneBlockedExplicitCaptureIndexAuthoritative: async () => true,
        }
      : {}),
    appendMemoryLifecycleEvents: async (events: Array<{ eventType: string; actor: string }>) => {
      lifecycleEvents.push(...events);
    },
    getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (memory: StoredMemory, update: { status?: string }) => {
      memory.frontmatter = { ...memory.frontmatter, ...update };
    },
  };
  const orchestrator = {
    config: {
      captureMode: "hybrid",
      defaultNamespace: "default",
      memoryDir: "",
      namespacePolicies: [],
      namespacesEnabled: true,
      sharedNamespace: "shared",
    } as unknown as PluginConfig,
    getStorage: async (namespace?: string) => {
      requestedNamespaces.push(namespace);
      return storage;
    },
    requestQmdMaintenanceForTool: (reason: string) => {
      maintenanceReasons.push(reason);
    },
  } as unknown as Orchestrator;

  return {
    envelopes,
    lifecycleEvents,
    maintenanceReasons,
    memories,
    coldMemories,
    storage,
    readAllCalls: () => readAllCalls,
    maxConcurrentReadAllCalls: () => maxConcurrentReadAllCalls,
    blockedIndexArguments: () => blockedIndexArguments,
    orchestrator,
    processor: new InlineExplicitCaptureProcessor(orchestrator, { sourceConnector: "openclaw" }),
    requestedNamespaces,
  };
}

test("inline capture processor persists an authorized inline note once and strips it from hybrid replay", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = [
    "Keep the visible turn.",
    "<memory_note>",
    "content: The deployment plan should use a rolling rollout.",
    "category: decision",
    "namespace: another-principal",
    "</memory_note>",
  ].join("\n");
  const request = {
    captureMode: "hybrid" as const,
    content,
    dedupeKeys: ["message-1"],
    namespace: "principal-project",
    namespacePreResolved: true,
  };

  const first = await probe.processor.process(request);
  const replay = await probe.processor.process(request);

  assert.equal(first.content, "Keep the visible turn.");
  assert.equal(first.accepted, 1);
  assert.equal(first.queued, 0);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.envelopes[0]?.source, "explicit-inline");
  assert.equal(probe.envelopes[0]?.sourceConnector, "openclaw");
  assert.deepEqual(probe.requestedNamespaces, ["principal-project"]);
  assert.deepEqual(probe.maintenanceReasons, ["inline.memory_note"]);
  assert.equal(probe.lifecycleEvents[0]?.eventType, "explicit_capture_accepted");
  assert.equal(probe.lifecycleEvents[0]?.actor, "inline.memory_note");
});

test("inline capture processor serializes overlapping duplicate deliveries", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: Overlapping deliveries must persist one inline capture.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["overlapping-delivery"],
  };

  const [first, second] = await Promise.all([probe.processor.process(request), probe.processor.process(request)]);

  assert.equal(first.processed + second.processed, 1);
  assert.equal(first.accepted + second.accepted, 1);
  assert.equal(first.duplicates + second.duplicates, 1);
  assert.equal(first.queued + second.queued, 0);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.lifecycleEvents.length, 1);
  assert.deepEqual(probe.maintenanceReasons, ["inline.memory_note"]);
});

test("persistExplicitCapture serializes duplicate checks across concurrent calls", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const candidate = {
    content: "Concurrent persistence must produce one durable capture.",
    category: "fact" as const,
    confidence: 0.9,
    tags: [],
  };
  const [first, second] = await Promise.all([
    persistExplicitCapture(probe.orchestrator, candidate, "memory_store"),
    persistExplicitCapture(probe.orchestrator, candidate, "memory_store"),
  ]);
  assert.equal(Number(first.duplicateOf !== undefined) + Number(second.duplicateOf !== undefined), 1);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.lifecycleEvents.length, 1);
});

test("inline capture processor hashes the effective authorized input for replay dedupe", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const request = {
    captureMode: "hybrid" as const,
    dedupeKeys: ["authorized-delivery"],
    namespace: "principal-project",
    namespacePreResolved: true,
  };
  const first = await probe.processor.process({
    ...request,
    content: [
      "<memory_note>",
      "content: An authorized namespace must control replay identity.",
      "category: fact",
      "namespace: untrusted-inline-value",
      "</memory_note>",
    ].join("\n"),
  });
  const replay = await probe.processor.process({
    ...request,
    content: [
      "<memory_note>",
      "content: An authorized namespace must control replay identity.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor normalizes omitted namespaces to the effective default", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const request = {
    captureMode: "hybrid" as const,
    dedupeKeys: ["default-namespace-delivery"],
  };
  const first = await probe.processor.process({
    ...request,
    content: [
      "<memory_note>",
      "content: Default namespace replay identity must be stable.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  });
  const replay = await probe.processor.process({
    ...request,
    content: [
      "<memory_note>",
      "content: Default namespace replay identity must be stable.",
      "category: fact",
      "namespace: default",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor routes tombstone-blocked captures to review", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const result = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: A tombstone-blocked capture must not be reported active.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["message-tombstone-blocked"],
  });

  assert.equal(result.accepted, 0);
  assert.equal(result.queued, 1);
  assert.deepEqual(probe.maintenanceReasons, ["inline.memory_note.review"]);
  assert.equal(probe.lifecycleEvents[0]?.eventType, "explicit_capture_queued");
});

test("inline capture processor queues invalid complete markup and never leaves it for hybrid extraction", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = [
    "Keep only this visible turn.",
    "<memory_note>",
    "content: The rollout should use review before production.",
    "confidence: invalid",
    "namespace: another-principal",
    "</memory_note>",
  ].join("\n");

  const result = await probe.processor.process({
    captureMode: "hybrid",
    content,
    dedupeKeys: ["message-2"],
    namespace: "principal-project",
    namespacePreResolved: true,
  });
  const disabled = await probe.processor.process({
    captureMode: "implicit",
    content,
    dedupeKeys: ["message-3"],
    namespace: "principal-project",
    namespacePreResolved: true,
  });

  assert.equal(result.content, "Keep only this visible turn.");
  assert.equal(result.accepted, 0);
  assert.equal(result.queued, 1);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.envelopes[0]?.source, "explicit-inline-review");
  assert.match(probe.envelopes[0]?.content ?? "", /confidence must be a finite number/);
  assert.equal(probe.memories[0]?.frontmatter.status, "pending_review");
  assert.deepEqual(probe.maintenanceReasons, ["inline.memory_note.review"]);
  assert.equal(probe.lifecycleEvents[0]?.eventType, "explicit_capture_queued");
  assert.equal(probe.lifecycleEvents[0]?.actor, "inline.memory_note");
  assert.equal(disabled.content, content);
  assert.equal(disabled.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture review fallback serializes duplicate checks across processor instances", async () => {
  const probe = createInlineCaptureProcessorProbe({ duplicateReadDelayMs: 15 });
  const secondProcessor = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    sourceConnector: "openclaw",
  });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: Concurrent invalid captures must queue one review.",
      "confidence: invalid",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
    namespace: "principal-project",
    namespacePreResolved: true,
  };
  const [first, second] = await Promise.all([
    probe.processor.process({ ...request, dedupeKeys: ["review-fallback-1"] }),
    secondProcessor.process({ ...request, dedupeKeys: ["review-fallback-2"] }),
  ]);

  assert.equal(first.queued + second.queued, 1);
  assert.equal(first.duplicates + second.duplicates, 1);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.lifecycleEvents.length, 1);
  assert.equal(probe.maxConcurrentReadAllCalls(), 1);
});

test("inline capture review fallback isolates authorized review namespaces", async () => {
  const primary = createInlineCaptureProcessorProbe();
  const secondary = createInlineCaptureProcessorProbe();
  const config = primary.orchestrator.config as PluginConfig;
  config.namespacePolicies = [
    { name: "review-a", readPrincipals: ["*"], writePrincipals: ["*"] },
    { name: "review-b", readPrincipals: ["*"], writePrincipals: ["*"] },
  ];
  const primaryStorage = primary.storage;
  const secondaryStorage = secondary.storage;
  primary.orchestrator.getStorage = async (namespace?: string) =>
    (namespace === "review-b" ? secondaryStorage : primaryStorage) as unknown as StorageManager;
  const secondProcessor = new InlineExplicitCaptureProcessor(primary.orchestrator, {
    sourceConnector: "openclaw",
  });
  const content = [
    "<memory_note>",
    "content: The same unsupported note must stay isolated by review principal.",
    "category: fact",
    "namespace: unsupported-inline-namespace",
    "</memory_note>",
  ].join("\n");
  const first = await primary.processor.process({
    captureMode: "hybrid",
    content,
    dedupeKeys: ["review-root-a"],
    reviewNamespace: "review-a",
    reviewNamespacePreResolved: true,
  });
  const second = await secondProcessor.process({
    captureMode: "hybrid",
    content,
    dedupeKeys: ["review-root-b"],
    reviewNamespace: "review-b",
    reviewNamespacePreResolved: true,
  });

  assert.equal(first.queued, 1);
  assert.equal(second.queued, 1);
  assert.equal(primary.memories.length, 1);
  assert.equal(secondary.memories.length, 1);
});

test("inline capture review fallback replays within one authorized review namespace", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const config = probe.orchestrator.config as PluginConfig;
  config.namespacePolicies = [{ name: "review-a", readPrincipals: ["*"], writePrincipals: ["*"] }];
  const content = [
    "<memory_note>",
    "content: A same-principal invalid note must queue once.",
    "category: fact",
    "namespace: unsupported-inline-namespace",
    "</memory_note>",
  ].join("\n");
  const first = await probe.processor.process({
    captureMode: "hybrid",
    content,
    dedupeKeys: ["delivery-a"],
    reviewNamespace: "review-a",
    reviewNamespacePreResolved: true,
  });
  const restarted = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    sourceConnector: "openclaw",
  });
  const second = await restarted.process({
    captureMode: "hybrid",
    content,
    dedupeKeys: ["delivery-b"],
    reviewNamespace: "review-a",
    reviewNamespacePreResolved: true,
  });

  assert.equal(first.queued, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(probe.memories.length, 1);
});

test("inline capture processor rejects pre-resolved input without a resolved namespace", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = [
    "<memory_note>",
    "content: A caller must authorize this namespace before writing.",
    "category: fact",
    "namespace: another-principal",
    "</memory_note>",
  ].join("\n");

  await assert.rejects(
    probe.processor.process({
      captureMode: "hybrid",
      content,
      dedupeKeys: ["message-untrusted-namespace"],
      namespacePreResolved: true,
    }),
    /namespacePreResolved requires a resolved namespace/
  );
  assert.equal(probe.envelopes.length, 0);
});

test("inline capture processor bounds non-finite dedupe limits", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const processor = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    maxDedupeKeys: Number.POSITIVE_INFINITY,
    sourceConnector: "openclaw",
  });
  const contentFor = (index: number) =>
    [
      "<memory_note>",
      `content: A bounded dedupe capture item number ${index}.`,
      "category: fact",
      "</memory_note>",
    ].join("\n");

  for (let index = 0; index <= 1024; index += 1) {
    await processor.process({
      captureMode: "hybrid",
      content: contentFor(index),
      dedupeKeys: [`message-${index}`],
    });
    probe.memories.length = 0;
  }

  const replay = await processor.process({
    captureMode: "hybrid",
    content: contentFor(0),
    dedupeKeys: ["message-0"],
  });
  assert.equal(replay.processed, 1);
});

test("inline capture processor keeps a replay key for fractional dedupe limits", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const processor = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    maxDedupeKeys: 0.5,
    sourceConnector: "openclaw",
  });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: A fractional dedupe limit must retain this replay key.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["fractional-limit-message"],
  };

  await processor.process(request);
  const replay = await processor.process(request);
  assert.equal(replay.processed, 0);
});

test("inline capture processor scopes replay keys to the authorized namespace", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = [
    "<memory_note>",
    "content: A scoped replay key must not suppress another namespace.",
    "category: fact",
    "</memory_note>",
  ].join("\n");
  const request = {
    captureMode: "hybrid" as const,
    content,
    dedupeKeys: ["shared-delivery"],
    namespacePreResolved: true,
  };

  const first = await probe.processor.process({ ...request, namespace: "principal-one" });
  const second = await probe.processor.process({ ...request, namespace: "principal-two" });

  assert.equal(first.processed, 1);
  assert.equal(second.processed, 1);
  assert.ok(probe.requestedNamespaces.includes("principal-one"));
  assert.ok(probe.requestedNamespaces.includes("principal-two"));
});

test("inline capture processor scopes replay keys to the source connector", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: A replay key must not cross an authenticated connector boundary.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["shared-delivery"],
    namespace: "principal-one",
    namespacePreResolved: true,
  };

  const first = await probe.processor.process({ ...request, sourceConnector: "connector-one" });
  const second = await probe.processor.process({ ...request, sourceConnector: "connector-two" });

  assert.equal(first.queued, 1);
  assert.equal(second.queued, 1);
  assert.equal(probe.envelopes.length, 2);
});

test("inline capture processor canonicalizes reordered note fields for replay dedupe", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const first = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: Reordered note fields must share one replay identity.",
      "category: fact",
      "tags: release, capture",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["reordered-delivery"],
  });
  const replay = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "tags: capture, release",
      "category: fact",
      "content: reordered   note fields must share ONE replay identity.",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["reordered-delivery"],
  });

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor reports failed review fallback without claiming capture handling", async () => {
  const probe = createInlineCaptureProcessorProbe({ failWrites: true });
  const result = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "Keep this visible turn.",
      "<memory_note>",
      "content: This note must remain retryable after both writes fail.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(result.processed, 0);
  assert.equal(result.accepted, 0);
  assert.equal(result.queued, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.content, "Keep this visible turn.");
});

test("inline capture does not queue review after a validated persistence failure", async () => {
  const probe = createInlineCaptureProcessorProbe({ failPrimaryWrites: true });
  const result = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "Keep this visible turn.",
      "<memory_note>",
      "content: A validated note must remain retryable after primary persistence fails.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(result.processed, 0);
  assert.equal(result.accepted, 0);
  assert.equal(result.queued, 0);
  assert.equal(result.failed, 1);
  assert.equal(probe.envelopes.length, 0);
  assert.equal(probe.memories.length, 0);
});

test("inline capture defers bounded lock contention for a later retry", async () => {
  const probe = createInlineCaptureProcessorProbe({ lockBusyAttempts: 2 });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "Keep this visible turn.",
      "<memory_note>",
      "content: A busy capture lock must remain retryable, not become review state.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  };

  const deferred = await probe.processor.process(request);
  assert.equal(deferred.processed, 0);
  assert.equal(deferred.queued, 0);
  assert.equal(deferred.failed, 1);
  assert.equal(probe.envelopes.length, 0);

  const retry = await probe.processor.process(request);
  assert.equal(retry.accepted, 1);
  assert.equal(retry.queued, 0);
  assert.equal(retry.failed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor derives a replay key without delivery metadata", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: An id-less replay must not create a second review capture.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  };

  const first = await probe.processor.process(request);
  const replay = await probe.processor.process(request);

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor does not let a fallback suppress a new delivery after durable removal", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const first = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: A fallback must not suppress a new delivery after durable removal.",
      "category: fact",
      "tags: original-tag",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["first-delivery"],
  });
  probe.memories.length = 0;
  const replay = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: a fallback  must not suppress a NEW delivery after durable removal.",
      "category: fact",
      "tags: replay-tag",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["second-delivery"],
  });

  assert.equal(first.queued, 1);
  assert.equal(replay.queued, 1);
  assert.equal(probe.envelopes.length, 2);
});

test("inline capture processor queues complete notes with empty content", async () => {
  for (const noteFields of [["category: fact"], ["content: |", "category: fact"]]) {
    const probe = createInlineCaptureProcessorProbe();
    const result = await probe.processor.process({
      captureMode: "hybrid",
      content: ["Keep this visible text.", "<memory_note>", ...noteFields, "</memory_note>"].join("\n"),
    });

    assert.equal(result.content, "Keep this visible text.");
    assert.equal(result.processed, 1);
    assert.equal(result.queued, 1);
    assert.equal(probe.envelopes.length, 1);
    assert.match(probe.envelopes[0]?.content ?? "", /\[empty explicit capture\]/);
    assert.equal(probe.lifecycleEvents[0]?.eventType, "explicit_capture_queued");
  }
});

test("inline capture processor deduplicates tombstone review captures after restart", async () => {
  const probe = createInlineCaptureProcessorProbe({
    tombstoneBlocked: true,
    authoritativeFactHashMiss: true,
  });
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: Tombstone-blocked captures must survive process restarts.",
      "category: fact",
      "</memory_note>",
    ].join("\n"),
  };

  const first = await probe.processor.process(request);
  const restarted = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    sourceConnector: "openclaw",
  });
  const replay = await restarted.process(request);

  assert.equal(first.queued, 1);
  assert.equal(replay.duplicates, 1);
  assert.equal(replay.queued, 0);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.lifecycleEvents.length, 1);
});

test("inline capture queues safe unsupported namespaces through the authorized review scope", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const result = await probe.processor.process({
    captureMode: "hybrid",
    reviewNamespace: "default",
    reviewNamespacePreResolved: true,
    content: [
      "<memory_note>",
      "content: A safe but unconfigured namespace must remain reviewable.",
      "category: fact",
      "namespace: unconfigured-inline",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(result.queued, 1);
  assert.equal(probe.envelopes.length, 1);
  assert.match(probe.envelopes[0]?.content ?? "", /Requested namespace: unconfigured-inline/);
  assert.ok(probe.requestedNamespaces.every((namespace) => namespace === "default"));
});

test("inline capture review fallback scans the default root when namespaces are disabled", async () => {
  const probe = createInlineCaptureProcessorProbe();
  (probe.orchestrator.config as PluginConfig).namespacesEnabled = false;
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: A default-root review must deduplicate when namespaces are disabled.",
      "category: fact",
      "confidence: invalid",
      "</memory_note>",
    ].join("\n"),
  };

  const first = await probe.processor.process(request);
  const restarted = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    sourceConnector: "openclaw",
  });
  const second = await restarted.process(request);

  assert.equal(first.queued, 1);
  assert.equal(second.duplicates, 1);
  assert.equal(probe.envelopes.length, 1);
  assert.ok(probe.requestedNamespaces.includes(undefined));
});

test("inline capture accepts corrected metadata after queuing a validation failure", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = "Corrected metadata must not be suppressed by an earlier review.";
  const invalid = await probe.processor.process({
    captureMode: "hybrid",
    dedupeKeys: ["invalid-delivery"],
    content: ["<memory_note>", `content: ${content}`, "category: fact", "confidence: abc", "</memory_note>"].join("\n"),
  });
  const corrected = await probe.processor.process({
    captureMode: "hybrid",
    dedupeKeys: ["corrected-delivery"],
    content: ["<memory_note>", `content: ${content}`, "category: fact", "confidence: 0.8", "</memory_note>"].join("\n"),
  });

  assert.equal(invalid.queued, 1);
  assert.equal(corrected.accepted, 1);
  assert.equal(probe.envelopes.length, 2);
});

test("inline capture processes a corrected sibling after queuing invalid metadata", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = "A corrected sibling must survive the invalid review fallback.";
  const result = await probe.processor.process({
    captureMode: "hybrid",
    dedupeKeys: ["shared-delivery"],
    content: [
      "<memory_note>",
      `content: ${content}`,
      "category: fact",
      "confidence: invalid",
      "</memory_note>",
      "<memory_note>",
      `content: ${content}`,
      "category: fact",
      "confidence: 0.8",
      "</memory_note>",
    ].join("\n"),
  });

  assert.equal(result.queued, 1);
  assert.equal(result.accepted, 1);
  assert.equal(probe.envelopes.length, 2);
});

test("inline capture deduplicates an invalid review replay", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const request = {
    captureMode: "hybrid" as const,
    dedupeKeys: ["invalid-review-delivery"],
    content: [
      "<memory_note>",
      "content: An invalid review replay should queue only once.",
      "category: fact",
      "confidence: invalid",
      "</memory_note>",
    ].join("\n"),
  };

  const first = await probe.processor.process(request);
  const replay = await probe.processor.process(request);

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("explicit capture preserves tombstone-blocked status for duplicate pending review rows", async () => {
  const probe = createInlineCaptureProcessorProbe({
    tombstoneBlocked: true,
    authoritativeFactHashMiss: true,
  });
  const candidate = validateExplicitCaptureInput({
    content: "A duplicate pending review capture must remain queued.",
    category: "fact",
  });

  const first = await persistExplicitCapture(probe.orchestrator, candidate, "memory_store");

  const duplicate = await persistExplicitCapture(probe.orchestrator, candidate, "memory_store");

  assert.equal(first.tombstoneBlocked, true);
  assert.equal(duplicate.duplicateOf, first.id);
  assert.equal(duplicate.tombstoneBlocked, true);
  assert.equal(probe.envelopes.length, 1);
});

test("explicit capture confirms blocked duplicates in the cold tier", async () => {
  const probe = createInlineCaptureProcessorProbe({
    tombstoneBlocked: true,
    authoritativeFactHashMiss: true,
  });
  const candidate = validateExplicitCaptureInput({
    content: "A cold blocked capture must still deduplicate.",
    category: "fact",
  });

  const first = await persistExplicitCapture(probe.orchestrator, candidate, "memory_store");
  const cold = probe.memories.shift();
  if (!cold) throw new Error("expected the first capture to persist");
  probe.coldMemories.push(cold);
  const duplicate = await persistExplicitCapture(probe.orchestrator, candidate, "memory_store");

  assert.equal(duplicate.duplicateOf, first.id);
  assert.equal(duplicate.tombstoneBlocked, true);
  assert.equal(probe.envelopes.length, 1);
});

test("explicit capture keeps the authoritative fact-hash miss fast path", async () => {
  const probe = createInlineCaptureProcessorProbe({
    authoritativeFactHashMiss: true,
    tombstoneBlockedCaptureIndexHit: false,
  });
  const candidate = validateExplicitCaptureInput({
    content: "A novel fact should not scan the corpus after an indexed miss.",
    category: "fact",
  });

  const result = await persistExplicitCapture(probe.orchestrator, candidate, "memory_store");

  assert.equal(result.duplicateOf, undefined);
  assert.deepEqual(probe.blockedIndexArguments(), [
    {
      content: candidate.content,
      category: "fact",
      sourceConnector: undefined,
    },
  ]);
  assert.equal(probe.envelopes.length, 1);
  assert.equal(probe.readAllCalls(), 0);
});
