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
import type { SearchBackend } from "./search/port.js";

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
    // The namespace's own store: mem-alpha's node shares an anchor with the
    // node holding mem-ns-b-only.
    for (const own of [node("node-ns-b-seed", ["mem-alpha"]), node("node-ns-b-linked", ["mem-ns-b-only"])]) {
      await recordAbstractionNode({ memoryDir: namespaceDir, node: own });
    }
    await recordCueAnchor({
      memoryDir: namespaceDir,
      anchor: anchor("anchor-ns-b", ["node-ns-b-seed", "node-ns-b-linked"]),
    });
    // The DEFAULT namespace's store, reached only through the override. It
    // collides on mem-alpha and links to foreign metadata.
    for (const foreign of [node("node-default-seed", ["mem-alpha"]), node("node-default-linked", ["mem-default-leak"])]) {
      await recordAbstractionNode({ memoryDir, abstractionNodeStoreDir: defaultStoreOverride, node: foreign });
    }
    await recordCueAnchor({
      memoryDir,
      abstractionNodeStoreDir: defaultStoreOverride,
      anchor: anchor("anchor-default", ["node-default-seed", "node-default-linked"]),
    });

    const contentById: Record<string, string> = {
      "mem-alpha": "Alpha holds the payments routing decision.",
      "mem-ns-b-only": "The tenant's own anchor-linked fallback contract.",
      "mem-default-leak": "Default-namespace metadata that must never leak.",
    };
    const seedPath = path.join(namespaceDir, "facts", "2026-08-01", "mem-alpha.md");
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
        return {
          dir: namespaceDir,
          async readMemoryByPath(filePath: string) {
            return filePath === seedPath ? { frontmatter: { id: "mem-alpha" } } : null;
          },
          async getMemoryById(memoryId: string) {
            const content = contentById[memoryId];
            if (content === undefined) return null;
            return {
              frontmatter: { id: memoryId, status: "active" },
              content,
              path: path.join(namespaceDir, "facts", "2026-08-01", `${memoryId}.md`),
            };
          },
        };
      },
      async searchAcrossNamespaces() {
        return [{ docid: "mem-alpha", path: seedPath, score: 0.9, snippet: "" }];
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
      ["mem-alpha", "mem-ns-b-only"],
      "the namespace's own anchor expansion is reachable and no default-namespace memory is",
    );
    assert.equal(result.trace[0]?.action, "EXPAND", "the tenant's frontier node was a valid selection");
    assert.ok(
      !JSON.stringify(result).includes("mem-default-leak"),
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
