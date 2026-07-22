import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCaptureScreenArgs, runCaptureScreenCommand } from "./cli.js";
import { startCaptureScreenDaemon, type CaptureSnapshot } from "./daemon.js";

const AUTH = { authorization: "Bearer test-token" } as const;

function snapshot(overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return {
    capturedAtUtc: "2026-07-22T14:00:00.000Z",
    app: "Browser",
    windowTitle: "Synthetic page",
    text: "Synthetic capture text",
    textSource: "ax",
    ...overrides,
  };
}

test("replay daemon persists snapshots and serves authenticated cursor pages with core wire fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: path.join(dir, "capture.sqlite"),
    replay: [
      snapshot(),
      snapshot({ capturedAtUtc: "2026-07-22T14:01:00.000Z", app: "Editor", windowTitle: "Synthetic document", text: "Another synthetic capture", textSource: "ocr" }),
    ],
  });

  try {
    const { url } = await daemon.start();
    const denied = await fetch(`${url}/v1/health`);
    assert.equal(denied.status, 401);

    const health = await fetch(`${url}/v1/health`, { headers: AUTH });
    assert.deepEqual(await health.json(), { ok: true, snapshots: 2 });

    const first = await fetch(`${url}/v1/snapshots?limit=1`, { headers: AUTH });
    assert.equal(first.status, 200);
    const firstPage = await first.json() as { snapshots: Array<CaptureSnapshot & { contentHash: string }>; nextCursor: string | null };
    assert.deepEqual(firstPage.snapshots.map((s) => s.app), ["Browser"]);
    // The core ActivityHttpSourceClient rejects any snapshot missing these.
    assert.equal(firstPage.snapshots[0]?.textSource, "ax");
    assert.match(String(firstPage.snapshots[0]?.contentHash), /^[0-9a-f]{64}$/);
    assert.ok(firstPage.nextCursor);

    if (firstPage.nextCursor === null) throw new Error("expected a replay cursor");
    const second = await fetch(`${url}/v1/snapshots?cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: AUTH });
    const secondPage = await second.json() as { snapshots: Array<{ app: string; textSource: string }>; nextCursor: string | null };
    assert.deepEqual(secondPage.snapshots.map((s) => s.app), ["Editor"]);
    assert.equal(secondPage.snapshots[0]?.textSource, "ocr");
    assert.equal(secondPage.nextCursor, null);
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon rejects a non-loopback bind host", async () => {
  await assert.rejects(
    () => startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:", host: "0.0.0.0" }),
    /loopback/,
  );
});

test("daemon rejects overflowed capture timestamps and canonicalizes valid ones", async () => {
  await assert.rejects(
    () => startCaptureScreenDaemon({
      authToken: "test-token",
      spoolPath: ":memory:",
      replay: [snapshot({ capturedAtUtc: "2026-02-30T00:00:00.000Z" })],
    }),
    /calendar|ISO/,
  );

  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: ":memory:",
    replay: [snapshot({ capturedAtUtc: "2026-07-22T14:00:00Z" })],
  });
  try {
    const { url } = await daemon.start();
    const page = await (await fetch(`${url}/v1/snapshots`, { headers: AUTH })).json() as { snapshots: Array<{ capturedAtUtc: string }> };
    assert.equal(page.snapshots[0]?.capturedAtUtc, "2026-07-22T14:00:00.000Z");
  } finally {
    await daemon.close();
  }
});

test("daemon brackets an IPv6 loopback host in its URL", async (t) => {
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: ":memory:",
    host: "::1",
    replay: [snapshot()],
  });
  try {
    let running;
    try {
      running = await daemon.start();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
        t.skip("no IPv6 loopback available");
        return;
      }
      throw error;
    }
    assert.match(running.url, /^http:\/\/\[::1\]:\d+$/);
    const health = await fetch(`${running.url}/v1/health`, { headers: AUTH });
    assert.equal(health.status, 200);
  } finally {
    await daemon.close();
  }
});

test("snapshot query errors return a sanitized 400 without raw detail", async () => {
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:" });
  try {
    const { url } = await daemon.start();
    const bad = await fetch(`${url}/v1/snapshots?cursor=-1`, { headers: AUTH });
    assert.equal(bad.status, 400);
    const body = await bad.json() as { error: string };
    assert.equal(body.error, "RangeError");
    assert.doesNotMatch(body.error, /non-negative integer/);
  } finally {
    await daemon.close();
  }
});

test("daemon close is idempotent", async () => {
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:" });
  await daemon.start();
  await assert.doesNotReject(async () => {
    await daemon.close();
    await daemon.close();
  });
});

test("replay validation failure releases the spool and leaves it reusable", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const spoolPath = path.join(dir, "capture.sqlite");
  try {
    await assert.rejects(
      () => startCaptureScreenDaemon({
        authToken: "test-token",
        spoolPath,
        replay: [snapshot({ app: "" })],
      }),
      /non-empty/,
    );

    const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath });
    try {
      const { url } = await daemon.start();
      const health = await fetch(`${url}/v1/health`, { headers: AUTH });
      assert.deepEqual(await health.json(), { ok: true, snapshots: 0 });
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("daemon creates the spool file with owner-only (0600) permissions", { skip: process.platform === "win32" ? "POSIX mode semantics only" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const spoolPath = path.join(dir, "capture.sqlite");
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath, replay: [snapshot()] });
  try {
    const mode = (await stat(spoolPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI command releases the daemon when startup fails to bind", async () => {
  const occupier = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:" });
  try {
    const { url } = await occupier.start();
    const port = Number(new URL(url).port);
    await assert.rejects(
      () => runCaptureScreenCommand(["--auth-token", "test-token", "--spool", ":memory:", "--port", String(port)]),
      /EADDRINUSE/,
    );
  } finally {
    await occupier.close();
  }
});

test("CLI expands a tilde spool path to the home directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const daemon = await runCaptureScreenCommand(["--auth-token", "test-token", "--spool", "~/capture.sqlite"]);
    try {
      const stats = await stat(path.join(home, "capture.sqlite"));
      assert.ok(stats.isFile());
    } finally {
      await daemon.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("capture daemon CLI rejects malformed input and preserves an ephemeral port", () => {
  assert.throws(() => parseCaptureScreenArgs(["--auth-token", "token"]), /--spool is required/);
  assert.throws(
    () => parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite", "--port", "1.5"]),
    /integer/,
  );
  assert.throws(() => parseCaptureScreenArgs(["--auth-token", "token", "--spool", ""]), /--spool requires a value/);
  assert.throws(
    () => parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite", "--port", ""]),
    /--port requires a value/,
  );
  assert.deepEqual(
    parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite", "--port", "0"]),
    { authToken: "token", spoolPath: "capture.sqlite", port: 0 },
  );
});
