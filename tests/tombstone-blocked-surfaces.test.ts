import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerTools } from "../src/tools.js";
import { sealedWriteToLegacyArgs, type SealedMemoryEnvelope } from "@remnic/core/write-envelope";

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


/**
 * Issue #1645 — extend the tombstone-blocked guard to the remaining post-write
 * surfaces flagged in review threads TV6 (orchestrator shared/profile-target
 * promotion indexing), TWB/Yhu (memory_promote tool), and Yhp
 * (memory_action_apply tool). A tombstone-blocked write lands pending_review
 * (no active copy); each surface MUST skip active side-effects and report the
 * block honestly instead of claiming a successful active write.
 */

const orchestratorSource = readFileSync(
  resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "orchestration", "extraction-persist.ts"),
  "utf-8",
);

// ── Thread TV6: orchestrator shared/profile-target promotion indexing ───────
// persistExtraction's two promotion closures (profile-target loop and shared
// promotion) must gate trackPersistedId / indexPersistedMemory /
// trackBehaviorSignals behind the promotion's tombstoneBlocked flag — exactly
// like the source-namespace postWriteGuard. This mirrors
// orchestrator-threading-fail-open.test.ts, which pins the #1645 guard on
// threadEpisodeIdsForGraph with the same structural-assertion technique.

test("#1645 TV6: profile-target promotion skips indexing/tracking when tombstone-blocked", () => {
  // Round N+8 moved `writtenCopyIds.push(promotedId)` INSIDE the gate —
  // correct: a blocked promotion is pending_review and must not be reported
  // as a written copy. `[^{}]*` keeps the scan linear (no ReDoS-shaped
  // quantifier chains, issue #2439) while still pinning statement order
  // inside the gated block.
  assert.match(
    orchestratorSource,
    /if \(!targetPromotion\.tombstoneBlocked\) \{[^{}]*writtenCopyIds\.push\(promotedId\);[^{}]*trackPersistedId\(targetStorage, promotedId, \{[^{}]*\}\);[^{}]*await this\.deps\.indexPersistedMemory\(targetStorage, promotedId\);[^{}]*trackBehaviorSignals\([^;]*namespace: target\.namespace,/m,
    "profile-target promotion must gate catalog/index/behavior behind !targetPromotion.tombstoneBlocked",
  );
});
test("#1645 TV6: shared promotion skips indexing/tracking when tombstone-blocked", () => {
  assert.match(
    orchestratorSource,
    /if \(\s*!sharedPromotion\.tombstoneBlocked\s*\)\s*\{\s*trackPersistedId\(sharedStorage,\s*promotedId,\s*\{\s*includeReturnedIds:\s*false,\s*category:\s*options\.category as MemoryCategory,[\s\S]*?\}\);\s*await this\.deps\.indexPersistedMemory\(sharedStorage,\s*promotedId\);\s*trackBehaviorSignals\(\s*sharedStorage,[\s\S]*?namespace:\s*this\.deps\.config\.sharedNamespace,[\s\S]*?\);\s*\}/m,
    "shared promotion must gate catalog/index/behavior behind !sharedPromotion.tombstoneBlocked",
  );
});

// ── Threads TWB/Yhu + Yhp: tool surfaces report blocked writes honestly ─────

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
};

function makeApi() {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(
      spec: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: RegisteredTool["execute"];
      },
      _options: { name: string },
    ) {
      tools.set(spec.name, { name: spec.name, execute: spec.execute });
    },
  };
  return { api, tools };
}

