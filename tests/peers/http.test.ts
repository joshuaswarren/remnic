/**
 * HTTP-surface tests for the peer registry endpoints (issue #679 PR 4/5).
 *
 * Endpoints covered:
 *   GET    /engram/v1/peers              — list all peers
 *   GET    /engram/v1/peers/:id          — get one peer
 *   PUT    /engram/v1/peers/:id          — upsert (create/update)
 *   DELETE /engram/v1/peers/:id          — delete (idempotent)
 *   GET    /engram/v1/peers/:id/profile  — get peer profile
 *
 * Uses a minimal fake EngramAccessService, matching the pattern in
 * tests/access-http.test.ts. No real filesystem I/O is performed here.
 *
 * All test data is synthetic (CLAUDE.md public-repo rule).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessHttpServer } from "../../packages/remnic-core/src/access-http.js";
import type { EngramAccessService } from "../../packages/remnic-core/src/access-service.js";

const AUTH_TOKEN = "test-token-peers-http";
const BASE_URL = "http://127.0.0.1";

// ──────────────────────────────────────────────────────────────────────
// Fake service
// ──────────────────────────────────────────────────────────────────────

const FAKE_PEER = {
  id: "alice",
  kind: "human" as const,
  displayName: "Alice",
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const FAKE_PROFILE = {
  peerId: "alice",
  updatedAt: "2026-04-10T00:00:00.000Z",
  fields: { communication_style: "Async, concise." },
  provenance: {},
};

function createFakeService(): EngramAccessService {
  return {
    health: async () => ({
      ok: true,
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledgeEnabled: false,
      projectionAvailable: true,
    }),
    peerList: async () => ({ peers: [FAKE_PEER] }),
    peerGet: async (id: string) =>
      id === "alice"
        ? { found: true, peer: FAKE_PEER }
        : { found: false },
    peerSet: async ({ id }: { id: string }) => ({
      ok: true,
      created: id !== "alice",
      peer: { ...FAKE_PEER, id },
    }),
    peerDelete: async (id: string) => ({
      ok: true,
      deleted: id === "alice",
    }),
    peerProfileGet: async (id: string) =>
      id === "alice"
        ? { found: true, profile: FAKE_PROFILE }
        : { found: false },
  } as unknown as EngramAccessService;
}

// ──────────────────────────────────────────────────────────────────────
// Helper
// ──────────────────────────────────────────────────────────────────────

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const url = `${BASE_URL}:${port}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      "content-type": "application/json",
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = await res.json();
  return { status: res.status, json };
}

// ──────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────

test("GET /engram/v1/peers — returns peer list", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers");
    assert.equal(status, 200);
    const body = json as { peers: unknown[] };
    assert.ok(Array.isArray(body.peers));
    assert.equal(body.peers.length, 1);
    const peer = body.peers[0] as { id: string };
    assert.equal(peer.id, "alice");
  } finally {
    await server.stop();
  }
});

test("GET /engram/v1/peers/:id — returns peer when found", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers/alice");
    assert.equal(status, 200);
    const body = json as { found: boolean; peer: { id: string } };
    assert.equal(body.found, true);
    assert.equal(body.peer.id, "alice");
  } finally {
    await server.stop();
  }
});

test("GET /engram/v1/peers/:id — 404 when not found", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers/nobody");
    assert.equal(status, 404);
    const body = json as { error: string };
    assert.equal(body.error, "peer_not_found");
  } finally {
    await server.stop();
  }
});

test("PUT /engram/v1/peers/:id — 201 on create", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "PUT", "/engram/v1/peers/new-peer", {
      kind: "agent",
      displayName: "New Peer",
    });
    assert.equal(status, 201);
    const body = json as { ok: boolean; created: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
  } finally {
    await server.stop();
  }
});

test("PUT /engram/v1/peers/:id — 200 on update (alice already exists)", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "PUT", "/engram/v1/peers/alice", {
      displayName: "Alice Updated",
    });
    assert.equal(status, 200);
    const body = json as { ok: boolean; created: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.created, false);
  } finally {
    await server.stop();
  }
});

test("DELETE /engram/v1/peers/:id — 200 with deleted:true when peer exists", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "DELETE", "/engram/v1/peers/alice");
    assert.equal(status, 200);
    const body = json as { ok: boolean; deleted: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.deleted, true);
  } finally {
    await server.stop();
  }
});

test("DELETE /engram/v1/peers/:id — 200 with deleted:false when peer absent", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "DELETE", "/engram/v1/peers/nobody");
    assert.equal(status, 200);
    const body = json as { ok: boolean; deleted: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.deleted, false);
  } finally {
    await server.stop();
  }
});

test("GET /engram/v1/peers/:id/profile — 200 when profile exists", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers/alice/profile");
    assert.equal(status, 200);
    const body = json as { found: boolean; profile: { peerId: string } };
    assert.equal(body.found, true);
    assert.equal(body.profile.peerId, "alice");
  } finally {
    await server.stop();
  }
});

test("GET /engram/v1/peers/:id/profile — 404 when no profile", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers/nobody/profile");
    assert.equal(status, 404);
    const body = json as { error: string };
    assert.equal(body.error, "peer_profile_not_found");
  } finally {
    await server.stop();
  }
});

test("POST /engram/v1/peers/:id — 405 method not allowed", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status } = await request(port, "POST", "/engram/v1/peers/alice");
    assert.equal(status, 405);
  } finally {
    await server.stop();
  }
});

// ──────────────────────────────────────────────────────────────────────
// PR #756 review: input-hardening for the peer ID surface.
// ──────────────────────────────────────────────────────────────────────

test("GET /engram/v1/peers/:id — malformed percent-encoding returns 400 not 500", async () => {
  // Codex P2 #1 (PR #756): a path segment like `%E0%A4%A` is malformed
  // percent-encoding. The handler must convert the URIError into a 400
  // client-error rather than letting it bubble up as a 500.
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "GET", "/engram/v1/peers/%E0%A4%A");
    assert.equal(status, 400);
    const body = json as { error: string; code: string };
    assert.equal(body.code, "input_error");
    assert.match(body.error, /percent-encoded/);
  } finally {
    await server.stop();
  }
});

test("PUT /engram/v1/peers/:id — non-string `kind` is rejected with 400", async () => {
  // Codex P2 #2 (PR #756): a payload like `{ "kind": 123 }` previously
  // got coerced to undefined and silently fell back to the "human"
  // default on create. The handler must reject the malformed type up
  // front rather than producing an unintended record.
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "PUT", "/engram/v1/peers/bob", { kind: 123 });
    assert.equal(status, 400);
    const body = json as { error: string; code: string };
    assert.equal(body.code, "input_error");
    assert.match(body.error, /kind must be a string/);
  } finally {
    await server.stop();
  }
});

test("PUT /engram/v1/peers/:id — non-string `displayName` is rejected with 400", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "PUT", "/engram/v1/peers/bob", {
      displayName: 42,
    });
    assert.equal(status, 400);
    const body = json as { error: string; code: string };
    assert.equal(body.code, "input_error");
    assert.match(body.error, /displayName must be a string/);
  } finally {
    await server.stop();
  }
});

test("PUT /engram/v1/peers/:id — non-string `notes` is rejected with 400", async () => {
  const service = createFakeService();
  const server = new EngramAccessHttpServer({ service, authToken: AUTH_TOKEN });
  const { port } = await server.start();
  try {
    const { status, json } = await request(port, "PUT", "/engram/v1/peers/bob", {
      notes: { a: 1 },
    });
    assert.equal(status, 400);
    const body = json as { error: string; code: string };
    assert.equal(body.code, "input_error");
    assert.match(body.error, /notes must be a string/);
  } finally {
    await server.stop();
  }
});
