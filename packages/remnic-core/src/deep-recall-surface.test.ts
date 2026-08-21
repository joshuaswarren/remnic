/**
 * Deep-recall surface regressions (issue #2332 review).
 *
 * 1. HTTP body namespace: a namespace-scoped bearer that passes an allowed
 *    `?namespace=` while setting a DIFFERENT `namespace` in the JSON body must
 *    be refused, because the body value is what the service ends up scoped to.
 * 2. Seed routing: a non-default namespace must search ITS OWN collection, not
 *    the base (default-namespace) collection.
 *
 * All paths are synthetic temp dirs; no operator data.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EngramAccessHttpServer } from "./access-http.js";
import type { EngramAccessService } from "./access-service.js";
import { parseConfig } from "./config.js";
import { createDeepRecallSeedSearch } from "./deep-recall-seeds.js";
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
