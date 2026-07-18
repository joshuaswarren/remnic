import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import {
  hasInlineExplicitCaptureMarkup,
  parseInlineExplicitCaptureNotes,
  persistExplicitCapture,
  queueExplicitCaptureForReview,
  shouldProcessInlineExplicitCapture,
  shouldSkipImplicitExtraction,
  stripInlineExplicitCaptureNotes,
  validateExplicitCaptureInput,
} from "../src/explicit-capture.js";
import { ContentHashIndex } from "../src/storage.js";
import { Orchestrator } from "../src/orchestrator.js";
import { TurnIngestionCoordinator } from "../packages/remnic-core/src/orchestration/turn-ingestion.js";
import { registerTools } from "../src/tools.js";
import { sealedWriteToLegacyArgs, type SealedMemoryEnvelope } from "../src/write-envelope.js";

// Sealed-write stub fidelity (issue #1989 PR2; AGENTS.md §21): production
// callers now write via `writeSealedMemory`. Test doubles keep stubbing
// `writeMemory`; this decorator adds a sealed entry that delegates through
// the PRODUCTION mapping (`sealedWriteToLegacyArgs`), so mock behavior
// cannot drift from the real envelope→options translation.
function withSealedWrite<T extends { writeMemory: (...args: never[]) => unknown }>(stub: T): T {
  const decorated = stub as T & {
    writeSealedMemory?: (envelope: SealedMemoryEnvelope, extras?: Record<string, unknown>) => unknown;
  };
  decorated.writeSealedMemory = (envelope, extras = {}) => {
    const { category, content, options } = sealedWriteToLegacyArgs(envelope, extras);
    return (stub.writeMemory as (c: unknown, b: unknown, o: unknown) => unknown)(category, content, options);
  };
  return decorated;
}


test("parseConfig defaults captureMode to implicit and accepts explicit modes", () => {
  assert.equal(parseConfig({ openaiApiKey: "sk-test" }).captureMode, "implicit");
  assert.equal(parseConfig({ openaiApiKey: "sk-test", captureMode: "explicit" }).captureMode, "explicit");
  assert.equal(parseConfig({ openaiApiKey: "sk-test", captureMode: "hybrid" }).captureMode, "hybrid");
});

test("processTurn skips buffering when captureMode=explicit", async () => {
  let addTurnCalls = 0;
  const fake = {
    config: { captureMode: "explicit" },
    buffer: {
      addTurn: async () => {
        addTurnCalls += 1;
        return "keep_buffering";
      },
      getTurns: () => [],
    },
    queueBufferedExtraction: async () => undefined,
  };

  await new TurnIngestionCoordinator(fake as any).processTurn("user", "remember this later", "session-1");

  assert.equal(addTurnCalls, 0);
});

test("capture mode helpers distinguish implicit, explicit, and hybrid behavior", () => {
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "implicit" }), false);
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "explicit" }), true);
  assert.equal(shouldProcessInlineExplicitCapture({ captureMode: "hybrid" }), true);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "implicit" }), false);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "hybrid" }), false);
  assert.equal(shouldSkipImplicitExtraction({ captureMode: "explicit" }), true);
});

test("inline explicit capture notes parse and strip cleanly", () => {
  const raw = [
    "Normal text before.",
    "<memory_note>",
    "category: preference",
    "tags: coffee, morning",
    "content: User prefers pourover coffee in the morning.",
    "</memory_note>",
    "Normal text after.",
  ].join("\n");

  const notes = parseInlineExplicitCaptureNotes(raw);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.category, "preference");
  assert.deepEqual(notes[0]?.tags, ["coffee", "morning"]);
  assert.equal(notes[0]?.content, "User prefers pourover coffee in the morning.");
  assert.equal(stripInlineExplicitCaptureNotes(raw), "Normal text before.\n\nNormal text after.");
});

test("inline explicit capture markup is detected even when note blocks are malformed", () => {
  const raw = [
    "Conversation text before.",
    "<memory_note>",
    "category: preference",
    "tags: malformed, ignored",
    "</memory_note>",
    "Conversation text after.",
  ].join("\n");

  const notes = parseInlineExplicitCaptureNotes(raw);
  assert.equal(notes.length, 0);
  assert.equal(hasInlineExplicitCaptureMarkup(raw), true);
  assert.equal(hasInlineExplicitCaptureMarkup(raw), true);
  assert.equal(stripInlineExplicitCaptureNotes(raw), "Conversation text before.\n\nConversation text after.");
});

test("explicit capture validation rejects likely secrets", () => {
  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "api_key=supersecretvalue123 remember this forever",
      }),
    /secret or credential/
  );
});

test("explicit capture validation rejects credential-like metadata", () => {
  const tagName = ["api", "key"].join("_");
  const tagValue = ["tag", "Secret", "12345"].join("");
  const unsafeTag = [tagName, tagValue].join("=");
  for (const [field, input] of [
    ["sourceReason", { sourceReason: "token=sourceReasonSecret12345" }],
    ["entityRef", { entityRef: "secret=entitySecret12345" }],
    ["ttl", { ttl: "password=ttlSecret12345" }],
    ["tags", { tags: ["operator-review", unsafeTag] }],
  ] as const) {
    assert.throws(
      () =>
        validateExplicitCaptureInput({
          content: "This safe explicit capture has unsafe metadata.",
          ...input,
        }),
      new RegExp(`${field} appears to contain a secret or credential`)
    );
  }
});

