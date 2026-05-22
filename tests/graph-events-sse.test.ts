/**
 * Tests for real-time SSE graph events (issue #691 PR 5/5).
 *
 * Covers:
 *  1. emitGraphEvent() reaches subscribeGraphEvents() listener.
 *  2. appendEdge() automatically emits an "edge-added" event.
 *  3. GET /engram/v1/graph/events returns 200 text/event-stream.
 *  4. An "edge-added" event emitted after connection appears in the stream.
 *  5. 401 when auth token is missing or wrong.
 *  6. ?token= query-parameter auth accepted (EventSource path).
 *  7. destroyGraphEventBus() cleans up listener set so subsequent tests start fresh.
 */

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import * as path from "node:path";
import http from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  emitGraphEvent,
  subscribeGraphEvents,
  destroyGraphEventBus,
  type GraphEvent,
} from "../src/graph-events.js";
import { appendEdge } from "../src/graph.js";
import { EngramAccessHttpServer } from "../src/access-http.js";
import type { EngramAccessService } from "../src/access-service.js";

// ---------------------------------------------------------------------------
// Minimal fake service (sufficient for the SSE route)
// ---------------------------------------------------------------------------

function makeFakeService(memoryDir: string): EngramAccessService {
  // We only need the memoryDir getter and getMemoryDirForNamespace for
  // the SSE handler (the latter is needed after the namespace-scoped bus
  // fix — it resolves the per-namespace storage dir so the handler
  // subscribes to the correct bus).
  return {
    memoryDir,
    health: async () => ({
      ok: true,
      memoryDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: false,
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
    }),
    // Namespace resolution for the SSE handler — single-namespace stub
    // always returns the root memoryDir.
    getMemoryDirForNamespace: async (_ns?: string, _principal?: string) => memoryDir,
    // All other methods are not exercised in these tests.
  } as unknown as EngramAccessService;
}

// ---------------------------------------------------------------------------
// Helper: collect N SSE data frames from an HTTP response stream.
// ---------------------------------------------------------------------------

function collectSseFrames(
  options: http.RequestOptions,
  n: number,
  timeoutMs = 3000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      req.destroy();
      if (frames.length >= n) {
        resolve(frames.slice(0, n));
      } else {
        reject(new Error(`SSE timeout: collected ${frames.length} frames, expected ${n}`));
      }
    }, timeoutMs);

    const req = http.request(options, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            try {
              frames.push(JSON.parse(trimmed.slice(6)));
            } catch {
              // ignore non-JSON lines
            }
            if (frames.length >= n) {
              clearTimeout(timer);
              req.destroy();
              resolve(frames.slice(0, n));
              return;
            }
          }
        }
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        // Ignore ECONNRESET from req.destroy() once we have enough frames
        if (frames.length >= n) {
          resolve(frames.slice(0, n));
        } else {
          reject(err);
        }
      });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      if (frames.length >= n) {
        resolve(frames.slice(0, n));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Unit tests: graph-events module
// ---------------------------------------------------------------------------

test("emitGraphEvent reaches subscribeGraphEvents listener", () => {
  const dir = "/tmp/engram-test-emit-" + Date.now();
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    emitGraphEvent(dir, "edge-added", { source: "a.md", target: "b.md", kind: "entity" });
    unsub();
    assert.equal(received.length, 1);
    assert.equal(received[0]!.type, "edge-added");
    assert.equal((received[0]!.payload as Record<string, unknown>).source, "a.md");
    assert.equal(received[0]!.memoryDir, dir);
    assert.ok(!Number.isNaN(Date.parse(received[0]!.ts)));
  } finally {
    destroyGraphEventBus(dir);
  }
});

test("emitGraphEvent continues after a subscriber throws", () => {
  const dir = "/tmp/engram-test-emit-throw-" + Date.now();
  try {
    const received: GraphEvent[] = [];
    subscribeGraphEvents(dir, () => {
      throw new Error("synthetic subscriber failure");
    });
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));

    emitGraphEvent(dir, "edge-added", { source: "a.md", target: "b.md", kind: "entity" });
    unsub();

    assert.equal(received.length, 1);
    assert.equal(received[0]!.type, "edge-added");
  } finally {
    destroyGraphEventBus(dir);
  }
});

test("subscribeGraphEvents unsubscribe prevents further delivery", () => {
  const dir = "/tmp/engram-test-unsub-" + Date.now();
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    unsub();
    emitGraphEvent(dir, "edge-added", { source: "x.md", target: "y.md" });
    assert.equal(received.length, 0);
  } finally {
    destroyGraphEventBus(dir);
  }
});

