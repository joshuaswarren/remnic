import test from "node:test";
import assert from "node:assert/strict";
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


/**
 * Regression test for: memory_store not triggering QMD sync after write.
 *
 * The bug: QmdClient.update() and embed() did not pass `-c <collection>`,
 * and memory_store never called update()/embed() after writing a file,
 * so new memories were never indexed and never searchable.
 */

test("QmdClient.update() passes collection flag to qmd subprocess", async () => {
  // We can't easily run the real qmd binary in tests, so we verify the
  // source code contains the collection-scoped flags.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const qmdSource = readFileSync(
    resolve(import.meta.dirname, "..", "packages", "remnic-core", "src", "qmd.ts"),
    "utf-8",
  );

  // update() should route through collection-aware update path
  assert.match(
    qmdSource,
    /async update\(execution\?: SearchExecutionOptions\): Promise<void>\s*\{\s*await this\.runUpdateForCollection\(\s*this\.collection,\s*\{\s*perCollectionThrottle:\s*false\s*\},\s*execution\?\.signal,?\s*\);/s,
    "update() should route through runUpdateForCollection(this.collection)",
  );

  // runUpdateForCollection() must still pass -c collection to qmd
  assert.match(
    qmdSource,
    /runQmd(?:Command)?\(\["update",\s*"-c",\s*name\]/,
    "runUpdateForCollection() should pass -c name to scope updates to the target collection",
  );

  // embed() must route through the collection-aware helper.
  assert.match(
    qmdSource,
    /async embed\(\): Promise<void>\s*\{\s*await this\.runEmbedForCollection\(this\.collection,\s*\{\s*perCollectionThrottle:\s*false\s*\}\);/s,
    "embed() should route through runEmbedForCollection(this.collection)",
  );

  assert.match(
    qmdSource,
    /await this\.runQmdCommand\(this\.buildEmbedArgs\(name\),\s*300_000\);/,
    "runEmbedForCollection() should build embed args from the target collection name",
  );

  assert.match(
    qmdSource,
    /private buildEmbedArgs\(collection: string,\s*force = false\): string\[\]\s*\{\s*const args = \["embed"\];[\s\S]*?args\.push\("-c",\s*collection\);/,
    "buildEmbedArgs() should pass -c collection to scope embedding to the target collection",
  );
});

test("memory_store queues orchestrator-maintained QMD sync after write", async () => {
  type RegisteredTool = {
    name: string;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
  };
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool(
      spec: {
        name: string;
        label: string;
        description: string;
        parameters: unknown;
        execute: (
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: undefined }>;
      },
      _options: { name: string },
    ) {
      tools.set(spec.name, { name: spec.name, execute: spec.execute });
    },
  };

  const writeCalls: Array<{ category: string; content: string }> = [];
  let maintenanceRequests = 0;
  let lifecycleEvents = 0;
  const orchestrator = {
    config: {
      defaultNamespace: "default",
      sharedNamespace: "shared",
      feedbackEnabled: false,
      namespacesEnabled: false,
    },
    getStorage: async () => withSealedWrite({
      readAllMemories: async () => [],
      writeMemory: async (category: string, content: string) => {
        writeCalls.push({ category, content });
        return { id: "fact-test-1", tombstoneBlocked: false };
      },
      appendMemoryLifecycleEvents: async (events: unknown[]) => {
        lifecycleEvents += events.length;
        return events.length;
      },
      getMemoryById: async () => null,
    }),
    requestQmdMaintenanceForTool: (reason: string) => {
      assert.equal(reason, "memory_store");
      maintenanceRequests += 1;
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

  registerTools(api as any, orchestrator as any);

  const memoryStore = tools.get("memory_store");
  assert.ok(memoryStore, "memory_store tool should be registered");

  const out = await memoryStore!.execute("tc-1", {
    content: "Store this durable memory",
  });

  assert.equal(writeCalls.length, 1);
  assert.deepEqual(writeCalls[0], {
    category: "fact",
    content: "Store this durable memory",
  });
  assert.equal(lifecycleEvents, 1);
  assert.equal(maintenanceRequests, 1);
  assert.match(out.content[0].text, /Memory stored: fact-test-1/);
});