test("explicit capture validation rejects invalid ttl values before persistence", () => {
  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "This memory should fail validation before any write attempt.",
        ttl: "garbage",
      }),
    /ttl must be an ISO-8601 timestamp or relative duration/
  );
});

test("memory_store can preserve legacy short-content writes while strict explicit capture still rejects them", () => {
  assert.doesNotThrow(() =>
    validateExplicitCaptureInput(
      {
        content: "uses vim",
      },
      "legacy_tool"
    )
  );

  assert.throws(
    () =>
      validateExplicitCaptureInput({
        content: "uses vim",
      }),
    /at least 10 characters/
  );
});

test("persistExplicitCapture writes lifecycle events and dedupes active duplicates", async () => {
  const memories: Array<{
    frontmatter: { id: string; category: string; status?: string };
    content: string;
  }> = [];
  const lifecycleEvents: Array<{ eventType: string; actor: string; memoryId: string }> = [];
  const writeOptions: Array<{ expiresAt?: string }> = [];
  let nextId = 1;

  const storage = {
    hasFactContentHash: async () => memories.length > 0,
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { expiresAt?: string }) => {
      const id = `fact-${nextId++}`;
      writeOptions.push(options);
      memories.push({
        frontmatter: { id, category, status: "active" },
        content,
      });
      return { id: id, tombstoneBlocked: false };
    },
    appendMemoryLifecycleEvents: async (events: Array<{ eventType: string; actor: string; memoryId: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };

  const orchestrator = {
    getStorage: async () => withSealedWrite(storage),
  };

  const first = await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({
      content: "The user prefers concise responses in technical reviews.",
      category: "preference",
      sourceReason: "user-request",
      ttl: "2d",
    }),
    "memory_capture"
  );
  assert.equal(first.duplicateOf, undefined);
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0]?.eventType, "explicit_capture_accepted");
  assert.equal(lifecycleEvents[0]?.actor, "tool.memory_capture");
  assert.equal(typeof writeOptions[0]?.expiresAt, "string");
  assert.ok(Date.parse(writeOptions[0]?.expiresAt ?? "") > Date.now());

  const second = await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({
      content: "The user prefers concise responses in technical reviews.",
      category: "preference",
    }),
    "memory_capture"
  );
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
  assert.equal(lifecycleEvents.length, 1);
});

// ── Round 6 (codex P2 — NAUf4): a DEFAULT explicit capture (no `namespace`)
// resolves `undefined` → writes to the default root, but must STILL record a
// catalog WRITE so the default namespace's `lastWriteAt` is updated for
// `writtenSince`/maintenance consumers. The storage chokepoint fires the
// write touch after writeMemory completes (#1522).
test("persistExplicitCapture records a catalog write for the DEFAULT namespace", async () => {
  let catalogTouched = false;
  const storage = {
    dir: "/synthetic/memory",
    onCatalogWrite: undefined as (() => void) | undefined,
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async () => {
      storage.onCatalogWrite?.();
      return { id: "fact-default", tombstoneBlocked: false };
    },
    appendMemoryLifecycleEvents: async () => 1,
  };
  storage.onCatalogWrite = () => {
    catalogTouched = true;
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacesEnabled: false,
      namespacePolicies: [],
    },
    getStorage: async () => withSealedWrite(storage),
  };

  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({
      content: "A default-namespace explicit capture must still touch the catalog.",
      category: "fact",
    }),
    "memory_capture"
  );

  // #1522: the catalog touch is now handled at the storage chokepoint. The
  // StorageManager's onCatalogWrite hook fires after writeMemory, recording
  // the namespace write automatically.
  assert.equal(catalogTouched, true, "default explicit capture must touch the catalog via the storage chokepoint");
});

function makeDedupFixture() {
  const memories: Array<{
    frontmatter: { id: string; category: string; status?: string; sourceConnector?: string };
    content: string;
  }> = [];
  let nextId = 1;
  const storage = {
    hasFactContentHash: async () => memories.length > 0,
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { sourceConnector?: string }) => {
      const id = `fact-${nextId++}`;
      memories.push({
        frontmatter: {
          id,
          category,
          status: "active",
          sourceConnector: options.sourceConnector,
        },
        content,
      });
      return { id, tombstoneBlocked: false };
    },
    appendMemoryLifecycleEvents: async () => 1,
  };
  return { memories, orchestrator: { getStorage: async () => withSealedWrite(storage) } as never };
}

function dedupCapture(orch: unknown, connector?: string) {
  return persistExplicitCapture(
    orch as never,
    validateExplicitCaptureInput({
      content: "prefers dark mode",
      category: "preference",
      ...(connector !== undefined ? { sourceConnector: connector } : {}),
    }),
    "memory_capture"
  );
}