test("#1645 TWB/Yhu: memory_promote surfaces a tombstone-blocked promotion as queued (no indexing)", async () => {
  const { api, tools } = makeApi();
  const recordedEvents: Array<{ outcome: string; reason?: string }> = [];
  // Source namespace holds the memory being promoted; destination blocks it.
  const srcStorage = {
    getMemoryById: async () => ({
      frontmatter: {
        category: "fact",
        confidence: 0.9,
        tags: [],
        entityRef: "ent-1",
        importance: undefined,
        supersedes: undefined,
        links: undefined,
      },
      content: "retired content that matches a tombstone",
    }),
  };
  const dstStorage = withSealedWrite({
    writeMemory: async () => ({ id: "fact-blocked-1", tombstoneBlocked: true, blockedBy: "tomb-7" }),
    getMemoryById: async () => null,
  });
  const orchestrator = {
    config: {
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      memoryDir: "/nonexistent-dir-for-promote-test",
      queryAwareIndexingEnabled: true,
    },
    getStorage: async (ns: string) => (ns === "shared" ? dstStorage : srcStorage),
    // indexMemory is imported at module scope; force indexesExist → false so the
    // blocked early-return is the ONLY thing preventing indexing. We still
    // assert the result is the queued message (the early return ran before any
    // index path could be reached).
  };
  // Stub indexesExist indirectly by pointing memoryDir at a non-existent dir.
  registerTools(api as never, orchestrator as never);

  const promote = tools.get("memory_promote");
  assert.ok(promote, "memory_promote tool should be registered");

  const out = await promote!.execute("tc-promote-blocked", {
    memoryId: "fact-src-1",
    fromNamespace: "default",
    toNamespace: "shared",
  });

  const text = out.content[0].text;
  assert.match(text, /queued for review/i, "blocked promotion must be reported as queued for review");
  assert.match(text, /tombstone-blocked/i, "result must attribute the block to the tombstone");
  assert.match(text, /fact-blocked-1/, "result must carry the pending_review id");
  // recordedEvents untouched: memory_promote does not append action events.
  assert.equal(recordedEvents.length, 0);
});

test("#1645 Yhp: memory_action_apply reports a tombstone-blocked write as queued, not applied", async () => {
  const { api, tools } = makeApi();
  const recordedEvents: Array<{ outcome: string; status?: string; reason?: string; outputMemoryIds?: string[] }> = [];
  const storage = {
    writeMemory: async () => ({ id: "fact-blocked-2", tombstoneBlocked: true, blockedBy: "tomb-9" }),
    readAllMemories: async () => [],
    getMemoryById: async () => null,
  };
  const orchestrator = {
    config: {
      namespacesEnabled: false,
      contextCompressionActionsEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
    },
    getStorage: async () => withSealedWrite(storage),
    previewMemoryActionEvent: (event: { action: string }) => ({
      action: event.action,
      namespace: "default",
      policyDecision: "allow",
      policyRationale: "",
    }),
    appendMemoryActionEvent: async (event: { outcome: string; status?: string; reason?: string; outputMemoryIds?: string[] }) => {
      recordedEvents.push(event);
      return true;
    },
    requestQmdMaintenanceForTool: () => {},
    storage,
  };

  registerTools(api as never, orchestrator as never);
  const apply = tools.get("memory_action_apply");
  assert.ok(apply, "memory_action_apply tool should be registered");

  const out = await apply!.execute("tc-action-blocked", {
    action: "store_note",
    content: "retired content matching a tombstone",
  });

  const text = out.content[0].text;
  assert.match(text, /queued for review/i, "blocked action write must be reported as queued for review");
  assert.match(text, /tombstone-blocked/i, "result must attribute the block to the tombstone");

  // The telemetry event MUST NOT claim a successful active application.
  assert.equal(recordedEvents.length, 1, "exactly one action event should be appended");
  assert.equal(recordedEvents[0].outcome, "skipped", "a tombstone-blocked write is outcome 'skipped', not 'applied'");
  assert.equal(recordedEvents[0].status, "rejected", "#1645 yGr: a tombstone-blocked write is status 'rejected', not 'applied'");
  assert.match(
    recordedEvents[0].reason ?? "",
    /tombstone-blocked/,
    "event reason must explain the tombstone block",
  );
  assert.deepEqual(recordedEvents[0].outputMemoryIds, ["fact-blocked-2"], "pending_review id is still recorded");
});

