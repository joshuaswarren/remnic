/**
 * Deep-recall surface regressions (issue #2332 review).
 *
 * 1. HTTP body namespace: a namespace-scoped bearer that passes an allowed
 *    `?namespace=` while setting a DIFFERENT `namespace` in the JSON body must
 *    be refused, because the body value is what the service ends up scoped to.
 * 2. Seed routing: a non-default namespace must search ITS OWN collection, not
 *    the base (default-namespace) collection.
 * 3. Graph routing: a non-default namespace must read ITS OWN abstraction-node
 *    and cue-anchor store, never the default namespace's configured override.
 * 4. Degradation: an unavailable namespace index is a `backend_unavailable`
 *    failure, never a healthy empty result.
 * 5. Principal: authorization derives from the presenting authenticated
 *    principal, never from the client-supplied `sessionKey`.
 * 6. Governance: graph nodes and anchors are projected against the current
 *    active memories BEFORE anything reaches the policy LLM's state prompt.
 *
 * All paths are synthetic temp dirs; no operator data.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { recordAbstractionNode } from "./abstraction-nodes.js";
import { EngramAccessHttpServer } from "./access-http.js";
import { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { recordCueAnchor } from "./cue-anchors.js";
import { DEEP_RECALL_CONFIG_DEFAULTS } from "./deep-recall-config.js";
import { createDeepRecallSeedSearch } from "./deep-recall-seeds.js";
import { runBudgetedDeepRecall } from "./deep-recall.js";
import { NamespaceSearchRouter, namespaceCollectionName } from "./namespaces/search.js";
import { StorageManager } from "./storage.js";
import type { SearchBackend } from "./search/port.js";

test("HTTP deep recall authorizes with the presenting principal, not the client's sessionKey (issue #2332 review)", async () => {
  // The route dropped `scope.authenticatedPrincipal`, so the service fell back
  // to deriving the principal from the client-supplied `sessionKey`. Both
  // directions broke: a crafted key matching another principal's rule read
  // that principal's namespace, and a legitimate namespace-enabled request
  // carrying no session key was refused as unauthenticated.
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-principal-"));
  try {
    const namespaceDir = path.join(memoryDir, "namespaces", "ns_alice");
    await mkdir(namespaceDir, { recursive: true });
    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      qmdCollection: "remnic-test",
      deepRecall: { enabled: true, maxSteps: 0 },
      principalFromSessionKeyMode: "map",
      principalFromSessionKeyRules: [{ match: "crafted-alice-key", principal: "alice" }],
      namespacePolicies: [{ name: "ns_alice", readPrincipals: ["alice"], writePrincipals: ["alice"] }],
    });
    const storageCalls: string[] = [];
    const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
    // Test double: deepRecall touches only these orchestrator members, and the
    // real Orchestrator cannot be constructed without a live backend.
    const host = service as unknown as { orchestrator: unknown };
    host.orchestrator = {
      config,
      async getStorage(namespace: string) {
        storageCalls.push(namespace);
        return {
          dir: namespaceDir,
          async readMemoryByPath() {
            return null;
          },
          async getMemoryById() {
            return null;
          },
        };
      },
      async searchAcrossNamespaces() {
        return [];
      },
      localLlm: null,
      fastGatewayLlm: null,
    };
    const server = new EngramAccessHttpServer({
      service,
      port: 0,
      trustPrincipalHeader: true,
      adminConsoleEnabled: false,
      authTokenEntriesGetter: () => [{ token: "operator-token", capabilities: { version: 1 } }],
    });
    const status = await server.start();
    const postDeep = (principal: string, body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${status.port}/engram/v1/recall/deep`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer operator-token",
          "x-engram-principal": principal,
        },
        body: JSON.stringify({ query: "who owns the routing decision", ...body }),
      });
    try {
      // The escalation this fix closes: principal `bob` presents a session key
      // whose configured rule names `alice`, and asks for alice's namespace.
      const escalation = await postDeep("bob", {
        namespace: "ns_alice",
        sessionKey: "crafted-alice-key",
      });
      assert.notEqual(
        escalation.status,
        200,
        "a crafted sessionKey must not buy another principal's namespace",
      );
      assert.deepEqual(storageCalls, [], "the denied namespace must never be opened");

      // The other direction: an authenticated principal with NO session key is
      // authenticated, and must not be refused for lack of one.
      const legitimate = await postDeep("alice", { namespace: "ns_alice" });
      assert.equal(
        legitimate.status,
        200,
        "a namespace-enabled request from an authenticated principal needs no sessionKey",
      );
      const body: unknown = await legitimate.json();
      assert.ok(body && typeof body === "object" && "ok" in body && body.ok === true);
      assert.deepEqual(
        storageCalls,
        ["ns_alice"],
        "the presenting principal's namespace is the one opened",
      );
    } finally {
      await server.stop();
    }
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("deep recall projects graph nodes against active memories before the policy prompt (issue #2332 review)", async () => {
  // `loadGraph` read nodes and anchors raw, so a node built from a memory that
  // was later rejected still carried its stored title and its anchor value.
  // Both reached the policy LLM through the frontier in the state prompt, long
  // before `loadMemory(...).active` could drop the memory from the entries:
  // governed metadata left the store anyway. The graph now flows through the
  // SAME active-source projection `searchHarmonicRetrieval` uses.
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-governed-"));
  try {
    const config = parseConfig({
      memoryDir,
      qmdEnabled: false,
      qmdCollection: "remnic-test",
      deepRecall: { enabled: true, maxSteps: 1 },
    });
    const storage = new StorageManager(memoryDir);
    await storage.ensureDirectories();
    const seed = await storage.writeMemory("fact", "Alpha holds the payments routing decision.", {
      tags: ["payments"],
    });
    const governed = await storage.writeMemory(
      "fact",
      "GOVERNED-CONTENT names the fallback processor contract.",
      { tags: ["payments"] },
    );
    assert.equal(seed.tombstoneBlocked, false, "the seed fixture must actually persist");
    assert.equal(governed.tombstoneBlocked, false, "the governed fixture must actually persist");
    assert.ok(
      await storage.updateMemoryFrontmatter(governed.id, { status: "rejected" }),
      "the governed source memory is moved out of the active set",
    );

    const recordedAt = "2026-08-01T00:00:00.000Z";
    const node = (nodeId: string, title: string, sourceMemoryIds: string[]) => ({
      schemaVersion: 1 as const,
      nodeId,
      recordedAt,
      sessionKey: "test-session",
      kind: "topic" as const,
      abstractionLevel: "meso" as const,
      title,
      summary: `Synthetic ${nodeId} summary`,
      sourceMemoryIds,
    });
    await recordAbstractionNode({
      memoryDir,
      node: node("node-seed", "Seeded payments routing topic", [seed.id]),
    });
    await recordAbstractionNode({
      memoryDir,
      node: node("node-governed", "GOVERNED-TITLE rejected fallback topic", [governed.id]),
    });
    await recordCueAnchor({
      memoryDir,
      anchor: {
        schemaVersion: 1,
        anchorId: "anchor-shared",
        anchorType: "entity",
        anchorValue: "GOVERNED-ANCHOR+payments",
        normalizedCue: "governed anchor payments",
        recordedAt,
        sessionKey: "test-session",
        nodeRefs: ["node-seed", "node-governed"],
      },
    });

    const prompts: string[] = [];
    const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
    // Test double: the real Orchestrator needs a live backend, but the graph
    // and the source memories below are read from the REAL store on disk.
    const host = service as unknown as { orchestrator: unknown };
    host.orchestrator = {
      config,
      async getStorage() {
        return storage;
      },
      async searchAcrossNamespaces() {
        return [{ docid: seed.id, path: seed.memory.path, score: 0.9, snippet: "" }];
      },
      localLlm: {
        async chatCompletion(messages: Array<{ content: string }>) {
          prompts.push(messages.map((message) => message.content).join("\n"));
          return { content: JSON.stringify({ action: "STOP", reason: "sufficient" }) };
        },
      },
      fastGatewayLlm: null,
    };

    const result = await service.deepRecall({ query: "acme payments routing decision" });

    assert.equal(result.ok, true);
    assert.ok(prompts.length > 0, "the policy loop must actually have rendered a state prompt");
    const rendered = prompts.join("\n");
    assert.ok(
      rendered.includes("Alpha holds the payments routing decision"),
      "the active seed really is in the state prompt (the assertions below are not vacuous)",
    );
    assert.ok(
      !rendered.includes("GOVERNED-TITLE"),
      "a node whose only source memory was rejected must not reach the policy prompt",
    );
    assert.ok(
      !rendered.includes("GOVERNED-ANCHOR"),
      "the anchor value attributed through a rejected source must not reach the policy prompt",
    );
    assert.ok(
      !rendered.includes("node-governed"),
      "the governed node must not be offered as a frontier candidate",
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.memoryId),
      [seed.id],
      "only the active memory survives to the entries",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("HTTP deep recall gates the body namespace, not just the query string (issue #2332 review)", async () => {
  // The route used to resolve the scope from `?namespace=` only and then let
  // `body.namespace` override it, so an allowed query namespace plus a foreign
  // body namespace read another tenant. The body value must pass the SAME
  // effective-namespace allow-list gate: 403 before the service is reached.
  const calls: Array<Record<string, unknown>> = [];
  const service = {
    configRef: parseConfig({
      memoryDir: path.join(tmpdir(), "remnic-deep-recall-ns"),
      namespacesEnabled: true,
      defaultNamespace: "default",
    }),
    deepRecall: async (request: Record<string, unknown>) => {
      calls.push(request);
      return { ok: true, entries: [], trace: [], rendered: "" };
    },
  } as unknown as EngramAccessService;
  const server = new EngramAccessHttpServer({
    service,
    port: 0,
    authTokenEntriesGetter: () => [
      { token: "scoped-ns-a", capabilities: { version: 1, namespaces: ["ns_a"] } },
      { token: "operator", capabilities: { version: 1 } },
    ],
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const postDeep = (token: string, queryNamespace?: string, bodyNamespace?: string) =>
    fetch(
      `http://127.0.0.1:${status.port}/engram/v1/recall/deep${queryNamespace ? `?namespace=${queryNamespace}` : ""}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: "who owns the routing decision", ...(bodyNamespace ? { namespace: bodyNamespace } : {}) }),
      },
    );
  try {
    // The escalation this fix closes: allowed query namespace, foreign body namespace.
    assert.equal(
      (await postDeep("scoped-ns-a", "ns_a", "ns_b")).status,
      403,
      "scoped deep recall: a body namespace outside the allow-list must be denied (403)",
    );
    assert.equal(calls.length, 0, "scoped deep recall: the service must NOT be reached for a denied namespace");

    // A body namespace inside the allow-list still works, and still wins.
    const allowed = await postDeep("scoped-ns-a", "ns_a", "ns_a");
    assert.notEqual(allowed.status, 403, "scoped deep recall: an allowed body namespace must proceed");
    assert.equal(calls.at(-1)?.namespace, "ns_a", "the gated body namespace reaches the service");

    // No body namespace: the query-string fallback is preserved.
    assert.notEqual((await postDeep("scoped-ns-a", "ns_a")).status, 403);
    assert.equal(calls.at(-1)?.namespace, "ns_a", "the query-string namespace still reaches the service");

    // Unrestricted token: namespace scoping stays a no-op.
    assert.notEqual(
      (await postDeep("operator", "ns_a", "ns_b")).status,
      403,
      "unrestricted deep recall: namespace scoping must be a no-op",
    );
    assert.equal(calls.at(-1)?.namespace, "ns_b");
  } finally {
    await server.stop();
  }
});

test("deep recall seeds search the resolved namespace's collection, not the base one (issue #2332 review)", async () => {
  // Storage and graph reads resolve through the caller's namespace, so seed
  // retrieval must too: the base `qmdCollection` belongs to the DEFAULT
  // namespace, and querying it from `ns_b` returns default-namespace doc ids
  // (cross-tenant) while missing the caller's own indexed memories.
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-seeds-"));
  try {
    const namespace = "ns_b";
    const namespaceDir = path.join(memoryDir, "namespaces", namespace);
    await mkdir(namespaceDir, { recursive: true });
    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      qmdCollection: "remnic-test",
    });
    const searched: Array<{ query: string; collection?: string }> = [];
    const hitPath = path.join(namespaceDir, "facts", "2026-08-01", "fact-1.md");
    const router = new NamespaceSearchRouter(
      config,
      { storageFor: async () => ({ dir: namespaceDir }) },
      () =>
        ({
          probe: async () => true,
          checkCollection: async () => "present" as const,
          search: async (query: string, collection?: string) => {
            searched.push({ query, collection });
            return [{ docid: "doc-1", path: hitPath, snippet: "", score: 0.7 }];
          },
        }) as unknown as SearchBackend,
    );

    const searchSeed = createDeepRecallSeedSearch({
      namespace,
      storage: {
        dir: namespaceDir,
        readMemoryByPath: async (filePath) =>
          filePath === hitPath ? { frontmatter: { id: "mem-alpha" } } : null,
      },
      router,
    });
    const seeds = await searchSeed("payments routing", 5);

    const expectedCollection = namespaceCollectionName(config.qmdCollection, namespace, {
      defaultNamespace: config.defaultNamespace,
      useLegacyDefaultCollection: false,
    });
    assert.notEqual(
      expectedCollection,
      config.qmdCollection,
      "fixture sanity: a non-default namespace has its own suffixed collection",
    );
    assert.equal(searched.length, 1, "exactly one namespace-routed search per seed retrieval");
    assert.equal(
      searched[0]?.collection,
      expectedCollection,
      "seeds must be retrieved from the resolved namespace's collection",
    );
    assert.deepEqual(
      seeds,
      [{ memoryId: "mem-alpha", score: 0.7 }],
      "each hit resolves to the namespace memory id through the shared result resolver",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("deep recall reads the graph from the resolved namespace, not the default store override (issue #2332 review)", async () => {
  // `abstractionNodeStoreDir` defaults to the ROOT memory dir's graph store and
  // wins over `memoryDir` inside the resolver, so passing it for every caller
  // made a non-default namespace load the DEFAULT namespace's nodes/anchors:
  // its own anchor expansions were invisible and a colliding memory id exposed
  // default-namespace graph metadata. The harmonic WRITE path already sends the
  // override to the base namespace only.
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-graph-"));
  try {
    const namespace = "ns_b";
    const namespaceDir = path.join(memoryDir, "namespaces", namespace);
    await mkdir(namespaceDir, { recursive: true });
    const defaultStoreOverride = path.join(memoryDir, "default-harmonic-store");
    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      qmdCollection: "remnic-test",
      abstractionNodeStoreDir: defaultStoreOverride,
      deepRecall: { enabled: true, maxSteps: 2 },
      namespacePolicies: [{ name: namespace, readPrincipals: ["operator"], writePrincipals: ["operator"] }],
    });

    // Real source memories in the tenant's store: the graph projection every
    // reader shares resolves node sources against the CURRENT active memories,
    // so a node whose sources are not really there is not eligible at all.
    const storage = new StorageManager(namespaceDir);
    await storage.ensureDirectories();
    const seed = await storage.writeMemory("fact", "Alpha holds the payments routing decision.", {
      tags: ["payments"],
    });
    const nsOnly = await storage.writeMemory(
      "fact",
      "The tenant's own anchor-linked fallback contract.",
      { tags: ["payments"] },
    );
    // Reachable ONLY through the default namespace's graph: routing the graph
    // read to that store is what would surface it.
    const defaultLeak = await storage.writeMemory(
      "fact",
      "Metadata reachable only through the default namespace's graph.",
      { tags: ["payments"] },
    );
    for (const written of [seed, nsOnly, defaultLeak]) {
      assert.equal(written.tombstoneBlocked, false, "every fixture memory must actually persist");
    }

    const recordedAt = "2026-08-01T00:00:00.000Z";
    const node = (nodeId: string, sourceMemoryIds: string[]) => ({
      schemaVersion: 1 as const,
      nodeId,
      recordedAt,
      sessionKey: "test-session",
      kind: "topic" as const,
      abstractionLevel: "meso" as const,
      title: `Topic ${nodeId}`,
      summary: `Synthetic ${nodeId} summary`,
      sourceMemoryIds,
    });
    const anchor = (anchorId: string, nodeRefs: string[]) => ({
      schemaVersion: 1 as const,
      anchorId,
      anchorType: "entity" as const,
      anchorValue: `acme+${anchorId}`,
      normalizedCue: `acme ${anchorId}`,
      recordedAt,
      sessionKey: "test-session",
      nodeRefs,
    });
    // The namespace's own store: the seed's node shares an anchor with the
    // node holding the tenant-only memory.
    for (const own of [node("node-ns-b-seed", [seed.id]), node("node-ns-b-linked", [nsOnly.id])]) {
      await recordAbstractionNode({ memoryDir: namespaceDir, node: own });
    }
    await recordCueAnchor({
      memoryDir: namespaceDir,
      anchor: anchor("anchor-ns-b", ["node-ns-b-seed", "node-ns-b-linked"]),
    });
    // The DEFAULT namespace's store, reached only through the override. It
    // collides on the seed memory and links to the default-only metadata.
    for (const foreign of [node("node-default-seed", [seed.id]), node("node-default-linked", [defaultLeak.id])]) {
      await recordAbstractionNode({ memoryDir, abstractionNodeStoreDir: defaultStoreOverride, node: foreign });
    }
    await recordCueAnchor({
      memoryDir,
      abstractionNodeStoreDir: defaultStoreOverride,
      anchor: anchor("anchor-default", ["node-default-seed", "node-default-linked"]),
    });

    const seedPath = seed.memory.path;
    const policyScript = [
      JSON.stringify({ action: "EXPAND", expandNodeIds: ["node-ns-b-linked"], reason: "follow the tenant anchor" }),
      JSON.stringify({ action: "STOP", reason: "sufficient" }),
    ];
    const service = Object.create(EngramAccessService.prototype) as EngramAccessService;
    // Test double: deepRecall touches only these orchestrator members, and the
    // real Orchestrator cannot be constructed without a live backend.
    const host = service as unknown as { orchestrator: unknown };
    host.orchestrator = {
      config,
      async getStorage() {
        return storage;
      },
      async searchAcrossNamespaces() {
        return [{ docid: seed.id, path: seedPath, score: 0.9, snippet: "" }];
      },
      localLlm: {
        async chatCompletion() {
          return { content: policyScript.shift() ?? JSON.stringify({ action: "STOP", reason: "script spent" }) };
        },
      },
      fastGatewayLlm: null,
    };

    const result = await service.deepRecall({
      query: "acme payments routing",
      namespace,
      authenticatedPrincipal: "operator",
    });

    assert.equal(result.ok, true);
    const ids = result.entries.map((entry) => entry.memoryId).sort();
    assert.deepEqual(
      ids,
      [seed.id, nsOnly.id].sort(),
      "the namespace's own anchor expansion is reachable and no default-namespace memory is",
    );
    assert.equal(result.trace[0]?.action, "EXPAND", "the tenant's frontier node was a valid selection");
    assert.ok(
      !JSON.stringify(result).includes(defaultLeak.id),
      "default-namespace graph metadata must never reach a non-default caller",
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("deep recall reports an unavailable namespace index as backend_unavailable, not empty success (issue #2332 review)", async () => {
  // `searchAcrossNamespaces` contributes [] for an unavailable backend or a
  // missing collection and reports the condition ONLY through
  // `execution.onDegradation`. With no observer the surface answered
  // `ok: true` with zero entries — indistinguishable from a healthy empty
  // index, and contradicting the advertised `backend_unavailable` result.
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-deep-recall-degraded-"));
  try {
    const namespace = "ns_b";
    const namespaceDir = path.join(memoryDir, "namespaces", namespace);
    await mkdir(namespaceDir, { recursive: true });
    const config = parseConfig({
      memoryDir,
      namespacesEnabled: true,
      defaultNamespace: "default",
      qmdCollection: "remnic-test",
    });
    const router = new NamespaceSearchRouter(
      config,
      { storageFor: async () => ({ dir: namespaceDir }) },
      () =>
        ({
          probe: async () => false,
          checkCollection: async () => "missing" as const,
          search: async () => {
            throw new Error("an unavailable backend must never be searched");
          },
        }) as unknown as SearchBackend,
    );
    const searchSeed = createDeepRecallSeedSearch({
      namespace,
      storage: { dir: namespaceDir, readMemoryByPath: async () => null },
      router,
    });

    await assert.rejects(
      () => searchSeed("payments routing", 5),
      /deep recall seed search unavailable/,
      "a degraded namespace search must not resolve to an empty seed list",
    );

    const result = await runBudgetedDeepRecall(
      {
        config: { ...DEEP_RECALL_CONFIG_DEFAULTS, enabled: true, maxSteps: 0 },
        searchSeed,
        loadGraph: async () => ({ nodes: [], anchors: [] }),
        loadMemory: async () => null,
        callPolicy: async () => {
          throw new Error("the policy must not run after a seed backend failure");
        },
      },
      "payments routing",
    );
    assert.equal(result.ok, false, "an unavailable index is a failure, not a healthy empty index");
    assert.equal(result.error, "backend_unavailable");
    assert.deepEqual(result.entries, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