test("dedup: same content + same connector dedupes", async () => {
  const { memories, orchestrator } = makeDedupFixture();
  const first = await dedupCapture(orchestrator, "chatgpt");
  const second = await dedupCapture(orchestrator, "chatgpt");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
});

test("dedup: same content + different connector does NOT dedupe", async () => {
  const { memories, orchestrator } = makeDedupFixture();
  const first = await dedupCapture(orchestrator, "chatgpt");
  const second = await dedupCapture(orchestrator, "codex-cli");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, undefined);
  assert.equal(memories.length, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(memories[0]?.frontmatter.sourceConnector, "chatgpt");
  assert.equal(memories[1]?.frontmatter.sourceConnector, "codex-cli");
});

test("dedup: connector vs operator does NOT dedupe", async () => {
  const { memories, orchestrator } = makeDedupFixture();
  const first = await dedupCapture(orchestrator, "chatgpt");
  const second = await dedupCapture(orchestrator);
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, undefined);
  assert.equal(memories.length, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(memories[0]?.frontmatter.sourceConnector, "chatgpt");
  assert.equal(memories[1]?.frontmatter.sourceConnector, undefined);
});

test("dedup: operator vs operator dedupes", async () => {
  const { memories, orchestrator } = makeDedupFixture();
  const first = await dedupCapture(orchestrator);
  const second = await dedupCapture(orchestrator);
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
});

test("dedup: whitespace-only connector normalizes to operator", async () => {
  const { memories, orchestrator } = makeDedupFixture();
  const first = await dedupCapture(orchestrator);
  const second = await dedupCapture(orchestrator, "   ");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
});

// QOjlC: queued-review connector-aware dedup matrix
function makeQueueFixture() {
  const memories: Array<{
    frontmatter: { id: string; status?: string; tags?: string[]; sourceConnector?: string };
    content: string;
  }> = [];
  let nextId = 1;
  const storage = {
    readAllMemories: async () => memories,
    getMemoryById: async (id: string) =>
      memories.find((m) => m.frontmatter.id === id) ?? null,
    writeMemory: async (_cat: string, content: string, opts: { sourceConnector?: string }) => {
      const id = `rev-${nextId++}`;
      memories.push({
        frontmatter: {
          id,
          status: "pending_review",
          tags: ["queued-review"],
          sourceConnector: opts.sourceConnector,
        },
        content,
      });
      return { id, tombstoneBlocked: false };
    },
    onCatalogWrite: () => {},
    writeMemoryFrontmatter: async () => {},
    appendMemoryLifecycleEvents: async () => 1,
  };
  return { memories, orchestrator: { getStorage: async () => withSealedWrite(storage) } as never };
}

function queueCapture(orch: unknown, connector?: string) {
  return queueExplicitCaptureForReview(
    orch as never,
    {
      content: "prefers dark mode",
      category: "preference",
      ...(connector !== undefined ? { sourceConnector: connector } : {}),
    } as never,
    "suggestion_submit",
    new Error("test")
  );
}

test("queue dedup: same connector dedupes", async () => {
  const { memories, orchestrator } = makeQueueFixture();
  const first = await queueCapture(orchestrator, "chatgpt");
  const second = await queueCapture(orchestrator, "chatgpt");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
});

test("queue dedup: different connector does NOT dedupe", async () => {
  const { memories, orchestrator } = makeQueueFixture();
  const first = await queueCapture(orchestrator, "chatgpt");
  const second = await queueCapture(orchestrator, "codex-cli");
  assert.equal(first.duplicateOf, undefined);
  assert.equal(second.duplicateOf, undefined);
  assert.equal(memories.length, 2);
  assert.notEqual(first.id, second.id);
  assert.equal(memories[0]?.frontmatter.sourceConnector, "chatgpt");
  assert.equal(memories[1]?.frontmatter.sourceConnector, "codex-cli");
});

test("queue dedup: connector vs operator does NOT dedupe", async () => {
  const { memories, orchestrator } = makeQueueFixture();
  const first = await queueCapture(orchestrator, "chatgpt");
  const second = await queueCapture(orchestrator);
  assert.equal(second.duplicateOf, undefined);
  assert.equal(memories.length, 2);
});

test("queue dedup: operator vs operator dedupes", async () => {
  const { memories, orchestrator } = makeQueueFixture();
  const first = await queueCapture(orchestrator);
  const second = await queueCapture(orchestrator);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(memories.length, 1);
});

