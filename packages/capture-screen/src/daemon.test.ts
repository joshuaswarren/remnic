import assert from "node:assert/strict";
import { after, test } from "node:test";

import { contentHash } from "./capture.js";
import { defaultDaemonConfig } from "./config.js";
import { CaptureConfigError } from "./errors.js";
import { simhash, simhashToHex } from "./simhash.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { Spool, type SnapshotInput } from "./spool.js";
import { formatHostForUrl } from "./util.js";

const TOKEN = "loopback-token";
const open: DaemonHandle[] = [];
const spools: Spool[] = [];
after(async () => {
  for (const h of open) await h.close();
  for (const s of spools) s.close();
});

function snap(over: Partial<SnapshotInput> & { capturedAtUtc: string }): SnapshotInput {
  const base = { app: "Editor", windowTitle: "a.ts", browserUrl: null as string | null, text: "code", textSource: "ax" as const, ...over };
  return { ...base, contentHash: contentHash(base), simhash: simhashToHex(simhash(base.text)) };
}

function seededSpool(): Spool {
  const spool = new Spool(":memory:");
  spools.push(spool);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T09:00:00.000Z", app: "Safari", text: "one" }), 300);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T10:00:00.000Z", app: "Safari", text: "two" }), 300);
  spool.insertSnapshot(snap({ capturedAtUtc: "2026-07-20T11:00:00.000Z", app: "Editor", text: "three" }), 300);
  return spool;
}

async function startLoopback(axAvailable = false): Promise<DaemonHandle> {
  const config = { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 };
  const handle = await startDaemon({ spool: seededSpool(), config, token: TOKEN, axAvailable, ocrAvailable: axAvailable, helperHint: axAvailable ? null : "install helper" });
  open.push(handle);
  return handle;
}

function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
}

test("GET /v1/health returns the rich health shape", async () => {
  const h = await startLoopback(false);
  const res = await authFetch(`${h.url}/v1/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.capturing, false);
  assert.equal(body.axAvailable, false);
  assert.equal(body.ocrAvailable, false);
  assert.equal(typeof body.version, "string");
  assert.equal(typeof body.platform, "string");
  assert.equal(body.pendingCount, 3);
  assert.equal(typeof body.instanceId, "string");
  assert.equal(body.helperHint, "install helper");
});

test("GET /v1/snapshots serves a keyset-paged local day", async () => {
  const h = await startLoopback();
  const res = await authFetch(`${h.url}/v1/snapshots?date=2026-07-20&timezone=UTC&limit=2`);
  assert.equal(res.status, 200);
  const page = (await res.json()) as { snapshots: Array<Record<string, unknown>>; nextCursor: string | null };
  assert.deepEqual(page.snapshots.map((s) => s.text), ["one", "two"]);
  assert.ok(page.nextCursor);
  // Wire shape: app/windowTitle/text/textSource/contentHash present, no null browserUrl key.
  assert.equal(page.snapshots[0].textSource, "ax");
  assert.equal(typeof page.snapshots[0].contentHash, "string");
  assert.ok(!("browserUrl" in page.snapshots[0]), "null browserUrl omitted from the wire");

  const res2 = await authFetch(
    `${h.url}/v1/snapshots?date=2026-07-20&timezone=UTC&limit=2&cursor=${encodeURIComponent(page.nextCursor as string)}`,
  );
  const page2 = (await res2.json()) as { snapshots: Array<{ text: string }>; nextCursor: string | null };
  assert.deepEqual(page2.snapshots.map((s) => s.text), ["three"]);
  assert.equal(page2.nextCursor, null);
});

test("GET /v1/stats attributes per-app time for the day", async () => {
  const h = await startLoopback();
  const res = await authFetch(`${h.url}/v1/stats?date=2026-07-20&timezone=UTC`);
  assert.equal(res.status, 200);
  const stats = (await res.json()) as { snapshotCount: number; apps: Array<{ app: string; seconds: number }> };
  assert.equal(stats.snapshotCount, 3);
  const safari = stats.apps.find((a) => a.app === "Safari");
  assert.ok(safari && safari.seconds > 0, "Safari accrues dwell across its two snapshots");
});

test("invalid date/timezone/limit/cursor each return 400", async () => {
  const h = await startLoopback();
  const bad = [
    "/v1/snapshots?timezone=UTC",
    "/v1/snapshots?date=2026-13-40&timezone=UTC",
    "/v1/snapshots?date=2026-07-20",
    "/v1/snapshots?date=2026-07-20&timezone=Not/AZone",
    "/v1/snapshots?date=2026-07-20&timezone=UTC&limit=0",
    "/v1/snapshots?date=2026-07-20&timezone=UTC&cursor=%21%21%21bad",
    "/v1/stats?date=2026-07-20",
  ];
  for (const p of bad) {
    const res = await authFetch(`${h.url}${p}`);
    assert.equal(res.status, 400, `expected 400 for ${p}, got ${res.status}`);
  }
});

test("unknown route 404; authed non-GET 405; unauth 401 (authorize first)", async () => {
  const h = await startLoopback();
  assert.equal((await authFetch(`${h.url}/v1/nope`)).status, 404);
  assert.equal((await authFetch(`${h.url}/v1/health`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${h.url}/v1/health`, { method: "POST" })).status, 401);
});

test("every request requires a valid bearer token (loopback included)", async () => {
  const h = await startLoopback();
  assert.equal((await fetch(`${h.url}/v1/health`)).status, 401);
  assert.equal((await fetch(`${h.url}/v1/health`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await authFetch(`${h.url}/v1/health`)).status, 200);
});

test("startDaemon refuses a non-loopback host and an empty token", async () => {
  await assert.rejects(
    startDaemon({ spool: seededSpool(), config: { ...defaultDaemonConfig(), host: "0.0.0.0", port: 0 }, token: TOKEN }),
    CaptureConfigError,
  );
  await assert.rejects(
    startDaemon({ spool: seededSpool(), config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "" }),
    CaptureConfigError,
  );
});

test("formatHostForUrl brackets IPv6 hosts only", () => {
  assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(formatHostForUrl("::1"), "[::1]");
});
