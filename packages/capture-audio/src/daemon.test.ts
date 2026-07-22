import assert from "node:assert/strict";
import { after, test } from "node:test";

import { defaultDaemonConfig } from "./config.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { Spool } from "./spool.js";
import type { SegmentInput } from "./spool.js";

const seg: SegmentInput = {
  channel: "mic",
  text: "hello world",
  startUtc: "2026-07-20T10:00:00.000Z",
  endUtc: "2026-07-20T10:00:03.000Z",
};

const open: DaemonHandle[] = [];
after(async () => {
  for (const h of open) await h.close();
});

function seededSpool(): Spool {
  const spool = new Spool(":memory:");
  spool.insertConversation({ id: "conv_1", startedAtUtc: "2026-07-20T10:00:00.000Z", segments: [seg] });
  spool.insertConversation({ id: "conv_2", startedAtUtc: "2026-07-20T11:00:00.000Z", segments: [seg] });
  spool.insertConversation({ id: "conv_live", startedAtUtc: "2026-07-20T12:00:00.000Z", state: "capturing", segments: [seg] });
  spool.upsertSpeaker({ id: "self", label: "Me", isSelf: true });
  return spool;
}

async function startLoopback(): Promise<DaemonHandle> {
  const spool = seededSpool();
  const config = { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 };
  const handle = await startDaemon({ spool, config, token: "loopback-token" });
  open.push(handle);
  return handle;
}

test("GET /v1/health returns the health shape", async () => {
  const h = await startLoopback();
  const res = await fetch(`${h.url}/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.capturing, false);
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.pendingChunks, "number");
});

test("GET /v1/conversations serves final-only records with a keyset cursor", async () => {
  const h = await startLoopback();
  const res = await fetch(`${h.url}/v1/conversations?date=2026-07-20&timezone=UTC&limit=1`);
  assert.equal(res.status, 200);
  const page = await res.json();
  assert.deepEqual(page.conversations.map((c: { id: string }) => c.id), ["conv_1"]);
  assert.ok(page.nextCursor);

  const res2 = await fetch(
    `${h.url}/v1/conversations?date=2026-07-20&timezone=UTC&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
  );
  const page2 = await res2.json();
  assert.deepEqual(page2.conversations.map((c: { id: string }) => c.id), ["conv_2"]);
  assert.equal(page2.nextCursor, null);
});

test("GET /v1/speakers lists clusters", async () => {
  const h = await startLoopback();
  const res = await fetch(`${h.url}/v1/speakers`);
  assert.equal(res.status, 200);
  const body = await res.json();
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
  for (const path of bad) {
    const res = await fetch(`${h.url}${path}`);
    assert.equal(res.status, 400, `expected 400 for ${path}, got ${res.status}`);
  }
});

test("unknown route is 404 and non-GET is 405", async () => {
  const h = await startLoopback();
  assert.equal((await fetch(`${h.url}/v1/nope`)).status, 404);
  assert.equal((await fetch(`${h.url}/v1/health`, { method: "POST" })).status, 405);
});

test("non-loopback binding requires a valid bearer token", async () => {
  const spool = seededSpool();
  const config = { ...defaultDaemonConfig(), host: "0.0.0.0", port: 0 };
  const handle = await startDaemon({ spool, config, token: "secret-token" });
  open.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;

  assert.equal((await fetch(`${base}/v1/health`)).status, 401, "missing token must be 401");
  assert.equal(
    (await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status,
    401,
    "wrong token must be 401",
  );
  const ok = await fetch(`${base}/v1/health`, { headers: { authorization: "Bearer secret-token" } });
  assert.equal(ok.status, 200, "correct token must be 200");
});