// ── Round 6 (codex P2 — NAUf4): the review-queue path has the same default-write
// gap — a queued review capture without a namespace writes to the default root,
// so it must also record a catalog write for the default namespace.
test("queueExplicitCaptureForReview records a catalog write for the DEFAULT namespace", async () => {
  const memories: Array<{ frontmatter: { id: string; status?: string }; content: string; path: string }> = [];
  let catalogTouched = false;
  const storage = {
    dir: "/synthetic/memory",
    onCatalogWrite: undefined as (() => void) | undefined,
    readAllMemories: async () => memories,
    writeMemory: async (_category: string, content: string) => {
      const id = `fact-${memories.length + 1}`;
      memories.push({ frontmatter: { id, status: "active" }, content, path: `/tmp/${id}.md` });
      storage.onCatalogWrite?.();
      return { id: id, tombstoneBlocked: false };
    },
    getMemoryById: async (id: string) => memories.find((m) => m.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (memory: { frontmatter: { status?: string } }, patch: { status: string }) => {
      memory.frontmatter.status = patch.status;
      return memory;
    },
    appendMemoryLifecycleEvents: async () => 1,
  };
  storage.onCatalogWrite = () => {
    catalogTouched = true;
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacesEnabled: false,
      namespacePolicies: [],
    },
    getStorage: async () => withSealedWrite(storage),
  };

  await queueExplicitCaptureForReview(
    orchestrator as never,
    {
      content: "A queued default-namespace review capture must touch the catalog too.",
      category: "fact",
      tags: ["operator-review"],
    },
    "inline",
    new Error("queued for review")
  );

  // #1522: the catalog touch fires at the storage chokepoint after writeMemory.
  assert.equal(catalogTouched, true, "queued default review capture must touch the catalog via the storage chokepoint");
});

// NIhUg follow-up: once writeMemory returns an id, the queued review memory is
// durable even if the pending_review frontmatter update later fails. The catalog
// must still record the write so writtenSince/QMD maintenance can find the root.
test("queueExplicitCaptureForReview records a catalog write when a post-write frontmatter update fails", async () => {
  const memories: Array<{ frontmatter: { id: string; status?: string }; content: string; path: string }> = [];
  let catalogTouched = false;
  const storage = {
    dir: "/synthetic/team",
    onCatalogWrite: undefined as (() => void) | undefined,
    readAllMemories: async () => memories,
    writeMemory: async (_category: string, content: string) => {
      const id = `fact-${memories.length + 1}`;
      memories.push({ frontmatter: { id, status: "active" }, content, path: `/tmp/${id}.md` });
      storage.onCatalogWrite?.();
      return { id: id, tombstoneBlocked: false };
    },
    getMemoryById: async (id: string) => memories.find((m) => m.frontmatter.id === id) ?? null,
    // The pending_review frontmatter update fails after writeMemory has already
    // created a durable memory.
    writeMemoryFrontmatter: async () => {
      throw new Error("frontmatter write failed");
    },
    appendMemoryLifecycleEvents: async () => 1,
  };
  storage.onCatalogWrite = () => {
    catalogTouched = true;
  };
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      namespacesEnabled: true,
      namespacePolicies: [{ name: "team" }],
    },
    getStorage: async () => withSealedWrite(storage),
  };

  await assert.rejects(
    () =>
      queueExplicitCaptureForReview(
        orchestrator as never,
        {
          content: "A queued review capture whose pending_review update fails must still touch the catalog.",
          category: "fact",
          namespace: "team",
          tags: ["operator-review"],
        },
        "inline",
        new Error("queued for review")
      ),
    /frontmatter write failed/
  );

  // #1522: the catalog touch fires at the storage chokepoint during writeMemory,
  // before the pending_review frontmatter update runs — so it is recorded even
  // when the frontmatter write fails.
  assert.equal(
    catalogTouched,
    true,
    "a failed post-write frontmatter update must still touch the catalog via the storage chokepoint"
  );
  assert.equal(memories.length, 1, "precondition: writeMemory created a durable memory before the failure");
});

test("persistExplicitCapture rejects namespaces outside the configured policy", async () => {
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async () => ({ id: "fact-1", tombstoneBlocked: false }),
    appendMemoryLifecycleEvents: async () => 1,
  };

  await assert.rejects(
    () =>
      persistExplicitCapture(
        {
          config: {
            defaultNamespace: "default",
            sharedNamespace: "shared",
            namespacesEnabled: false,
            namespacePolicies: [],
          },
          getStorage: async () => withSealedWrite(storage),
        } as never,
        validateExplicitCaptureInput({
          content: "Store this in a namespace that is not configured.",
          namespace: "team",
        }),
        "memory_capture"
      ),
    /unsupported namespace: team/
  );
});

