import assert from "node:assert/strict";
import test from "node:test";

import type { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";
import type { SealedMemoryEnvelope } from "./write-envelope.js";
import {
  InlineExplicitCaptureProcessor,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
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
      `${confidenceLine} should be rejected`,
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
  options: { tombstoneBlocked?: boolean; authoritativeFactHashMiss?: boolean } = {},
) {
  const envelopes: SealedMemoryEnvelope[] = [];
  const lifecycleEvents: Array<{ eventType: string; actor: string }> = [];
  const maintenanceReasons: string[] = [];
  const requestedNamespaces: Array<string | undefined> = [];
  const memories: StoredMemory[] = [];
  let nextId = 1;
  const storage = {
    readAllMemories: async () => memories,
    writeSealedMemory: async (envelope: SealedMemoryEnvelope) => {
      const id = `memory-${nextId++}`;
      envelopes.push(envelope);
      memories.push({
        frontmatter: {
          id,
          category: envelope.category,
          ...(options.tombstoneBlocked
            ? { status: "pending_review", blockedBy: "tombstone-1" }
            : {}),
          tags: [...envelope.tags],
          sourceConnector: envelope.sourceConnector,
        },
        content: envelope.content,
      });
      return { id, tombstoneBlocked: options.tombstoneBlocked === true };
    },
    ...(options.authoritativeFactHashMiss
      ? {
          hasFactContentHash: async () => false,
          isFactContentHashAuthoritative: () => true,
        }
      : {}),
    appendMemoryLifecycleEvents: async (events: Array<{ eventType: string; actor: string }>) => {
      lifecycleEvents.push(...events);
    },
    getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (
      memory: StoredMemory,
      update: { status?: string },
    ) => {
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
  assert.deepEqual(probe.requestedNamespaces, ["principal-project", "principal-project"]);
  assert.deepEqual(probe.maintenanceReasons, ["inline.memory_note"]);
  assert.equal(probe.lifecycleEvents[0]?.eventType, "explicit_capture_accepted");
  assert.equal(probe.lifecycleEvents[0]?.actor, "inline.memory_note");
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
    /namespacePreResolved requires a resolved namespace/,
  );
  assert.equal(probe.envelopes.length, 0);
});

test("inline capture processor bounds non-finite dedupe limits", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const processor = new InlineExplicitCaptureProcessor(probe.orchestrator, {
    maxDedupeKeys: Number.POSITIVE_INFINITY,
    sourceConnector: "openclaw",
  });
  const contentFor = (index: number) => [
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

test("inline capture processor keeps canonical fallback identity across delivery keys", async () => {
  const probe = createInlineCaptureProcessorProbe({ tombstoneBlocked: true });
  const first = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: A canonical fallback identity must survive delivery changes.",
      "category: fact",
      "tags: original-tag",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["first-delivery"],
  });
  const replay = await probe.processor.process({
    captureMode: "hybrid",
    content: [
      "<memory_note>",
      "content: a canonical  fallback identity must survive DELIVERY changes.",
      "category: fact",
      "tags: replay-tag",
      "</memory_note>",
    ].join("\n"),
    dedupeKeys: ["second-delivery"],
  });

  assert.equal(first.queued, 1);
  assert.equal(replay.processed, 0);
  assert.equal(probe.envelopes.length, 1);
});

test("inline capture processor queues complete notes with empty content", async () => {
  for (const noteFields of [
    ["category: fact"],
    ["content: |", "category: fact"],
  ]) {
    const probe = createInlineCaptureProcessorProbe();
    const result = await probe.processor.process({
      captureMode: "hybrid",
      content: [
        "Keep this visible text.",
        "<memory_note>",
        ...noteFields,
        "</memory_note>",
      ].join("\n"),
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

test("inline capture scopes unsupported namespace review replay to the authorized review namespace", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const request = {
    captureMode: "hybrid" as const,
    content: [
      "<memory_note>",
      "content: A safe unsupported namespace needs an isolated review replay.",
      "category: fact",
      "namespace: unconfigured-inline",
      "</memory_note>",
    ].join("\n"),
  };

  const first = await probe.processor.process({
    ...request,
    reviewNamespace: "review-one",
    reviewNamespacePreResolved: true,
  });
  const second = await probe.processor.process({
    ...request,
    reviewNamespace: "review-two",
    reviewNamespacePreResolved: true,
  });

  assert.equal(first.queued, 1);
  assert.equal(second.processed, 1);
  assert.equal(second.duplicates, 1);
  assert.ok(probe.requestedNamespaces.includes("review-one"));
  assert.ok(probe.requestedNamespaces.includes("review-two"));
});

test("inline capture accepts corrected metadata after queuing a validation failure", async () => {
  const probe = createInlineCaptureProcessorProbe();
  const content = "Corrected metadata must not be suppressed by an earlier review.";
  const invalid = await probe.processor.process({
    captureMode: "hybrid",
    dedupeKeys: ["invalid-delivery"],
    content: [
      "<memory_note>",
      `content: ${content}`,
      "category: fact",
      "confidence: abc",
      "</memory_note>",
    ].join("\n"),
  });
  const corrected = await probe.processor.process({
    captureMode: "hybrid",
    dedupeKeys: ["corrected-delivery"],
    content: [
      "<memory_note>",
      `content: ${content}`,
      "category: fact",
      "confidence: 0.8",
      "</memory_note>",
    ].join("\n"),
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
