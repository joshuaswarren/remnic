/**
 * #3082: recall must distinguish a QMD daemon timeout from a genuine
 * empty retrieval. Internally the pipeline already collected the
 * degradation; this file asserts it is no longer flattened away by
 * the time it reaches orchestrator.recall / EngramAccessService.recall
 * / the MCP tool payload.
 *
 * Fixture data is synthetic and the store is an empty temp directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramMcpServer } from "./access-mcp.js";
import { EngramAccessService } from "./access-service.js";
import type { EngramAccessRecallRequest, EngramAccessRecallResponse } from "./access-service.js";
import { parseConfig } from "./config.js";
import { Orchestrator } from "./orchestrator.js";
import { resolveScopePlan } from "./scopes/scope-plan.js";
import {
  MEMORY_CONTEXT_UNAVAILABLE_NOTE,
  type RecallContextComposition,
} from "./recall-context-composition.js";
import type { SearchBackend, SearchDegradation, SearchExecutionOptions } from "./search/port.js";
import { DEFAULT_RECALL_DISCLOSURE, type PluginConfig } from "./types.js";

const TIMEOUT_DEGRADATION: SearchDegradation = {
  backend: "qmd",
  code: "daemon_timeout",
  detail: "no response within the deadline",
};

const QUERY = "what writing rules apply here?";

function searchBackend(
  observed: { calls: number },
  degrade: boolean,
  onSearch?: () => Promise<void>,
): SearchBackend {
  const search = async (execution?: SearchExecutionOptions) => {
    observed.calls += 1;
    if (degrade) execution?.onDegradation?.(TIMEOUT_DEGRADATION);
    await onSearch?.();
    return [];
  };
  const backend: Partial<SearchBackend> = {
    async probe() {
      return true;
    },
    isAvailable() {
      return true;
    },
    debugStatus() {
      return degrade ? "backend=timeout-stub" : "backend=empty-stub";
    },
    async search(_query, _collection, _maxResults, _options, execution) {
      return search(execution);
    },
    async searchGlobal(_query, _maxResults, execution) {
      return search(execution);
    },
    async bm25Search(_query, _collection, _maxResults, execution) {
      return search(execution);
    },
    async vectorSearch(_query, _collection, _maxResults, execution) {
      return search(execution);
    },
    async hybridSearch(_query, _collection, _maxResults, execution) {
      return search(execution);
    },
    async update() {},
    async updateCollection() {},
    async embed() {},
    async embedCollection() {},
    async ensureCollection() {
      return "skipped";
    },
  };
  return backend as SearchBackend;
}

async function withOrchestrator(
  prefix: string,
  degrade: boolean,
  run: (orchestrator: Orchestrator, observed: { calls: number }) => Promise<void>,
  configOverrides: Partial<PluginConfig> = {},
): Promise<void> {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const orchestrator = new Orchestrator(
    parseConfig({
      memoryDir,
      workspaceDir: memoryDir,
      qmdEnabled: true,
      embeddingFallbackEnabled: false,
      ...configOverrides,
    }),
  );
  const observed = { calls: 0 };
  // Unchecked cast with reason: `qmd` is assigned post-construction because the
  // backend is built by the search factory, which would reach for a real daemon.
  const withBackend = orchestrator as unknown as { qmd: SearchBackend };
  withBackend.qmd = searchBackend(observed, degrade);
  try {
    await orchestrator.initialize();
    await orchestrator.deferredReady;
    await run(orchestrator, observed);
  } finally {
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
}

test("QMD daemon_timeout mid-recall is distinguishable from genuine empty at the orchestrator", async () => {
  await withOrchestrator("remnic-recall-timeout-", true, async (orchestrator, observed) => {
    let composition: RecallContextComposition | undefined;
    const context = await orchestrator.recall(QUERY, "timeout-session", {
      onContextComposition: (value) => {
        composition = value;
      },
    });

    assert.ok(observed.calls > 0, "recall must consult the backend");
    assert.equal(composition?.degradation?.state, "missing");
    assert.equal(composition?.degradation?.reason, "backend-unavailable");
    assert.match(composition?.degradation?.detail ?? "", /qmd:daemon_timeout/);
    assert.equal(context, MEMORY_CONTEXT_UNAVAILABLE_NOTE);
  });
});

test("genuine empty retrieval stays marker-free at the orchestrator", async () => {
  await withOrchestrator("remnic-recall-empty-", false, async (orchestrator, observed) => {
    let composition: RecallContextComposition | undefined;
    const context = await orchestrator.recall(QUERY, "empty-session", {
      onContextComposition: (value) => {
        composition = value;
      },
    });

    assert.ok(observed.calls > 0, "recall must consult the backend");
    assert.equal(composition?.degradation, undefined);
    assert.equal(context.includes("Memory context unavailable"), false);
  });
});

test("recall reports storage corpus versions captured before retrieval, not index application", async () => {
  await withOrchestrator("remnic-recall-version-", false, async (orchestrator, observed) => {
    const storage = await orchestrator.getStorage("default");
    const beforeRetrieval = storage.getMemoryCorpusVersion();
    let writeDuringSearch = true;
    let indexUpdates = 0;
    const backend = searchBackend(observed, false, async () => {
      if (!writeDuringSearch) return;
      writeDuringSearch = false;
      await storage.writeMemory("fact", "write committed while retrieval was in flight");
    });
    const withBackend = orchestrator as unknown as { qmd: SearchBackend };
    withBackend.qmd = {
      ...backend,
      async updateCollection() { indexUpdates += 1; },
      async updateCollectionStrict() { indexUpdates += 1; },
    };

    const response = await new EngramAccessService(orchestrator).recall({
      query: QUERY,
      sessionKey: "corpus-version",
    });

    assert.ok(observed.calls > 0, "recall must consult the backend");
    assert.ok(storage.getMemoryCorpusVersion() > beforeRetrieval, "the in-flight write advanced storage");
    assert.deepEqual(response.storageCorpusVersionsAtRecallStart, [{ namespace: "default", version: beforeRetrieval }]);
    assert.equal(indexUpdates, 0, "a corpus sentinel does not prove QMD index application");
  });
});

test("recall reports a separate storage corpus version for every searched namespace", async () => {
  await withOrchestrator(
    "remnic-recall-multi-version-",
    false,
    async (orchestrator) => {
      const primary = await orchestrator.getStorage("default");
      const shared = await orchestrator.getStorage("shared");
      const response = await new EngramAccessService(orchestrator).recall({
        query: QUERY,
        sessionKey: "multi-corpus-version",
        authenticatedPrincipal: "alice",
      });
      assert.deepEqual(response.storageCorpusVersionsAtRecallStart, [
        { namespace: "default", version: primary.getMemoryCorpusVersion() },
        { namespace: "shared", version: shared.getMemoryCorpusVersion() },
      ]);
    },
    { namespacesEnabled: true, defaultRecallNamespaces: ["self", "shared"] },
  );
});

test("cold-start recall samples corpus versions only after initialization", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-recall-cold-start-"));
  const orchestrator = new Orchestrator(parseConfig({
    memoryDir,
    workspaceDir: memoryDir,
    qmdEnabled: true,
    embeddingFallbackEnabled: false,
  }));
  const observed = { calls: 0 };
  const withBackend = orchestrator as unknown as { qmd: SearchBackend };
  withBackend.qmd = searchBackend(observed, false);
  let releaseInitialization!: () => void;
  let notifyInitializationStarted!: () => void;
  const initializationGate = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  const initializationStarted = new Promise<void>((resolve) => { notifyInitializationStarted = resolve; });
  const initialize = orchestrator.initialize.bind(orchestrator);
  orchestrator.initialize = async () => {
    notifyInitializationStarted();
    await initializationGate;
    await initialize();
  };
  let initialization: Promise<void> | undefined;
  try {
    initialization = orchestrator.initialize();
    await initializationStarted;
    const recall = new EngramAccessService(orchestrator).recall({
      query: QUERY,
      sessionKey: "cold-start-corpus-version",
    });
    releaseInitialization();
    await initialization;
    const response = await recall;
    assert.ok(observed.calls > 0);
    const storage = await orchestrator.getStorage("default");
    assert.ok(storage.getMemoryCorpusVersion() > 0);
    assert.deepEqual(response.storageCorpusVersionsAtRecallStart, [
      { namespace: "default", version: storage.getMemoryCorpusVersion() },
    ]);
  } finally {
    releaseInitialization();
    await initialization?.catch(() => undefined);
    await orchestrator.destroy();
    await rm(memoryDir, { recursive: true, force: true });
  }
});
test("no_recall does not sample corpus versions for namespaces it did not search", async () => {
  await withOrchestrator("remnic-recall-no-recall-version-", false, async (orchestrator) => {
    const response = await new EngramAccessService(orchestrator).recall({
      query: "thanks",
      sessionKey: "no-recall-corpus-version",
      mode: "no_recall",
    });
    assert.deepEqual(response.storageCorpusVersionsAtRecallStart, []);
    const autoPlanned = await new EngramAccessService(orchestrator).recall({
      query: "thanks",
      sessionKey: "auto-no-recall-corpus-version",
    });
    assert.deepEqual(autoPlanned.storageCorpusVersionsAtRecallStart, []);
  });
});

test("recall reports the same coding namespaces selected by its scope plan", async () => {
  await withOrchestrator(
    "remnic-recall-coding-version-",
    false,
    async (orchestrator) => {
      const sessionKey = "coding-version";
      orchestrator.setCodingContextForSession(sessionKey, {
        projectId: "origin:acme/repo",
        branch: "main",
        rootPath: "/workspace/repo",
        defaultBranch: "main",
      });
      const scopePlan = resolveScopePlan({
        config: orchestrator.config,
        sessionKey,
        codingContext: orchestrator.getCodingContextForSession(sessionKey),
        namespacesEnabled: true,
      });
      const response = await new EngramAccessService(orchestrator).recall({
        query: QUERY,
        sessionKey,
        authenticatedPrincipal: "alice",
      });

      assert.deepEqual(
        response.storageCorpusVersionsAtRecallStart?.map(({ namespace }) => namespace),
        scopePlan.readNamespaces,
      );
    },
    { namespacesEnabled: true, codingMode: { projectScope: true, branchScope: false, globalFallback: true } },
  );
});

test("access recall surfaces retrievalFailure on daemon timeout and omits it on genuine empty", async () => {
  await withOrchestrator("remnic-recall-access-timeout-", true, async (timedOut, observed) => {
    const failed = await new EngramAccessService(timedOut).recall({
      query: QUERY,
      sessionKey: "access-timeout",
    });
    assert.ok(observed.calls > 0, "timeout recall must consult the backend");
    assert.equal(failed.retrievalFailure?.reason, "backend_unavailable");
    assert.match(failed.retrievalFailure?.detail ?? "", /qmd:daemon_timeout/);
    assert.equal(failed.contextComposition?.degradation?.state, "missing");
    assert.match(failed.context, /memory context unavailable/i);
  });

  await withOrchestrator("remnic-recall-access-empty-", false, async (empty, observed) => {
    const okEmpty = await new EngramAccessService(empty).recall({
      query: QUERY,
      sessionKey: "access-empty",
    });
    assert.ok(observed.calls > 0, "empty recall must consult the backend");
    assert.equal(okEmpty.retrievalFailure, undefined);
    assert.equal(okEmpty.contextComposition?.degradation, undefined);
    assert.equal(okEmpty.context.includes("Memory context unavailable"), false);
  });
});

test("a reused degradationSink cannot mark a later healthy empty recall as failed", async () => {
  await withOrchestrator("remnic-recall-reused-sink-", true, async (orchestrator, observed) => {
    const sink: SearchDegradation[] = [];
    await orchestrator.recall(QUERY, "first-timeout", { degradationSink: sink });
    assert.ok(sink.length > 0, "the first recall must record the timeout");

    const withBackend = orchestrator as unknown as { qmd: SearchBackend };
    withBackend.qmd = searchBackend(observed, false);
    let composition: RecallContextComposition | undefined;
    await orchestrator.recall(QUERY, "second-empty", {
      degradationSink: sink,
      onContextComposition: (value) => {
        composition = value;
      },
    });
    assert.equal(composition?.degradation, undefined);
  });
});

test("MCP recall payload keeps retrievalFailure so a tool caller can branch on it", async () => {
  const timeoutResponse: EngramAccessRecallResponse = {
    query: QUERY,
    namespace: "default",
    context: MEMORY_CONTEXT_UNAVAILABLE_NOTE,
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: DEFAULT_RECALL_DISCLOSURE,
    storageCorpusVersionsAtRecallStart: [{ namespace: "default", version: 1 }],
    retrievalFailure: {
      reason: "backend_unavailable",
      detail: "qmd:daemon_timeout (no response within the deadline)",
    },
  };
  const emptyResponse: EngramAccessRecallResponse = {
    query: QUERY,
    namespace: "default",
    context: "",
    count: 0,
    memoryIds: [],
    results: [],
    fallbackUsed: false,
    sourcesUsed: [],
    disclosure: DEFAULT_RECALL_DISCLOSURE,
    storageCorpusVersionsAtRecallStart: [{ namespace: "default", version: 1 }],
  };

  async function callRecall(response: EngramAccessRecallResponse): Promise<EngramAccessRecallResponse> {
    const service = {
      briefingEnabled: false,
      recall: (_req: EngramAccessRecallRequest) => Promise.resolve(response),
    } as unknown as EngramAccessService;
    const server = new EngramMcpServer(service);
    // Unchecked cast with reason: handleRequest is a JSON-RPC envelope; this
    // test owns both the spy recall result and the tool name, so the payload
    // shape is the MCP recall structuredContent, not untrusted input.
    const rpc = (await server.handleRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "engram.recall", arguments: { query: QUERY } },
    })) as {
      result?: { structuredContent?: EngramAccessRecallResponse; content?: Array<{ text?: string }> };
    };
    const structured = rpc.result?.structuredContent;
    assert.ok(structured, "MCP recall must return structuredContent");
    const text = rpc.result?.content?.[0]?.text ?? "{}";
    const parsed: unknown = JSON.parse(text);
    assert.ok(parsed && typeof parsed === "object");
    const parsedFailure = "retrievalFailure" in parsed ? parsed.retrievalFailure : undefined;
    assert.deepEqual(parsedFailure, structured.retrievalFailure);
    assert.deepEqual(
      "storageCorpusVersionsAtRecallStart" in parsed ? parsed.storageCorpusVersionsAtRecallStart : undefined,
      structured.storageCorpusVersionsAtRecallStart,
    );
    return structured;
  }

  const timedOut = await callRecall(timeoutResponse);
  const genuineEmpty = await callRecall(emptyResponse);
  assert.equal(timedOut.count, genuineEmpty.count);
  assert.deepEqual(timedOut.results, genuineEmpty.results);
  assert.equal(timedOut.retrievalFailure?.reason, "backend_unavailable");
  assert.equal(genuineEmpty.retrievalFailure, undefined);
});