test("queueExplicitCaptureForReview stores a pending-review memory and lifecycle event", async () => {
  const memories: Array<{
    frontmatter: { id: string; status?: string; tags?: string[]; category?: string };
    content: string;
    path: string;
  }> = [];
  const lifecycleEvents: Array<{ eventType: string; reasonCode?: string; memoryId: string }> = [];
  let nextId = 1;
  const storage = {
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { tags?: string[] }) => {
      const id = `fact-${nextId++}`;
      memories.push({
        frontmatter: { id, category, tags: options.tags, status: "active" },
        content,
        path: `/tmp/${id}.md`,
      });
      return { id: id, tombstoneBlocked: false };
    },
    getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (memory: { frontmatter: { status?: string } }, patch: { status: string }) => {
      memory.frontmatter.status = patch.status;
      return memory;
    },
    appendMemoryLifecycleEvents: async (
      events: Array<{ eventType: string; reasonCode?: string; memoryId: string }>
    ) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };

  const queued = await queueExplicitCaptureForReview(
    {
      config: {
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacesEnabled: false,
        namespacePolicies: [],
      },
      getStorage: async () => withSealedWrite(storage),
    } as never,
    {
      content: "api_key=supersecretvalue123 should be reviewed, not dropped",
      category: "fact",
      tags: ["operator-review"],
    },
    "inline",
    new Error("content appears to contain a secret or credential")
  );

  assert.equal(queued.duplicateOf, undefined);
  assert.equal(memories.length, 1);
  assert.equal(memories[0]?.frontmatter.status, "pending_review");
  assert.deepEqual(memories[0]?.frontmatter.tags, ["explicit-capture", "queued-review", "operator-review"]);
  assert.match(memories[0]?.content ?? "", /Explicit capture queued for review/);
  assert.doesNotMatch(memories[0]?.content ?? "", /supersecretvalue123/);
  assert.match(memories[0]?.content ?? "", /\[redacted credential\]/);
  assert.equal(
    lifecycleEvents.some((event) => event.eventType === "explicit_capture_queued"),
    true
  );
});

test("queueExplicitCaptureForReview redacts credential-like review metadata", async () => {
  const tagName = ["api", "key"].join("_");
  const tagValue = ["tag", "Secret", "12345"].join("");
  const unsafeTag = [tagName, tagValue].join("=");
  const memories: Array<{
    frontmatter: { id: string; status?: string; tags?: string[]; category?: string; entityRef?: string };
    content: string;
    path: string;
  }> = [];
  const frontmatterReasons: string[] = [];
  const lifecycleReasons: string[] = [];
  const storage = {
    readAllMemories: async () => memories,
    writeMemory: async (category: string, content: string, options: { tags?: string[]; entityRef?: string }) => {
      memories.push({
        frontmatter: {
          id: "fact-1",
          category,
          tags: options.tags,
          entityRef: options.entityRef,
          status: "active",
        },
        content,
        path: "/tmp/fact-1.md",
      });
      return { id: "fact-1", tombstoneBlocked: false };
    },
    getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
    writeMemoryFrontmatter: async (
      memory: { frontmatter: { status?: string } },
      patch: { status: string },
      options: { reasonCode?: string }
    ) => {
      memory.frontmatter.status = patch.status;
      frontmatterReasons.push(options.reasonCode ?? "");
      return memory;
    },
    appendMemoryLifecycleEvents: async (events: Array<{ reasonCode?: string }>) => {
      lifecycleReasons.push(...events.map((event) => event.reasonCode ?? ""));
      return events.length;
    },
  };

  await queueExplicitCaptureForReview(
    {
      config: {
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacesEnabled: false,
        namespacePolicies: [],
      },
      getStorage: async () => withSealedWrite(storage),
    } as never,
    {
      content: "This safe explicit capture should be queued for manual review.",
      category: "fact",
      tags: ["operator-review", unsafeTag],
      entityRef: "secret=entitySecret12345",
      ttl: "password=ttlSecret12345",
      sourceReason: "token=sourceReasonSecret12345",
    },
    "memory_capture",
    new Error("Bearer abcdefghijklmnop")
  );

  assert.equal(memories.length, 1);
  const persisted = [
    memories[0]?.content ?? "",
    ...(memories[0]?.frontmatter.tags ?? []),
    memories[0]?.frontmatter.entityRef ?? "",
    ...frontmatterReasons,
    ...lifecycleReasons,
  ].join("\n");

  for (const secret of [
    "tagSecret12345",
    "entitySecret12345",
    "ttlSecret12345",
    "sourceReasonSecret12345",
    "abcdefghijklmnop",
  ]) {
    assert.equal(persisted.includes(secret), false, `review record leaked ${secret}`);
  }
  assert.match(memories[0]?.content ?? "", /Reason: Bearer \[redacted token\]/);
  assert.match(memories[0]?.content ?? "", /Requested sourceReason: \[redacted credential\]/);
  assert.match(memories[0]?.content ?? "", /Requested ttl: \[redacted credential\]/);
  assert.deepEqual(memories[0]?.frontmatter.tags, [
    "explicit-capture",
    "queued-review",
    "operator-review",
    "[redacted credential]",
  ]);
  assert.equal(memories[0]?.frontmatter.entityRef, "[redacted credential]");
  assert.deepEqual(frontmatterReasons, ["Bearer [redacted token]"]);
  assert.deepEqual(lifecycleReasons, ["Bearer [redacted token]"]);
});

