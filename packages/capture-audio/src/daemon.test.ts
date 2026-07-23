import assert from "node:assert/strict";
import { after, test } from "node:test";

import { defaultDaemonConfig } from "./config.js";
import { CaptureConfigError } from "./errors.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { Spool } from "./spool.js";
import type { SegmentInput } from "./spool.js";
import { formatHostForUrl } from "./util.js";

const TOKEN = "loopback-token";
const seg: SegmentInput = {
  channel: "mic",
  text: "hello world",
  startUtc: "2026-07-20T10:00:00.000Z",
  endUtc: "2026-07-20T10:00:03.000Z",
};

const open: DaemonHandle[] = [];
const spools: Spool[] = [];
after(async () => {
  for (const h of open) await h.close();
  for (const s of spools) s.close();
});

function seededSpool(): Spool {
  const spool = new Spool(":memory:");
  spools.push(spool);
  spool.insertConversation({ id: "conv_1", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg] });
  spool.insertConversation({ id: "conv_2", startedAtUtc: "2026-07-20T11:00:00.000Z", segments: [seg] });
  spool.insertConversation({ id: "conv_live", startedAtUtc: "2026-07-20T12:00:00.000Z", state: "capturing", segments: [seg] });
  spool.upsertSpeaker({ id: "self", label: "Me", isSelf: true });
  return spool;
}

async function startLoopback(): Promise<DaemonHandle> {
  const config = { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 };
  const handle = await startDaemon({ spool: seededSpool(), config, token: TOKEN });
  open.push(handle);
  return handle;
}

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
}

interface ConvPage {
  conversations: Array<{ id: string }>;
  nextCursor: string | null;
}

test("GET /v1/health returns the health shape incl. instanceId", async () => {
  const h = await startLoopback();
  const res = await authFetch(`${h.url}/v1/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    capturing: boolean;
    version: string;
    pendingChunks: number;
    instanceId: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.capturing, false);
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.pendingChunks, "number");
  assert.equal(typeof body.instanceId, "string");
});

test("GET /v1/conversations serves final-only records with a keyset cursor", async () => {
  const h = await startLoopback();
  const res = await authFetch(`${h.url}/v1/conversations?date=2026-07-20&timezone=UTC&limit=1`);
  assert.equal(res.status, 200);
  const page = (await res.json()) as ConvPage;
  assert.deepEqual(page.conversations.map((c) => c.id), ["conv_1"]);
  assert.ok(page.nextCursor);

  const res2 = await authFetch(
    `${h.url}/v1/conversations?date=2026-07-20&timezone=UTC&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
  );
  const page2 = (await res2.json()) as ConvPage;
  assert.deepEqual(page2.conversations.map((c) => c.id), ["conv_2"]);
  assert.equal(page2.nextCursor, null);
});

test("GET /v1/speakers lists clusters", async () => {
  const h = await startLoopback();
  const res = await authFetch(`${h.url}/v1/speakers`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { speakers: Array<{ id: string; label: string | null; isSelf: boolean }> };
  assert.deepEqual(body.speakers, [{ id: "self", label: "Me", isSelf: true }]);
});

test("invalid date/timezone/limit/cursor each return 400", async () => {
  const h = await startLoopback();
  const bad = [
    "/v1/conversations?timezone=UTC",
    "/v1/conversations?date=2026-13-40&timezone=UTC",
    "/v1/conversations?date=2026-07-20",
    "/v1/conversations?date=2026-07-20&timezone=Not/AZone",
    "/v1/conversations?date=2026-07-20&timezone=UTC&limit=0",
    "/v1/conversations?date=2026-07-20&timezone=UTC&limit=abc",
    "/v1/conversations?date=2026-07-20&timezone=UTC&cursor=%21%21%21bad",
  ];
  for (const p of bad) {
    const res = await authFetch(`${h.url}${p}`);
    assert.equal(res.status, 400, `expected 400 for ${p}, got ${res.status}`);
  }
});

test("unknown route is 404; authed non-GET is 405; unauth non-GET is 401 (authorize first)", async () => {
  const h = await startLoopback();
  assert.equal((await authFetch(`${h.url}/v1/nope`)).status, 404);
  assert.equal((await authFetch(`${h.url}/v1/health`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${h.url}/v1/health`, { method: "POST" })).status, 401);
});

test("every request requires a valid bearer token (loopback included)", async () => {
  const h = await startLoopback();
  assert.equal((await fetch(`${h.url}/v1/health`)).status, 401, "missing token must be 401");
  assert.equal(
    (await fetch(`${h.url}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status,
    401,
    "wrong token must be 401",
  );
  assert.equal((await authFetch(`${h.url}/v1/health`)).status, 200, "correct token must be 200");
});

test("startDaemon refuses to bind a non-loopback host (no TLS contract)", async () => {
  const config = { ...defaultDaemonConfig(), host: "0.0.0.0", port: 0 };
  await assert.rejects(startDaemon({ spool: seededSpool(), config, token: TOKEN }), CaptureConfigError);
});

test("startDaemon requires a non-empty token", async () => {
  const config = { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 };
  await assert.rejects(startDaemon({ spool: seededSpool(), config, token: "" }), CaptureConfigError);
});

test("formatHostForUrl brackets IPv6 hosts only", () => {
  assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(formatHostForUrl("localhost"), "localhost");
  assert.equal(formatHostForUrl("::1"), "[::1]");
});
