import assert from "node:assert/strict";
import test from "node:test";

import type { Orchestrator } from "./orchestrator.js";
import type { PluginConfig } from "./types.js";
import type { SealedMemoryEnvelope } from "./write-envelope.js";
import {
  InlineExplicitCaptureProcessor,
  parseInlineExplicitCaptureNotes,
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
  };
  content: string;
};

function createInlineCaptureProcessorProbe() {
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
          tags: [...envelope.tags],
          sourceConnector: envelope.sourceConnector,
        },
        content: envelope.content,
      });
      return { id };
    },
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