test("queueExplicitCaptureForReview preserves requested namespace isolation when namespaces are enabled", async () => {
  const requestedNamespaces: string[] = [];
  const storage = {
    readAllMemories: async () => [],
    writeMemory: async () => ({ id: "fact-1", tombstoneBlocked: false }),
    getMemoryById: async () => ({
      frontmatter: { id: "fact-1", status: "active" },
      content: "queued review item",
      path: "/tmp/fact-1.md",
    }),
    writeMemoryFrontmatter: async () => undefined,
    appendMemoryLifecycleEvents: async () => 1,
  };

  await assert.rejects(
    () =>
      queueExplicitCaptureForReview(
        {
          config: {
            defaultNamespace: "default",
            sharedNamespace: "shared",
            namespacesEnabled: true,
            namespacePolicies: [],
          },
          getStorage: async (namespace?: string) => {
            requestedNamespaces.push(namespace ?? "default");
            return withSealedWrite(storage);
          },
        } as never,
        {
          content: "This explicit note targeted a private namespace and should stay isolated while queued.",
          category: "fact",
          namespace: "team",
        },
        "inline",
        new Error("unsupported namespace: team")
      ),
    /unsupported namespace: team/
  );

  // Security fix: rejected namespace now throws instead of silently
  // falling back to the default namespace, preserving isolation.
  assert.deepEqual(requestedNamespaces, []);
});

test("persistExplicitCapture attributes lifecycle actors to the correct tool source", async () => {
  const lifecycleEvents: Array<{ actor: string; memoryId: string }> = [];
  const sources: string[] = [];
  let nextId = 1;
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async (_category: string, _content: string, options: { source?: string }) => {
      sources.push(options.source ?? "");
      return { id: `fact-${nextId++}`, tombstoneBlocked: false };
    },
    appendMemoryLifecycleEvents: async (events: Array<{ actor: string; memoryId: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };
  const orchestrator = { getStorage: async () => withSealedWrite(storage) };

  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({ content: "Store this using the memory_store tool path." }),
    "memory_store"
  );
  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({ content: "Store this using the memory_capture tool path." }),
    "memory_capture"
  );
  await persistExplicitCapture(
    orchestrator as never,
    validateExplicitCaptureInput({ content: "Store this using the suggestion_submit tool path." }),
    "suggestion_submit"
  );

  assert.deepEqual(
    lifecycleEvents.map((event) => event.actor),
    ["tool.memory_store", "tool.memory_capture", "tool.suggestion_submit"]
  );
  assert.deepEqual(sources, ["explicit", "explicit", "explicit"]);
});

test("queueExplicitCaptureForReview attributes queued suggestion submissions to suggestion_submit", async () => {
  const lifecycleEvents: Array<{ actor: string; eventType: string }> = [];
  const frontmatterActors: string[] = [];
  const storage = {
    readAllMemories: async () => [],
    writeMemory: async () => ({ id: "fact-1", tombstoneBlocked: false }),
    getMemoryById: async () => ({
      frontmatter: { id: "fact-1", status: "active" },
      content: "queued review item",
      path: "/tmp/fact-1.md",
    }),
    writeMemoryFrontmatter: async (
      _memory: { frontmatter: { status?: string } },
      _patch: { status: string; updated: string },
      options: { actor?: string }
    ) => {
      frontmatterActors.push(options.actor ?? "");
      return undefined;
    },
    appendMemoryLifecycleEvents: async (events: Array<{ actor: string; eventType: string }>) => {
      lifecycleEvents.push(...events);
      return events.length;
    },
  };

  await queueExplicitCaptureForReview(
    {
      config: {
        defaultNamespace: "default",
        sharedNamespace: "shared",
        namespacesEnabled: false,
        namespacePolicies: [],
      },
      getStorage: async () => withSealedWrite(storage),
    } as never,
    {
      content: "Queue this suggestion submission for review with the correct actor attribution.",
      category: "fact",
    },
    "suggestion_submit",
    new Error("submitted via engram suggestion_submit")
  );

  assert.deepEqual(frontmatterActors, ["tool.suggestion_submit"]);
  assert.deepEqual(
    lifecycleEvents.map((event) => event.actor),
    ["tool.suggestion_submit"]
  );
  assert.deepEqual(
    lifecycleEvents.map((event) => event.eventType),
    ["explicit_capture_queued"]
  );
});

test("fact duplicate checks short-circuit without a full corpus scan when authoritative hash index misses", async () => {
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [],
    writeMemory: async () => ({ id: "fact-1", tombstoneBlocked: false }),
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => withSealedWrite(storage) } as never,
    validateExplicitCaptureInput({
      content: "This fact should miss the hash gate and skip the full scan.",
      category: "fact",
    }),
    "memory_capture"
  );

  assert.equal(duplicate.duplicateOf, undefined);
  assert.equal(duplicate.id, "fact-1");
});

test("fact duplicate checks fall back to the full corpus scan when hash index coverage is not authoritative", async () => {
  let readAllMemoriesCalls = 0;
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => false,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [
        {
          frontmatter: { id: "fact-legacy", category: "fact", status: "active" },
          content: "Legacy fact content that predates the hash index.",
        },
      ];
    },
    writeMemory: async () => ({ id: "fact-should-not-write", tombstoneBlocked: false }),
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => withSealedWrite(storage) } as never,
    validateExplicitCaptureInput({
      content: "Legacy fact content that predates the hash index.",
      category: "fact",
    }),
    "memory_capture"
  );

  assert.equal(duplicate.duplicateOf, "fact-legacy");
  assert.equal(readAllMemoriesCalls, 1);
});