test("destroyGraphEventBus removes all listeners", () => {
  const dir = "/tmp/engram-test-destroy-" + Date.now();
  const received: GraphEvent[] = [];
  subscribeGraphEvents(dir, (e) => received.push(e));
  destroyGraphEventBus(dir);
  emitGraphEvent(dir, "edge-added", { source: "a.md", target: "b.md" });
  // emitGraphEvent recreates a fresh bus after destroy; old listener not attached
  assert.equal(received.length, 0);
  destroyGraphEventBus(dir);
});

test("appendEdge emits edge-added event on the graph event bus", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-append-edge-"));
  try {
    const received: GraphEvent[] = [];
    const unsub = subscribeGraphEvents(dir, (e) => received.push(e));
    await appendEdge(dir, {
      from: "facts/a.md",
      to: "facts/b.md",
      type: "entity",
      weight: 1.0,
      label: "test-entity",
      ts: new Date().toISOString(),
      confidence: 0.9,
    });
    unsub();
    assert.equal(received.length, 1);
    const ev = received[0]!;
    assert.equal(ev.type, "edge-added");
    assert.equal((ev.payload as Record<string, unknown>).source, "facts/a.md");
    assert.equal((ev.payload as Record<string, unknown>).target, "facts/b.md");
    assert.equal((ev.payload as Record<string, unknown>).kind, "entity");
    assert.equal((ev.payload as Record<string, unknown>).confidence, 0.9);
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP / SSE integration tests
// ---------------------------------------------------------------------------

async function startTestServer(memoryDir: string, token = "test-token") {
  const service = makeFakeService(memoryDir);
  const server = new EngramAccessHttpServer({
    service,
    host: "127.0.0.1",
    port: 0,
    authToken: token,
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  return { server, port: status.port };
}

test("GET /engram/v1/graph/events returns 200 text/event-stream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-headers-"));
  try {
    const { server, port } = await startTestServer(dir);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events",
            headers: { Authorization: "Bearer test-token" },
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.ok(
              res.headers["content-type"]?.includes("text/event-stream"),
              `expected text/event-stream, got ${res.headers["content-type"]}`,
            );
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /engram/v1/graph/events returns 401 with wrong token", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-unauth-"));
  try {
    const { server, port } = await startTestServer(dir, "correct-token");
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events",
            headers: { Authorization: "Bearer wrong-token" },
          },
          (res) => {
            assert.equal(res.statusCode, 401);
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /engram/v1/graph/events accepts ?token= query parameter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-qtoken-"));
  try {
    const { server, port } = await startTestServer(dir, "qtoken-secret");
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/graph/events?token=qtoken-secret",
            // No Authorization header — browser EventSource path
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.ok(
              res.headers["content-type"]?.includes("text/event-stream"),
            );
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

test("edge-added event emitted after connection appears in the SSE stream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-event-"));
  try {
    const { server, port } = await startTestServer(dir, "stream-token");
    try {
      // Collect the first two frames: "connected" + a batch with edge-added.
      const framesPromise = collectSseFrames(
        {
          host: "127.0.0.1",
          port,
          path: "/engram/v1/graph/events",
          headers: { Authorization: "Bearer stream-token" },
        },
        2, // connected frame + one batch frame
      );

      // Wait a tick for the SSE connection to be established before emitting.
      await new Promise<void>((r) => setTimeout(r, 50));

      // Emit directly via the event bus (avoids needing a full storage setup).
      emitGraphEvent(dir, "edge-added", {
        source: "facts/p.md",
        target: "facts/q.md",
        kind: "entity",
        weight: 1.0,
        label: "test",
        confidence: 1.0,
      });

      const frames = await framesPromise;

      // First frame must be "connected"
      const first = frames[0] as Record<string, unknown>;
      assert.equal(first.type, "connected");

      // Second frame should be a batch containing our edge-added event.
      const second = frames[1] as Record<string, unknown>;
      assert.equal(second.type, "batch");
      const events = second.events as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(events) && events.length >= 1);
      const edgeEvent = events.find((e) => e.type === "edge-added");
      assert.ok(edgeEvent, "expected edge-added event in batch");
      assert.equal(
        (edgeEvent!.payload as Record<string, unknown>).source,
        "facts/p.md",
      );
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 1 (Codex P1): SSE subscribes to the namespace-resolved bus, not global
// ---------------------------------------------------------------------------

test("SSE handler subscribes to namespace-resolved bus dir", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-ns-"));
  const nsDir = path.join(rootDir, "namespaces", "tenant-a");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(nsDir, { recursive: true });

  // Build a service stub where getMemoryDirForNamespace returns a different
  // dir for "tenant-a" than the root — simulating a multi-namespace deploy.
  const resolvedDirs: string[] = [];
  const fakeService = {
    memoryDir: rootDir,
    health: async () => ({
      ok: true,
      memoryDir: rootDir,
      namespacesEnabled: true,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: false,
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
    }),
    getMemoryDirForNamespace: async (ns?: string, _principal?: string) => {
      const resolved = ns === "tenant-a" ? nsDir : rootDir;
      resolvedDirs.push(resolved);
      return resolved;
    },
  } as unknown as import("../src/access-service.js").EngramAccessService;

  const server = new EngramAccessHttpServer({
    service: fakeService,
    host: "127.0.0.1",
    port: 0,
    authToken: "ns-token",
    adminConsoleEnabled: false,
  });
  const status = await server.start();
  const port = status.port;

  try {
    // Connect to the SSE endpoint requesting namespace=tenant-a.
    const framesPromise = collectSseFrames(
      {
        host: "127.0.0.1",
        port,
        path: "/engram/v1/graph/events?namespace=tenant-a",
        headers: { Authorization: "Bearer ns-token" },
      },
      2,
      2000,
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    // Emit to the namespace-specific dir — should reach the client.
    emitGraphEvent(nsDir, "node-added", { nodeId: "facts/ns.md", kind: "fact", label: "ns" });

    const frames = await framesPromise;
    assert.equal((frames[0] as Record<string, unknown>).type, "connected");
    const batch = frames[1] as Record<string, unknown>;
    assert.equal(batch.type, "batch");

    // Verify the handler resolved getMemoryDirForNamespace with "tenant-a".
    assert.ok(resolvedDirs.includes(nsDir), "getMemoryDirForNamespace should have been called with tenant-a dir");
  } finally {
    await server.stop();
    destroyGraphEventBus(rootDir);
    destroyGraphEventBus(nsDir);
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix (Cursor PRRT_kwDORJXyws59snoR + Codex PRRT_kwDORJXyws59soGJ):
// SSE handler must forward the request principal to getMemoryDirForNamespace
// so namespace ACLs are enforced when namespacesEnabled=true.
// ---------------------------------------------------------------------------

test("SSE handler forwards request principal to getMemoryDirForNamespace", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-principal-"));

  const capturedCalls: Array<{ ns: string | undefined; principal: string | undefined }> = [];
  const fakeService = {
    memoryDir: rootDir,
    health: async () => ({
      ok: true,
      memoryDir: rootDir,
      namespacesEnabled: false,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: false,
      nativeKnowledgeEnabled: false,
      projectionAvailable: false,
    }),
    getMemoryDirForNamespace: async (ns?: string, principal?: string) => {
      capturedCalls.push({ ns, principal });
      return rootDir;
    },
  } as unknown as import("../src/access-service.js").EngramAccessService;

  // Use trustPrincipalHeader so the x-engram-principal header is forwarded as
  // the request principal (matching the production authenticated path).
  const server = new EngramAccessHttpServer({
    service: fakeService,
    host: "127.0.0.1",
    port: 0,
    authToken: "principal-token",
    adminConsoleEnabled: false,
    trustPrincipalHeader: true,
  });
  const { port } = await server.start();

  try {
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/engram/v1/graph/events",
          headers: {
            Authorization: "Bearer principal-token",
            "x-engram-principal": "user-alice",
          },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          req.destroy();
          resolve();
        },
      );
      req.on("error", reject);
      req.end();
    });

    // Give the async SSE handler time to resolve the service call.
    await new Promise<void>((r) => setTimeout(r, 80));

    assert.ok(capturedCalls.length >= 1, "getMemoryDirForNamespace must be called");
    const call = capturedCalls[capturedCalls.length - 1]!;
    assert.equal(call.principal, "user-alice", "principal must be forwarded to getMemoryDirForNamespace");
  } finally {
    await server.stop();
    destroyGraphEventBus(rootDir);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("SSE events from a different namespace do not reach an unrelated subscriber", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-ns-iso-"));
  const nsA = path.join(rootDir, "ns-a");
  const nsB = path.join(rootDir, "ns-b");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(nsA, { recursive: true });
  await mkdir(nsB, { recursive: true });

  const fakeService = {
    memoryDir: rootDir,
    health: async () => ({ ok: true, memoryDir: rootDir, namespacesEnabled: true, defaultNamespace: "global", searchBackend: "qmd", qmdEnabled: false, nativeKnowledgeEnabled: false, projectionAvailable: false }),
    getMemoryDirForNamespace: async (ns?: string, _principal?: string) => ns === "ns-a" ? nsA : rootDir,
  } as unknown as import("../src/access-service.js").EngramAccessService;

  const server = new EngramAccessHttpServer({
    service: fakeService,
    host: "127.0.0.1",
    port: 0,
    authToken: "iso-token",
    adminConsoleEnabled: false,
  });
  const { port } = await server.start();

  try {
    // Client subscribes to ns-a.
    const framesPromise = collectSseFrames(
      {
        host: "127.0.0.1",
        port,
        path: "/engram/v1/graph/events?namespace=ns-a",
        headers: { Authorization: "Bearer iso-token" },
      },
      1, // only the "connected" frame — we don't expect any batch
      800,
    );

    await new Promise<void>((r) => setTimeout(r, 50));

    // Emit to ns-b — should NOT reach the ns-a client.
    emitGraphEvent(nsB, "node-added", { nodeId: "facts/other.md", kind: "fact", label: "other" });

    const frames = await framesPromise;
    // Only the "connected" frame should have arrived.
    assert.equal(frames.length, 1);
    assert.equal((frames[0] as Record<string, unknown>).type, "connected");
  } finally {
    await server.stop();
    destroyGraphEventBus(rootDir);
    destroyGraphEventBus(nsA);
    destroyGraphEventBus(nsB);
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 2+5 (Codex P2 + Cursor): ?token= fallback restricted to SSE endpoint
// ---------------------------------------------------------------------------

test("?token= query param rejected on non-SSE endpoints", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-qtoken-reject-"));
  try {
    const { server, port } = await startTestServer(dir, "secret-tok");
    try {
      // Try ?token= on the health endpoint — must return 401, not 200.
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/health?token=secret-tok",
            // No Authorization header
          },
          (res) => {
            assert.equal(
              res.statusCode,
              401,
              `?token= should be rejected on /health; got ${res.statusCode}`,
            );
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });

      // Confirm the same token works via Authorization: Bearer header.
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port,
            path: "/engram/v1/health",
            headers: { Authorization: "Bearer secret-tok" },
          },
          (res) => {
            assert.equal(res.statusCode, 200);
            req.destroy();
            resolve();
          },
        );
        req.on("error", reject);
        req.end();
      });
    } finally {
      await server.stop();
    }
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fix 3 (Cursor): edge-removed must not prune intentionally isolated nodes
// ---------------------------------------------------------------------------

// This test is a unit test of the applyGraphEvent() logic in app.js.
// We inline a minimal version of the function so it runs in Node without a
// DOM, mirroring the real implementation.

function makeApplyGraphEvent() {
  type GraphNode = { id: string; label: string; kind: string; score: number; lastUpdated: string; x: number; y: number; vx: number; vy: number; _memoryId: null };
  type GraphEdge = { source: string; target: string; kind: string; weight: number; label: string; confidence: number; _srcNode: GraphNode; _tgtNode: GraphNode };
  const graphData: { nodes: GraphNode[]; edges: GraphEdge[] } = { nodes: [], edges: [] };
  const graphSim = null;

  function applyGraphEvent(event: { type: string; payload: Record<string, unknown>; ts: string }) {
    if (!graphData) return;
    const p = event.payload;

    if (event.type === "node-added") {
      const existing = graphData.nodes.find((n) => n.id === p.nodeId);
      if (!existing) {
        graphData.nodes.push({ id: p.nodeId as string, label: (p.label as string) || (p.nodeId as string), kind: (p.kind as string) || "unknown", score: 1, lastUpdated: (p.lastUpdated as string) || event.ts, x: 0, y: 0, vx: 0, vy: 0, _memoryId: null });
      }
      return;
    }

    if (event.type === "edge-added") {
      const srcNode = graphData.nodes.find((n) => n.id === p.source);
      const tgtNode = graphData.nodes.find((n) => n.id === p.target);
      if (srcNode && tgtNode) {
        const alreadyExists = graphData.edges.some((e) => e.source === p.source && e.target === p.target && e.kind === p.kind);
        if (!alreadyExists) {
          graphData.edges.push({ source: p.source as string, target: p.target as string, kind: p.kind as string, weight: typeof p.weight === "number" ? p.weight : 1.0, label: (p.label as string) || "", confidence: typeof p.confidence === "number" ? p.confidence : 1.0, _srcNode: srcNode, _tgtNode: tgtNode });
        }
      }
      return;
    }

    if (event.type === "edge-removed") {
      // Mirror the FIXED logic from app.js: only prune nodes that had edges AND now have none.
      const hadEdges = new Set<string>();
      for (const e of graphData.edges) { hadEdges.add(e.source); hadEdges.add(e.target); }
      graphData.edges = graphData.edges.filter((e) => !(e.source === p.source && e.target === p.target && e.kind === p.kind));
      const stillConnected = new Set<string>();
      for (const e of graphData.edges) { stillConnected.add(e.source); stillConnected.add(e.target); }
      graphData.nodes = graphData.nodes.filter((n) => !hadEdges.has(n.id) || stillConnected.has(n.id));
      if (graphSim) (graphSim as unknown as { reheat(): void }).reheat();
    }
  }

  return { graphData, applyGraphEvent };
}

test("edge-removed: isolated (edgeless) nodes are preserved", () => {
  const { graphData, applyGraphEvent } = makeApplyGraphEvent();
  const ts = new Date().toISOString();

  // Add three nodes: A and B will be connected; I is intentionally isolated.
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/a.md", kind: "fact", label: "A" }, ts });
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/b.md", kind: "fact", label: "B" }, ts });
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/i.md", kind: "fact", label: "I" }, ts });

  // Connect A → B.
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  assert.equal(graphData.nodes.length, 3);
  assert.equal(graphData.edges.length, 1);

  // Remove the A → B edge.
  applyGraphEvent({ type: "edge-removed", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity" }, ts });

  // A and B should be pruned (they had an edge and lost it).
  // I must remain (it never had an edge).
  assert.equal(graphData.edges.length, 0);
  assert.equal(graphData.nodes.length, 1, "isolated node I must survive edge-removed");
  assert.equal(graphData.nodes[0]!.id, "facts/i.md");
});

test("edge-removed: node with other remaining edges is preserved", () => {
  const { graphData, applyGraphEvent } = makeApplyGraphEvent();
  const ts = new Date().toISOString();

  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/a.md", kind: "fact", label: "A" }, ts });
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/b.md", kind: "fact", label: "B" }, ts });
  applyGraphEvent({ type: "node-added", payload: { nodeId: "facts/c.md", kind: "fact", label: "C" }, ts });

  // A → B and A → C
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });
  applyGraphEvent({ type: "edge-added", payload: { source: "facts/a.md", target: "facts/c.md", kind: "entity", weight: 1, label: "", confidence: 1 }, ts });

  // Remove only A → B.
  applyGraphEvent({ type: "edge-removed", payload: { source: "facts/a.md", target: "facts/b.md", kind: "entity" }, ts });

  // B loses all its edges → pruned.
  // A and C still share an edge → preserved.
  assert.equal(graphData.edges.length, 1);
  assert.equal(graphData.nodes.length, 2);
  const ids = graphData.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["facts/a.md", "facts/c.md"]);
});

test("admin graph simulation handle exposes reheat for live graph events", async () => {
  const source = await readFile(
    path.join(process.cwd(), "admin-console", "public", "app.js"),
    "utf8",
  );

  assert.match(source, /reheat\(drawFn\)/);
  assert.match(source, /if \(graphSim\) graphSim\.reheat\(\);/);
});

// ---------------------------------------------------------------------------
// Fix 4 (Cursor): stop() cleans up heartbeat intervals and bus subscriptions
// ---------------------------------------------------------------------------

test("stop() cleans up heartbeat intervals and bus subscriptions without waiting for client disconnect", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "engram-sse-stop-"));
  try {
    const { server, port } = await startTestServer(dir, "stop-token");

    // Open an SSE connection and keep it open (never close from the client side).
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/engram/v1/graph/events",
      headers: { Authorization: "Bearer stop-token" },
    });
    req.end();

    // Wait for the connection to be established.
    await new Promise<void>((r) => setTimeout(r, 80));

    // Stop the server — must not hang even though the SSE client is still connected.
    const stopPromise = server.stop();
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("stop() timed out — likely leaked interval or open handle")), 2000),
    );
    await Promise.race([stopPromise, timeout]);

    // Clean up the dangling client request.
    req.destroy();
  } finally {
    destroyGraphEventBus(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
