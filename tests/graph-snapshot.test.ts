/**
 * Tests for the graph snapshot HTTP surface (issue #691 PR 2/5).
 *
 * Covers:
 *   - the pure `buildGraphSnapshot` builder against a fixture memory dir,
 *   - the `EngramAccessHttpServer` route (auth, query-param validation,
 *     focus / category filters, limit enforcement),
 *   - the dual MCP tool name (`engram.graph_snapshot` /
 *     `remnic.graph_snapshot`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";

import { EngramAccessHttpServer } from "../src/access-http.js";
import {
  buildGraphSnapshot,
  GRAPH_SNAPSHOT_DEFAULT_LIMIT,
  GRAPH_SNAPSHOT_MAX_LIMIT,
  normalizeGraphSnapshotLimit,
  parseGraphSnapshotSince,
  type GraphSnapshotResponse,
} from "../src/graph-snapshot.js";
import { appendEdge } from "../src/graph.js";
import { EngramMcpServer } from "../src/access-mcp.js";

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "engram-graph-snapshot-test-"));
}

async function seedEdges(memoryDir: string): Promise<void> {
  const ts = (offset: number): string =>
    new Date(Date.UTC(2026, 3, 20, 12, offset)).toISOString();
  await appendEdge(memoryDir, {
    from: "facts/2026-04-20/alpha.md",
    to: "facts/2026-04-20/beta.md",
    type: "entity",
    weight: 1.0,
    label: "project-x",
    ts: ts(0),
    confidence: 0.9,
  });
  await appendEdge(memoryDir, {
    from: "facts/2026-04-20/beta.md",
    to: "facts/2026-04-20/gamma.md",
    type: "entity",
    weight: 1.0,
    label: "project-x",
    ts: ts(5),
    confidence: 0.8,
  });
  await appendEdge(memoryDir, {
    from: "decisions/2026-04-20/d1.md",
    to: "facts/2026-04-20/alpha.md",
    type: "causal",
    weight: 1.0,
    label: "because",
    ts: ts(10),
  });
}

const META_FIXTURE: Record<string, { category: string; label: string; updated: string }> = {
  "facts/2026-04-20/alpha.md": {
    category: "fact",
    label: "alpha",
    updated: "2026-04-20T12:00:00.000Z",
  },
  "facts/2026-04-20/beta.md": {
    category: "fact",
    label: "beta",
    updated: "2026-04-20T12:05:00.000Z",
  },
  "facts/2026-04-20/gamma.md": {
    category: "fact",
    label: "gamma",
    updated: "2026-04-20T12:05:00.000Z",
  },
  "decisions/2026-04-20/d1.md": {
    category: "decision",
    label: "d1",
    updated: "2026-04-20T12:10:00.000Z",
  },
};

function buildLoader() {
  return async (relPath: string) => META_FIXTURE[relPath] ?? null;
}

test("normalizeGraphSnapshotLimit defaults / clamps / rejects", () => {
  assert.equal(normalizeGraphSnapshotLimit(undefined), GRAPH_SNAPSHOT_DEFAULT_LIMIT);
  assert.equal(normalizeGraphSnapshotLimit(50), 50);
  assert.equal(
    normalizeGraphSnapshotLimit(GRAPH_SNAPSHOT_MAX_LIMIT + 100),
    GRAPH_SNAPSHOT_MAX_LIMIT,
  );
  assert.throws(() => normalizeGraphSnapshotLimit(0), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit(-3), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit(1.5), /positive integer/);
  assert.throws(() => normalizeGraphSnapshotLimit("50" as unknown), /positive integer/);
});

test("parseGraphSnapshotSince accepts ISO and rejects garbage", () => {
  assert.equal(parseGraphSnapshotSince(undefined), undefined);
  assert.equal(parseGraphSnapshotSince(""), undefined);
  const ms = parseGraphSnapshotSince("2026-04-20T12:00:00Z");
  assert.equal(typeof ms, "number");
  assert.throws(() => parseGraphSnapshotSince("not-a-date"), /ISO/);
});

test("buildGraphSnapshot returns nodes/edges from a fixture memory dir", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: {},
      loadNode: buildLoader(),
    });
    assert.equal(snapshot.edges.length, 3);
    // Node count = 4 (alpha, beta, gamma, d1).
    assert.equal(snapshot.nodes.length, 4);
    // Edges include the canonical fields.
    const first = snapshot.edges[0]!;
    assert.ok(typeof first.source === "string");
    assert.ok(typeof first.target === "string");
    assert.match(first.kind, /^(entity|time|causal)$/);
    assert.ok(first.confidence > 0 && first.confidence <= 1);
    // generatedAt is an ISO string.
    assert.ok(!Number.isNaN(Date.parse(snapshot.generatedAt)));
    // Nodes carry resolved label / kind / score.
    const beta = snapshot.nodes.find((n) => n.id === "facts/2026-04-20/beta.md");
    assert.ok(beta);
    assert.equal(beta!.label, "beta");
    assert.equal(beta!.kind, "fact");
    assert.ok(beta!.score > 0);
    assert.ok(beta!.lastUpdated && !Number.isNaN(Date.parse(beta!.lastUpdated)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot enforces limit", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: { limit: 1 },
      loadNode: buildLoader(),
    });
    assert.equal(snapshot.edges.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot focusNodeId returns only neighborhood", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: { focusNodeId: "facts/2026-04-20/alpha.md" },
      loadNode: buildLoader(),
    });
    // alpha appears in edges 1 (alpha->beta) and 3 (d1->alpha) — both incident.
    assert.equal(snapshot.edges.length, 2);
    for (const edge of snapshot.edges) {
      assert.ok(
        edge.source === "facts/2026-04-20/alpha.md" || edge.target === "facts/2026-04-20/alpha.md",
        `edge ${edge.source}->${edge.target} should touch focus node`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot categories filter requires both endpoints to match", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: { categories: ["fact"] },
      loadNode: buildLoader(),
    });
    // Only the two fact↔fact entity edges survive; the decision↔fact causal
    // edge is dropped because `decision` is outside the allow-list.
    assert.equal(snapshot.edges.length, 2);
    for (const edge of snapshot.edges) {
      assert.equal(edge.kind, "entity");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot since filter drops older edges", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: { since: "2026-04-20T12:08:00Z" },
      loadNode: buildLoader(),
    });
    // Only the 12:10 causal edge passes the cutoff.
    assert.equal(snapshot.edges.length, 1);
    assert.equal(snapshot.edges[0]!.kind, "causal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot streaming category filter does not silently truncate large edge sets", async () => {
  // Regression for the Cursor Bugbot finding on PR #734: the previous
  // implementation pre-loaded metadata for the first 2× MAX_LIMIT unique
  // node ids and then applied the category filter on the cached map.  When
  // the relevant matching edges referenced nodes whose metadata fell
  // outside that window, those edges were silently dropped.  The streaming
  // implementation now lazy-loads metadata per edge and walks until either
  // (a) the limit is reached, or (b) the edge stream is exhausted — so
  // late-stream matches survive.
  const dir = await makeFixtureDir();
  try {
    // Build many `decision` edges first (these will be dropped by the
    // `fact` allow-list) and then a single `fact` edge near the end.
    const baseTs = Date.UTC(2026, 3, 20, 0, 0);
    for (let i = 0; i < 50; i += 1) {
      await appendEdge(dir, {
        from: `decisions/2026-04-20/d${i}.md`,
        to: `decisions/2026-04-20/d${i + 1}.md`,
        type: "entity",
        weight: 1.0,
        label: "noise",
        ts: new Date(baseTs + i * 1000).toISOString(),
      });
    }
    await appendEdge(dir, {
      from: "facts/2026-04-20/alpha.md",
      to: "facts/2026-04-20/beta.md",
      type: "entity",
      weight: 1.0,
      label: "real",
      ts: new Date(baseTs - 60_000).toISOString(),
    });
    const loadNode = async (relPath: string) => {
      if (relPath.startsWith("facts/")) {
        return { category: "fact", label: relPath };
      }
      return { category: "decision", label: relPath };
    };
    const snapshot = await buildGraphSnapshot({
      memoryDir: dir,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: { categories: ["fact"], limit: 10 },
      loadNode,
    });
    // The streaming filter must surface the single `fact` edge even though
    // it sorts after 50 `decision` edges.
    assert.equal(snapshot.edges.length, 1);
    assert.equal(snapshot.edges[0]!.source, "facts/2026-04-20/alpha.md");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("graphSnapshot loader rejects path traversal in edge endpoints", async () => {
  // Regression for the codex P1 finding on PR #734: a malformed edge with
  // an absolute path or `../` traversal must not read memory files from
  // outside the resolved namespace.  We replicate the access-service's
  // path-guarded loader against two sibling directories and confirm
  // (a) the benign endpoint resolves, (b) the absolute-path endpoint is
  // rejected, (c) the `..` traversal endpoint is rejected — even though
  // the file at the traversal target exists on disk and would otherwise
  // be readable.
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-graph-snapshot-traversal-"));
  try {
    const nsA = path.join(root, "ns-a");
    const nsB = path.join(root, "ns-b");
    await mkdir(path.join(nsA, "facts", "2026-04-20"), { recursive: true });
    await mkdir(nsB, { recursive: true });

    await writeFile(
      path.join(nsA, "facts", "2026-04-20", "alpha.md"),
      "---\nid: alpha\ncategory: fact\nupdated: 2026-04-20T00:00:00.000Z\n---\nalpha\n",
      "utf-8",
    );
    const secretPath = path.join(nsB, "secret.md");
    await writeFile(
      secretPath,
      "---\nid: secret\ncategory: secret\n---\nsecret\n",
      "utf-8",
    );

    // Replicate the access-service loader.  The path guard rejects
    // absolute paths and `..` traversals.
    const namespaceRoot = path.resolve(nsA);
    const namespaceRootWithSep = namespaceRoot.endsWith(path.sep)
      ? namespaceRoot
      : namespaceRoot + path.sep;
    const callsToReadFile: string[] = [];
    const fs = await import("node:fs/promises");
    const guardedLoader = async (relPath: string) => {
      if (path.isAbsolute(relPath)) return null;
      const candidate = path.resolve(namespaceRoot, relPath);
      if (candidate !== namespaceRoot && !candidate.startsWith(namespaceRootWithSep)) {
        return null;
      }
      callsToReadFile.push(candidate);
      try {
        const raw = await fs.readFile(candidate, "utf-8");
        const fm = raw.match(/category:\s*(\w+)/);
        return {
          category: fm?.[1] ?? "unknown",
          label: path.basename(candidate, path.extname(candidate)),
        };
      } catch {
        return null;
      }
    };

    // Drive `buildGraphSnapshot` with three edges: benign / absolute /
    // traversing.  The metadata for the secret memory must never be
    // read — assert via both the snapshot kind AND the recorded read
    // attempts.
    await appendEdge(nsA, {
      from: "facts/2026-04-20/alpha.md",
      to: "facts/2026-04-20/alpha.md",
      type: "entity",
      weight: 1.0,
      label: "self-loop",
      ts: "2026-04-20T12:00:00.000Z",
    });
    await appendEdge(nsA, {
      from: "facts/2026-04-20/alpha.md",
      to: secretPath,
      type: "entity",
      weight: 1.0,
      label: "absolute",
      ts: "2026-04-20T12:01:00.000Z",
    });
    await appendEdge(nsA, {
      from: "facts/2026-04-20/alpha.md",
      to: "../ns-b/secret.md",
      type: "entity",
      weight: 1.0,
      label: "traversal",
      ts: "2026-04-20T12:02:00.000Z",
    });

    const snapshot = await buildGraphSnapshot({
      memoryDir: nsA,
      graphConfig: {
        entityGraph: true,
        timeGraph: true,
        causalGraph: true,
      },
      request: {},
      loadNode: guardedLoader,
    });

    // Benign alpha resolves.
    const alpha = snapshot.nodes.find((n) => n.id === "facts/2026-04-20/alpha.md");
    assert.ok(alpha, "alpha node should be present");
    assert.equal(alpha!.kind, "fact");
    // Absolute / traversal endpoints surface as orphan nodes with
    // `kind: "unknown"` — the loader returned null for them.
    const absoluteNode = snapshot.nodes.find((n) => n.id === secretPath);
    const traversalNode = snapshot.nodes.find((n) => n.id === "../ns-b/secret.md");
    assert.ok(absoluteNode);
    assert.ok(traversalNode);
    assert.equal(absoluteNode!.kind, "unknown");
    assert.equal(traversalNode!.kind, "unknown");
    // Critically: we never attempted to read the secret file on disk.
    for (const call of callsToReadFile) {
      assert.ok(
        call.startsWith(namespaceRootWithSep) || call === namespaceRoot,
        `file read escaped namespace: ${call}`,
      );
      assert.ok(!call.includes("secret.md"), `secret file must never be read: ${call}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildGraphSnapshot rejects empty categories array", async () => {
  const dir = await makeFixtureDir();
  try {
    await seedEdges(dir);
    await assert.rejects(
      buildGraphSnapshot({
        memoryDir: dir,
        graphConfig: {
          entityGraph: true,
          timeGraph: true,
          causalGraph: true,
        },
        request: { categories: [] },
        loadNode: buildLoader(),
      }),
      /at least one non-empty value/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP surface tests
// ─────────────────────────────────────────────────────────────────────────────

function createFakeService(overrides: Partial<EngramAccessService> = {}): EngramAccessService {
  return {
    graphSnapshot: async (request: { limit?: number; namespace?: string }) => ({
      nodes: [
        {
          id: "facts/2026-04-20/alpha.md",
          label: "alpha",
          kind: "fact",
          score: 0.9,
          lastUpdated: "2026-04-20T12:00:00.000Z",
        },
      ],
      edges: [
        {
          source: "facts/2026-04-20/alpha.md",
          target: "facts/2026-04-20/beta.md",
          kind: "entity" as const,
          confidence: 0.9,
        },
      ],
      generatedAt: "2026-04-20T12:30:00.000Z",
      ...(request.limit !== undefined ? { _capturedLimit: request.limit } : {}),
      ...(request.namespace !== undefined ? { _capturedNamespace: request.namespace } : {}),
    }),
    ...overrides,
  } as unknown as EngramAccessService;
}

test("HTTP /engram/v1/graph/snapshot rejects unauthenticated requests", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(`http://${started.host}:${started.port}/engram/v1/graph/snapshot`);
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot returns nodes and edges", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as GraphSnapshotResponse;
    assert.equal(body.edges.length, 1);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.edges[0]!.source, "facts/2026-04-20/alpha.md");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects invalid limit", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?limit=abc`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_limit");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects invalid since", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?since=not-a-date`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_since");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot rejects empty categories list", async () => {
  const server = new EngramAccessHttpServer({
    service: createFakeService(),
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const res = await fetch(
      `http://${started.host}:${started.port}/engram/v1/graph/snapshot?categories=,,,`,
      { headers: { Authorization: "Bearer secret-token" } },
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "invalid_categories");
  } finally {
    await server.stop();
  }
});

test("HTTP /engram/v1/graph/snapshot forwards filters to the service", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const service = createFakeService({
    graphSnapshot: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        nodes: [],
        edges: [],
        generatedAt: "2026-04-20T12:30:00.000Z",
      };
    },
  } as unknown as Partial<EngramAccessService>);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const url = `http://${started.host}:${started.port}/engram/v1/graph/snapshot`
      + `?limit=42&since=2026-04-20T00:00:00Z&focusNodeId=facts%2Falpha.md`
      + `&categories=fact,decision`;
    const res = await fetch(url, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(res.status, 200);
    assert.equal(captured.length, 1);
    const args = captured[0]!;
    assert.equal(args.limit, 42);
    assert.equal(args.since, "2026-04-20T00:00:00Z");
    assert.equal(args.focusNodeId, "facts/alpha.md");
    assert.deepEqual(args.categories, ["fact", "decision"]);
  } finally {
    await server.stop();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP surface tests
// ─────────────────────────────────────────────────────────────────────────────

test("MCP graph_snapshot tool is exposed under both prefixes", async () => {
  const service = createFakeService();
  const mcp = new EngramMcpServer(service);
  const init = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  assert.ok(init);
  const tools = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const listed = (tools?.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  assert.ok(
    listed.includes("engram.graph_snapshot"),
    `expected engram.graph_snapshot in ${listed.join(",")}`,
  );
  assert.ok(
    listed.includes("remnic.graph_snapshot"),
    `expected remnic.graph_snapshot in ${listed.join(",")}`,
  );
});

test("MCP graph_snapshot tool dispatches to the service", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const service = createFakeService({
    graphSnapshot: async (request: Record<string, unknown>) => {
      captured.push(request);
      return {
        nodes: [],
        edges: [],
        generatedAt: "2026-04-20T12:30:00.000Z",
      };
    },
  } as unknown as Partial<EngramAccessService>);
  const mcp = new EngramMcpServer(service);
  await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const result = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.graph_snapshot",
      arguments: {
        limit: 100,
        since: "2026-04-20T00:00:00Z",
        focusNodeId: "facts/x.md",
        categories: ["fact"],
      },
    },
  });
  assert.ok(result?.result);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.limit, 100);
  assert.deepEqual(captured[0]!.categories, ["fact"]);
});

test("MCP graph_snapshot rejects non-numeric limit at the boundary", async () => {
  const service = createFakeService();
  const mcp = new EngramMcpServer(service);
  await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  });
  const result = await mcp.handleRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "engram.graph_snapshot",
      arguments: { limit: "100" },
    },
  });
  // Errors are surfaced via the standard MCP error envelope.
  assert.ok(result);
  const wrapped = result as { result?: { isError?: boolean }; error?: unknown };
  // Either MCP error or `isError: true` content is acceptable; we just need
  // the boundary to NOT silently coerce.
  if (wrapped.error === undefined) {
    assert.equal(wrapped.result?.isError, true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Path-traversal tests for EngramAccessService.graphSnapshot loader (#734)
//
// `GraphEdge.from` / `to` are JSONL-parsed strings.  A malformed edge with
// an absolute path or a `..` traversal must NOT cause `loadNode` to read a
// memory file from outside the resolved namespace root, otherwise file
// metadata can leak across tenants in multi-principal deployments.
// ─────────────────────────────────────────────────────────────────────────────

import { EngramAccessService } from "../src/access-service.js";

function buildSnapshotService(memoryDir: string): {
  service: EngramAccessService;
  readsByPath: string[];
} {
  const readsByPath: string[] = [];
  const config = {
    memoryDir,
    namespacesEnabled: false,
    defaultNamespace: "global",
    sharedNamespace: "shared",
    entityGraphEnabled: true,
    timeGraphEnabled: true,
    causalGraphEnabled: true,
    recallCrossNamespaceBudgetEnabled: false,
    recallCrossNamespaceBudgetWindowMs: 60_000,
    recallCrossNamespaceBudgetSoftLimit: 10,
    recallCrossNamespaceBudgetHardLimit: 30,
    recallAuditAnomalyDetectionEnabled: false,
    recallAuditAnomalyWindowMs: 60_000,
    recallAuditAnomalyRepeatQueryLimit: 100,
    recallAuditAnomalyNamespaceWalkLimit: 100,
    recallAuditAnomalyHighCardinalityLimit: 100,
    recallAuditAnomalyRapidFireLimit: 100,
  };
  const orchestrator = {
    config,
    // The path-traversal guard must run BEFORE this storage method is
    // invoked.  Tests capture every path that reaches the storage layer so
    // we can assert that bogus endpoints never trigger I/O.
    getStorage: async () => ({
      dir: memoryDir,
      readMemoryByPath: async (filePath: string) => {
        readsByPath.push(filePath);
        return {
          path: filePath,
          content: "",
          frontmatter: {
            id: path.basename(filePath, path.extname(filePath)),
            category: "fact",
            created: "2026-01-01T00:00:00Z",
            updated: "2026-01-01T00:00:00Z",
          },
        };
      },
    }),
  };
  return {
    service: new EngramAccessService(orchestrator as never),
    readsByPath,
  };
}

test(
  "graphSnapshot rejects absolute edge endpoints before reading memory metadata",
  async () => {
    const dir = await makeFixtureDir();
    try {
      // Without the guard, `path.resolve(root, absolutePath)` returns the
      // absolute path verbatim, so a malformed edge could leak metadata
      // from any readable file (e.g. `/etc/passwd`).
      await appendEdge(dir, {
        from: "/etc/passwd",
        to: "facts/2026-04-20/alpha.md",
        type: "entity",
        weight: 1.0,
        label: "exploit",
        ts: "2026-04-20T12:00:00.000Z",
      });
      const { service, readsByPath } = buildSnapshotService(dir);
      const snapshot = await service.graphSnapshot({});
      assert.ok(
        readsByPath.every((p) => !p.includes("/etc/passwd")),
        `expected no read of /etc/passwd, saw ${readsByPath.join(",")}`,
      );
      const passwdNode = snapshot.nodes.find((n) => n.id === "/etc/passwd");
      // The node may still appear in the index (the edge survives and bumps
      // both endpoints) but its metadata must fall through to the
      // unknown-category fallback rather than expose anything from the
      // out-of-namespace file.
      if (passwdNode) {
        assert.equal(passwdNode.kind, "unknown");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "graphSnapshot rejects ../ traversing edge endpoints before reading metadata",
  async () => {
    const dir = await makeFixtureDir();
    try {
      await appendEdge(dir, {
        from: "../../etc/passwd",
        to: "facts/2026-04-20/alpha.md",
        type: "entity",
        weight: 1.0,
        label: "traversal",
        ts: "2026-04-20T12:00:00.000Z",
      });
      const { service, readsByPath } = buildSnapshotService(dir);
      const snapshot = await service.graphSnapshot({});
      assert.ok(
        readsByPath.every((p) => !p.includes("etc/passwd")),
        `expected no read of etc/passwd, saw ${readsByPath.join(",")}`,
      );
      const escapeNode = snapshot.nodes.find((n) => n.id === "../../etc/passwd");
      if (escapeNode) {
        assert.equal(escapeNode.kind, "unknown");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "graphSnapshot loads metadata for valid relative subdir paths",
  async () => {
    const dir = await makeFixtureDir();
    try {
      await appendEdge(dir, {
        from: "facts/2026-04-20/alpha.md",
        to: "facts/2026-04-20/beta.md",
        type: "entity",
        weight: 1.0,
        label: "valid",
        ts: "2026-04-20T12:00:00.000Z",
      });
      const { service, readsByPath } = buildSnapshotService(dir);
      const snapshot = await service.graphSnapshot({});
      assert.equal(snapshot.edges.length, 1);
      // Both endpoints must have hit the loader (storage reads).
      assert.ok(
        readsByPath.some((p) => p.endsWith(path.join("facts", "2026-04-20", "alpha.md"))),
        `expected alpha.md read, saw ${readsByPath.join(",")}`,
      );
      assert.ok(
        readsByPath.some((p) => p.endsWith(path.join("facts", "2026-04-20", "beta.md"))),
        `expected beta.md read, saw ${readsByPath.join(",")}`,
      );
      // Resolved reads must remain inside the namespace root.  The
      // access-service loader canonicalizes the namespace root through
      // `fs.realpath` (issue #691 PR 2/5 follow-up — codex P1 symlink
      // bypass), so on platforms where the tmpdir is itself a symlink
      // (macOS resolves `/var/folders/...` → `/private/var/folders/...`)
      // we have to compare against the realpath form too.
      const fs = await import("node:fs/promises");
      const realDir = await fs.realpath(dir);
      const realDirWithSep = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
      for (const p of readsByPath) {
        assert.ok(
          p.startsWith(realDirWithSep) || p === realDir,
          `read path ${p} escaped namespace root ${realDir}`,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "graphSnapshot loader rejects symlinked endpoints that escape the namespace",
  async () => {
    // Regression for the codex P1 follow-up on PR #734 (symlink bypass):
    // the lexical containment check is insufficient because an
    // in-namespace path can be a symlink to an out-of-namespace file.
    // The loader must canonicalize via `fs.realpath` and reject
    // resolved paths that escape the namespace root.
    const root = await mkdtemp(path.join(os.tmpdir(), "engram-graph-snapshot-symlink-"));
    try {
      const ns = path.join(root, "ns");
      const peer = path.join(root, "peer");
      await mkdir(path.join(ns, "facts", "2026-04-20"), { recursive: true });
      await mkdir(peer, { recursive: true });

      // Out-of-namespace "secret" memory.
      const secret = path.join(peer, "secret.md");
      await writeFile(
        secret,
        "---\nid: secret\ncategory: secret\n---\nsecret\n",
        "utf-8",
      );

      // In-namespace symlink that points at the secret.  A naive
      // lexical guard would accept this because the symlink itself
      // sits under the namespace root.
      const fs = await import("node:fs/promises");
      const symlinked = path.join(ns, "facts", "2026-04-20", "alpha.md");
      await fs.symlink(secret, symlinked);

      // Seed an edge that uses the symlinked path as both endpoints
      // (a self-loop is enough to exercise the guard).
      await appendEdge(ns, {
        from: "facts/2026-04-20/alpha.md",
        to: "facts/2026-04-20/alpha.md",
        type: "entity",
        weight: 1.0,
        label: "symlink",
        ts: "2026-04-20T12:00:00.000Z",
      });

      // Replicate the access-service realpath loader; verify the
      // symlinked endpoint is rejected.
      const namespaceRoot = await fs.realpath(ns);
      const namespaceRootWithSep = namespaceRoot.endsWith(path.sep)
        ? namespaceRoot
        : namespaceRoot + path.sep;
      const readsByPath: string[] = [];
      const guardedLoader = async (relPath: string) => {
        if (path.isAbsolute(relPath)) return null;
        const candidate = path.resolve(namespaceRoot, relPath);
        if (candidate !== namespaceRoot && !candidate.startsWith(namespaceRootWithSep)) {
          return null;
        }
        let canonical: string;
        try {
          canonical = await fs.realpath(candidate);
        } catch {
          canonical = candidate;
        }
        if (canonical !== namespaceRoot && !canonical.startsWith(namespaceRootWithSep)) {
          return null;
        }
        readsByPath.push(canonical);
        // Real file read.
        try {
          const raw = await fs.readFile(canonical, "utf-8");
          const m = raw.match(/category:\s*(\w+)/);
          return {
            category: m?.[1] ?? "unknown",
            label: path.basename(canonical, path.extname(canonical)),
          };
        } catch {
          return null;
        }
      };

      const snapshot = await buildGraphSnapshot({
        memoryDir: ns,
        graphConfig: {
          entityGraph: true,
          timeGraph: true,
          causalGraph: true,
        },
        request: {},
        loadNode: guardedLoader,
      });

      // The symlinked endpoint surfaces as an orphan node with
      // `kind: "unknown"` because the realpath check rejected it.
      const node = snapshot.nodes.find((n) => n.id === "facts/2026-04-20/alpha.md");
      assert.ok(node, "symlinked node should still surface");
      assert.equal(node!.kind, "unknown", "symlinked endpoint must NOT load secret metadata");

      // We never read the secret file via the symlink.
      for (const readPath of readsByPath) {
        assert.ok(
          !readPath.includes("secret.md"),
          `secret file must never be read via symlink: ${readPath}`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "graphSnapshot loads valid in-namespace files when baseDir is itself a symlink",
  async () => {
    // Regression for the Cursor thread PRRT_kwDORJXyws59rLFq on PR #738:
    // if storage.baseDir is a symlink to a real directory, the realpath
    // containment check must compare the realpath of the candidate against
    // the realpath of baseDir — not the raw symlink path.  Without
    // realpath-resolving both sides, a legitimate in-namespace file whose
    // canonical path starts with the *real* directory prefix (not the
    // symlink prefix) would fail the startsWith check and be rejected.
    //
    // This test creates:
    //   root/real-ns/       — the actual memory directory on disk
    //   root/link-ns  → root/real-ns  — symlink used as storage.baseDir
    //
    // Files are seeded into root/real-ns (via the symlink) and the service
    // is constructed with link-ns as memoryDir.  The snapshot must resolve
    // and return metadata for the valid files rather than treating them as
    // out-of-namespace.
    const root = await mkdtemp(path.join(os.tmpdir(), "engram-gs-baselink-"));
    try {
      const realNs = path.join(root, "real-ns");
      const linkNs = path.join(root, "link-ns");
      await mkdir(path.join(realNs, "facts", "2026-04-20"), { recursive: true });
      // Create the symlink: link-ns → real-ns
      await symlink(realNs, linkNs);

      // Seed a valid memory file inside real-ns.
      await writeFile(
        path.join(realNs, "facts", "2026-04-20", "alpha.md"),
        "---\nid: alpha\ncategory: fact\nupdated: 2026-04-20T12:00:00.000Z\n---\nalpha content\n",
        "utf-8",
      );

      // Seed an edge using the symlink path as memoryDir.
      // appendEdge writes to link-ns/.engram-graphs/entity.jsonl which
      // resolves (via the symlink) to real-ns/.engram-graphs/entity.jsonl.
      await appendEdge(linkNs, {
        from: "facts/2026-04-20/alpha.md",
        to: "facts/2026-04-20/alpha.md",
        type: "entity",
        weight: 1.0,
        label: "self",
        ts: "2026-04-20T12:00:00.000Z",
      });

      // Build the service with the *symlink* path as memoryDir.
      const { service, readsByPath } = buildSnapshotService(linkNs);
      const snapshot = await service.graphSnapshot({});

      // The edge must survive (not be dropped as out-of-namespace).
      assert.equal(snapshot.edges.length, 1, "edge should not be filtered out");

      // The alpha node must surface and carry its loaded metadata (not fall
      // back to kind:"unknown", which would indicate the loader returned null).
      const alpha = snapshot.nodes.find((n) => n.id === "facts/2026-04-20/alpha.md");
      assert.ok(alpha, "alpha node should be present in snapshot");
      assert.notEqual(
        alpha!.kind,
        "unknown",
        "symlinked baseDir must not cause in-namespace files to be rejected",
      );

      // At least one storage read must have been attempted for the alpha path.
      assert.ok(
        readsByPath.some((p) => p.endsWith(path.join("facts", "2026-04-20", "alpha.md"))),
        `expected alpha.md read; got: ${readsByPath.join(",")}`,
      );

      // All storage reads must remain within the real namespace root.
      const fs = await import("node:fs/promises");
      const realRoot = await fs.realpath(linkNs);
      const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
      for (const p of readsByPath) {
        assert.ok(
          p === realRoot || p.startsWith(realRootWithSep),
          `read escaped real namespace root: ${p} (real root: ${realRoot})`,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