test("fact duplicate checks fail open to the full corpus scan when hash index access throws", async () => {
  let readAllMemoriesCalls = 0;
  const storage = {
    hasFactContentHash: async () => {
      throw new Error("transient hash index failure");
    },
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => {
      readAllMemoriesCalls += 1;
      return [
        {
          frontmatter: { id: "fact-legacy", category: "fact", status: "active" },
          content: "Legacy fact content that predates the hash index.",
        },
      ];
    },
    writeMemory: async () => ({ id: "fact-should-not-write", tombstoneBlocked: false }),
    appendMemoryLifecycleEvents: async () => 1,
  };

  const duplicate = await persistExplicitCapture(
    { getStorage: async () => withSealedWrite(storage) } as never,
    validateExplicitCaptureInput({
      content: "Legacy fact content that predates the hash index.",
      category: "fact",
    }),
    "memory_capture"
  );

  assert.equal(duplicate.duplicateOf, "fact-legacy");
  assert.equal(readAllMemoriesCalls, 1);
});

test("explicit capture duplicate normalization stays aligned with fact hash normalization", () => {
  const a = "User prefers: pourover coffee.";
  const b = "user prefers pourover coffee";
  assert.equal(ContentHashIndex.normalizeContent(a), ContentHashIndex.normalizeContent(b));
});

test("explicit capture duplicate checks preserve punctuation that changes technical meaning", async () => {
  const storage = {
    hasFactContentHash: async () => true,
    isFactContentHashAuthoritative: async () => true,
    readAllMemories: async () => [
      {
        frontmatter: { id: "fact-cpp", category: "fact", status: "active" },
        content: "User prefers C++",
      },
    ],
    writeMemory: async () => ({ id: "fact-c", tombstoneBlocked: false }),
    appendMemoryLifecycleEvents: async () => 1,
  };

  const result = await persistExplicitCapture(
    { getStorage: async () => withSealedWrite(storage) } as never,
    validateExplicitCaptureInput({
      content: "User prefers C",
      category: "fact",
    }),
    "memory_capture"
  );

  assert.equal(result.duplicateOf, undefined);
  assert.equal(result.id, "fact-c");
});

test("memory_store and memory_capture share explicit validation and duplicate handling", async () => {
  type RegisteredTool = {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }) {
      tools.set(spec.name, { execute: spec.execute });
    },
  };

  const memories: Array<{
    path: string;
    content: string;
    frontmatter: { id: string; created: string; tags: string[]; category: string; status?: string };
  }> = [];
  const maintenanceReasons: string[] = [];
  let appendedEvents = 0;
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      feedbackEnabled: false,
      namespacesEnabled: false,
      queryAwareIndexingEnabled: false,
      memoryDir: "/tmp/engram-explicit-tools",
    },
    getStorage: async () => withSealedWrite({
      readAllMemories: async () => memories,
      writeMemory: async (category: string, content: string, options: { tags?: string[] }) => {
        const id = `fact-${memories.length + 1}`;
        memories.push({
          path: `/tmp/${id}.md`,
          content,
          frontmatter: {
            id,
            created: "2026-03-08T00:00:00.000Z",
            tags: options.tags ?? [],
            category,
            status: "active",
          },
        });
        return { id: id, tombstoneBlocked: false };
      },
      getMemoryById: async (id: string) => memories.find((memory) => memory.frontmatter.id === id) ?? null,
      writeMemoryFrontmatter: async (memory: { frontmatter: { status?: string } }, patch: { status: string }) => {
        memory.frontmatter.status = patch.status;
        return memory;
      },
      appendMemoryLifecycleEvents: async (events: unknown[]) => {
        appendedEvents += events.length;
        return events.length;
      },
    }),
    requestQmdMaintenanceForTool: (reason: string) => {
      maintenanceReasons.push(reason);
    },
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    recordMemoryFeedback: async () => {},
    storage: {
      readProfile: async () => "",
      readIdentity: async () => "",
      resolveQuestion: async () => false,
      listQuestions: async () => [],
      getMemoryById: async () => null,
    },
    summarizeNow: async () => undefined,
    runConversationIndexUpdate: async () => ({ indexedSessions: 0, indexedChunks: 0, embeddedRuns: 0 }),
    sharedContext: null,
    compoundingEngine: null,
  };

  registerTools(api as never, orchestrator as never);

  const memoryStore = tools.get("memory_store");
  const memoryCapture = tools.get("memory_capture");
  assert.ok(memoryStore);
  assert.ok(memoryCapture);

  const stored = await memoryStore!.execute("tc-1", {
    content: "Store this durable explicit memory for the plugin.",
    category: "fact",
  });
  assert.match(stored.content[0]?.text ?? "", /Memory stored: fact-1/);
  assert.equal(memories.length, 1);
  assert.equal(appendedEvents, 1);

  const duplicate = await memoryCapture!.execute("tc-2", {
    content: "Store this durable explicit memory for the plugin.",
    category: "fact",
  });
  assert.match(duplicate.content[0]?.text ?? "", /Memory already exists: fact-1/);
  assert.equal(memories.length, 1);
  assert.equal(appendedEvents, 1);
  assert.deepEqual(maintenanceReasons, ["memory_store", "memory_capture"]);

  const queued = await memoryCapture!.execute("tc-3", {
    content: "sk-1234567890abcdef1234567890abcdef should never be stored",
  });
  assert.match(queued.content[0]?.text ?? "", /Memory queued for review: fact-2/);
  assert.equal(memories.length, 2);
  assert.equal(memories[1]?.frontmatter.status, "pending_review");
  assert.equal(appendedEvents, 2);
  assert.deepEqual(maintenanceReasons, ["memory_store", "memory_capture", "memory_capture.review"]);
});