test("#1645 yG-: memory_store surfaces a tombstone-blocked capture as queued for review", async () => {
  type RegisteredTool = {
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(spec: { name: string; execute: RegisteredTool["execute"] }) {
      tools.set(spec.name, { execute: spec.execute });
    },
  };
  const maintenanceReasons: string[] = [];
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      feedbackEnabled: false,
      namespacesEnabled: false,
      queryAwareIndexingEnabled: true,
      memoryDir: "/nonexistent-dir-for-store-test",
    },
    getStorage: async () => withSealedWrite({
      readAllMemories: async () => [],
      // Destination tombstone blocks the explicit capture (pending_review).
      writeMemory: async (_category: string, content: string) => ({
        id: "fact-blocked-store",
        tombstoneBlocked: true,
        blockedBy: "tomb-store",
      }),
      getMemoryById: async () => null,
      appendMemoryLifecycleEvents: async (events: unknown[]) => events.length,
    }),
    requestQmdMaintenanceForTool: (reason: string) => {
      maintenanceReasons.push(reason);
    },
    qmd: { search: async () => [], searchGlobal: async () => [] },
    lastRecall: { get: () => null, getMostRecent: () => null },
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
  assert.ok(memoryStore, "memory_store tool should be registered");

  const out = await memoryStore!.execute("tc-store-blocked", {
    content: "retired content that matches a tombstone",
    category: "fact",
  });

  const text = out.content[0].text;
  assert.match(text, /queued for review/i, "blocked capture must be reported as queued for review");
  assert.match(text, /tombstone-blocked/i, "result must attribute the block to the tombstone");
  assert.match(text, /fact-blocked-store/, "result must carry the pending_review id");
  // The tool must NOT claim a successful active store.
  assert.doesNotMatch(text, /Memory stored:/, "a blocked capture must not be reported as 'Memory stored'");
});

test("#1645 yG-: persistExplicitCapture surfaces tombstoneBlocked in its result", async () => {
  const { persistExplicitCapture, validateExplicitCaptureInput } = await import("../src/explicit-capture.js");
  const storage = {
    hasFactContentHash: async () => false,
    isFactContentHashAuthoritative: async () => false,
    readAllMemories: async () => [],
    writeMemory: async () => ({ id: "fact-blocked-persist", tombstoneBlocked: true, blockedBy: "tomb-p" }),
    appendMemoryLifecycleEvents: async () => 1,
  };
  const result = await persistExplicitCapture(
    { getStorage: async () => withSealedWrite(storage) } as never,
    validateExplicitCaptureInput({ content: "retired content", category: "fact" }),
    "memory_store",
  );
  assert.equal(result.tombstoneBlocked, true, "persistExplicitCapture must surface tombstoneBlocked");
  assert.equal(result.id, "fact-blocked-persist");
});

// ── Thread P-J: orchestrator extraction path gates embedding-fallback index ─
// persistExtraction's non-chunked and chunked write branches both call
// indexPersistedMemory AFTER computing postWriteGuard. A tombstone-blocked /
// pending_review fact that enters the embedding-fallback index resurfaces in
// embedding recall (resurrection). Both branches — and the chunk-id catch loop
// — must gate indexPersistedMemory behind !postWriteGuard, exactly like the
// surrounding supersession / promotion / graph / artifact paths. This mirrors
// the structural-assertion technique used by the TV6 tests above.

test("#1645 P-J: non-chunked extraction gates indexPersistedMemory on postWriteGuard", () => {
  assert.match(
    orchestratorSource,
    /if \(!postWriteGuard\) \{\s*await this\.deps\.indexPersistedMemory\(targetStorage, memoryId\);\s*\}/m,
    "non-chunked extraction must gate indexPersistedMemory(targetStorage, memoryId) behind !postWriteGuard so a blocked fact never enters the embedding-fallback index",
  );
});

test("#1645 P-J: chunked extraction gates indexPersistedMemory on postWriteGuard", () => {
  assert.match(
    orchestratorSource,
    /if \(!postWriteGuard\) \{\s*await this\.deps\.indexPersistedMemory\(targetStorage, parentId\);\s*\}/m,
    "chunked extraction must gate indexPersistedMemory(targetStorage, parentId) behind !postWriteGuard",
  );
});

test("#1645 P-J: chunk-id embedding sync is gated on postWriteGuard", () => {
  assert.match(
    orchestratorSource,
    /if \(!postWriteGuard\) \{\s*await this\.deps\.indexPersistedMemory\(targetStorage, chunkId\);\s*\}/m,
    "chunk-id embedding-fallback sync must be gated behind !postWriteGuard (chunks inherit pending_review)",
  );
});