test("memory_capture fails gracefully when review queue fallback also errors", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-explicit-capture-tool-double-fail-"));
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "engram-explicit-capture-tool-double-fail-workspace-"));
  const tools = new Map<
    string,
    {
      execute: (
        toolCallId: string,
        params: Record<string, unknown>
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }
  >();
  const api = {
    registerTool(spec: {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
    }) {
      tools.set(spec.name, { execute: spec.execute });
    },
  };

  const orchestrator = {
    config: {
      defaultNamespace: "default",
      namespacesEnabled: false,
      namespacePolicy: [],
      explicitCaptureEnabled: true,
      captureMode: "explicit",
      queryAwareIndexingEnabled: false,
      memoryDir,
      workspaceDir,
      contextCompressionActionsEnabled: false,
      contextCompressionMaxSummaryChars: 200,
      contextCompressionMaxMemoryIds: 5,
      contextCompressionMaxArtifactNames: 4,
      graphRecallEnabled: false,
      graphShadowEvaluationEnabled: false,
      graphShadowEvalMaxCandidates: 0,
      graphMaxExplainPaths: 0,
      graphExpandedIntentEnabled: false,
      enableTrustZones: false,
      semanticRuleVerificationEnabled: false,
      workArtifactRecallEnabled: false,
      sharedContextEnabled: false,
      localLlmEnabled: false,
      localLlmProvider: "none",
      localLlmTimeoutMs: 0,
      qmdEnabled: false,
    },
    getStorage: async () => withSealedWrite({
      writeMemory: async () => {
        throw new Error("queue storage unavailable");
      },
      readAllMemories: async () => [],
      appendMemoryLifecycleEvents: async () => 0,
    }),
    requestQmdMaintenanceForTool: () => {},
    qmd: {
      search: async () => [],
      searchGlobal: async () => [],
    },
    lastRecall: {
      get: () => null,
      getMostRecent: () => null,
    },
    recordMemoryFeedback: async () => {},
    storage: {
      readProfile: async () => "",
      readIdentity: async () => "",
      resolveQuestion: async () => false,
      listQuestions: async () => [],
      getMemoryById: async () => null,
    },
    summarizeNow: async () => undefined,
    runConversationIndexUpdate: async () => ({ indexedSessions: 0, indexedChunks: 0, embeddedRuns: 0 }),
    sharedContext: null,
    compoundingEngine: null,
  };

  registerTools(api as never, orchestrator as never);
  const memoryCapture = tools.get("memory_capture");
  assert.ok(memoryCapture);

  const result = await memoryCapture!.execute("tc-double-fail", {
    content: "sk-1234567890abcdef1234567890abcdef should never be stored",
  });

  assert.match(
    result.content[0]?.text ?? "",
    /Memory capture failed: content appears to contain a secret or credential/
  );
});

test("review-queue fallback survives 49+ requested tags (salvage clamp, #2014)", async () => {
  const written: Array<{ tags?: readonly string[] }> = [];
  const storage = withSealedWrite({
    writeMemory: async (_c: unknown, _b: unknown, options: { tags?: readonly string[] }) => {
      written.push(options);
      return { id: "fact-review-clamp", tombstoneBlocked: false };
    },
    getMemoryById: async () => null,
    readAllMemories: async () => [],
    writeMemoryFrontmatter: async () => {},
    appendMemoryLifecycleEvents: async () => 1,
  });
  const orchestrator = {
    config: { defaultNamespace: "default", sharedNamespace: "shared", namespacesEnabled: false },
    getStorage: async () => storage,
  };
  const result = await queueExplicitCaptureForReview(
    orchestrator as never,
    {
      content: "capture body that failed primary validation",
      category: "fact",
      tags: Array.from({ length: 55 }, (_, i) => `req-tag-${i}`),
    } as never,
    "duplicate-suspected",
    "tool",
  );
  assert.ok(result.id, "capture must queue instead of throwing");
  assert.equal(written.length, 1);
  assert.ok((written[0].tags?.length ?? 0) <= 50, "tags must be clamped to the limit");
  assert.ok(
    written[0].tags?.includes("explicit-capture") || written[0].tags?.some((t) => t.includes("review")),
    `fixed review tags must survive the clamp, got: ${written[0].tags?.slice(0, 4).join(",")}`,
  );
});
