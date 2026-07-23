import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
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
    // Core persists a non-null cursor, so a non-empty final page still advances
    // the high-water mark; the follow-up empty page terminates the sync.
    assert.ok(secondPage.nextCursor);
    if (secondPage.nextCursor === null) throw new Error("expected an advancing cursor");
    const third = await fetch(`${url}/v1/snapshots?cursor=${encodeURIComponent(secondPage.nextCursor)}`, { headers: AUTH });
    const thirdPage = await third.json() as { snapshots: unknown[]; nextCursor: string | null };
    assert.deepEqual(thirdPage.snapshots, []);
    assert.equal(thirdPage.nextCursor, null);
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
        replay: [snapshot({ capturedAtUtc: "2026-02-30T00:00:00.000Z" })],
      }),
      /calendar|ISO/,
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

test("replay accepts empty content fields (untitled window / no extractable text)", async () => {
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: ":memory:",
    replay: [snapshot({ app: "", windowTitle: "", text: "" })],
  });
  try {
    const { url } = await daemon.start();
    assert.deepEqual(await (await fetch(`${url}/v1/health`, { headers: AUTH })).json(), { ok: true, snapshots: 1 });
    const page = await (await fetch(`${url}/v1/snapshots`, { headers: AUTH })).json() as { snapshots: Array<{ app: string; windowTitle: string; text: string }> };
    assert.equal(page.snapshots.length, 1);
    assert.equal(page.snapshots[0]?.app, "");
    assert.equal(page.snapshots[0]?.text, "");
  } finally {
    await daemon.close();
  }
});

test("content hash is unambiguous across NUL-shifted field boundaries", async () => {
  // With bare NUL separators these two would hash identically and the UNIQUE
  // content_hash + INSERT OR IGNORE would silently drop the second capture.
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: ":memory:",
    replay: [
      snapshot({ app: "A\u0000B", windowTitle: "C" }),
      snapshot({ app: "A", windowTitle: "B\u0000C" }),
    ],
  });
  try {
    const { url } = await daemon.start();
    assert.deepEqual(await (await fetch(`${url}/v1/health`, { headers: AUTH })).json(), { ok: true, snapshots: 2 });
  } finally {
    await daemon.close();
  }
});

test("snapshots are scoped to the requested local day via date + timezone", async () => {
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: ":memory:",
    replay: [
      snapshot({ capturedAtUtc: "2026-07-22T14:00:00.000Z", app: "A" }),
      snapshot({ capturedAtUtc: "2026-07-22T23:59:59.000Z", app: "B" }),
      snapshot({ capturedAtUtc: "2026-07-23T00:00:00.000Z", app: "C" }),
    ],
  });
  try {
    const { url } = await daemon.start();
    const day22 = await (await fetch(`${url}/v1/snapshots?date=2026-07-22&timezone=UTC`, { headers: AUTH })).json() as { snapshots: Array<{ app: string }>; nextCursor: string | null };
    assert.deepEqual(day22.snapshots.map((s) => s.app), ["A", "B"]);
    // Non-empty page advances the cursor; a follow-up fetch for the same day
    // scoped past it returns no rows and terminates.
    assert.ok(day22.nextCursor);
    const day22End = await (await fetch(`${url}/v1/snapshots?date=2026-07-22&timezone=UTC&cursor=${encodeURIComponent(String(day22.nextCursor))}`, { headers: AUTH })).json() as { snapshots: unknown[]; nextCursor: string | null };
    assert.deepEqual(day22End.snapshots, []);
    assert.equal(day22End.nextCursor, null);
    const day23 = await (await fetch(`${url}/v1/snapshots?date=2026-07-23&timezone=UTC`, { headers: AUTH })).json() as { snapshots: Array<{ app: string }> };
    assert.deepEqual(day23.snapshots.map((s) => s.app), ["C"]);
  } finally {
    await daemon.close();
  }
});

test("snapshots reject a date without its timezone (and vice versa)", async () => {
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:" });
  try {
    const { url } = await daemon.start();
    assert.equal((await fetch(`${url}/v1/snapshots?date=2026-07-22`, { headers: AUTH })).status, 400);
    assert.equal((await fetch(`${url}/v1/snapshots?timezone=UTC`, { headers: AUTH })).status, 400);
  } finally {
    await daemon.close();
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

test("daemon rejects a directory spool path without mangling its permissions", { skip: process.platform === "win32" ? "POSIX mode semantics only" : false }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const subdir = path.join(parent, "capture.sqlite");
  await mkdir(subdir, { mode: 0o700 });
  const before = (await stat(subdir)).mode & 0o777;
  try {
    await assert.rejects(() => startCaptureScreenDaemon({ authToken: "test-token", spoolPath: subdir }));
    // The directory's own permissions (incl. the execute bit) must be intact.
    assert.equal((await stat(subdir)).mode & 0o777, before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("daemon runs in the supported owner-only (0700) spool directory", { skip: process.platform === "win32" ? "POSIX mode semantics only" : false }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const spoolPath = path.join(parent, "capture.sqlite");
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath, replay: [snapshot()] });
  try {
    const { url } = await daemon.start();
    assert.deepEqual(await (await fetch(`${url}/v1/health`, { headers: AUTH })).json(), { ok: true, snapshots: 1 });
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.equal((await stat(spoolPath)).mode & 0o777, 0o600);
  } finally {
    await daemon.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("daemon rejects a world-accessible spool parent directory", { skip: process.platform === "win32" ? "POSIX mode semantics only" : false }, async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  await chmod(parent, 0o755);
  try {
    await assert.rejects(
      () => startCaptureScreenDaemon({ authToken: "test-token", spoolPath: path.join(parent, "capture.sqlite") }),
      /owner-only/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("daemon rejects a symlinked spool parent directory", { skip: process.platform === "win32" ? "POSIX symlink semantics only" : false }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const realParent = path.join(base, "real");
  await mkdir(realParent, { mode: 0o700 });
  const linkParent = path.join(base, "link");
  await symlink(realParent, linkParent);
  try {
    await assert.rejects(
      () => startCaptureScreenDaemon({ authToken: "test-token", spoolPath: path.join(linkParent, "capture.sqlite") }),
      /parent directory must not be a symlink/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("daemon creates an absent spool parent directory as owner-only 0700", { skip: process.platform === "win32" ? "POSIX mode semantics only" : false }, async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const parent = path.join(base, "nested", "spool");
  const spoolPath = path.join(parent, "capture.sqlite");
  const daemon = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath });
  try {
    await daemon.start();
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.equal((await stat(spoolPath)).mode & 0o777, 0o600);
  } finally {
    await daemon.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("daemon rejects a symlinked spool path without following it", { skip: process.platform === "win32" ? "POSIX symlink semantics only" : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const target = path.join(dir, "target.sqlite");
  const link = path.join(dir, "spool.sqlite");
  await writeFile(target, "not-a-db");
  const targetMode = (await stat(target)).mode & 0o777;
  await symlink(target, link);
  try {
    await assert.rejects(
      () => startCaptureScreenDaemon({ authToken: "test-token", spoolPath: link }),
      /symlink/,
    );
    // The link target must be untouched (not chmodded to 0600, not written).
    assert.equal((await stat(target)).mode & 0o777, targetMode);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI command releases the daemon when startup fails to bind", async () => {
  const occupier = await startCaptureScreenDaemon({ authToken: "test-token", spoolPath: ":memory:" });
  const previousToken = process.env.REMNIC_CAPTURE_TOKEN;
  process.env.REMNIC_CAPTURE_TOKEN = "test-token";
  try {
    const { url } = await occupier.start();
    const port = Number(new URL(url).port);
    await assert.rejects(
      () => runCaptureScreenCommand(["--spool", ":memory:", "--port", String(port)]),
      /EADDRINUSE/,
    );
  } finally {
    if (previousToken === undefined) delete process.env.REMNIC_CAPTURE_TOKEN;
    else process.env.REMNIC_CAPTURE_TOKEN = previousToken;
    await occupier.close();
  }
});

test("CLI reads the bearer token from the environment and authenticates without argv exposure", async () => {
  const previousToken = process.env.REMNIC_CAPTURE_TOKEN;
  delete process.env.REMNIC_CAPTURE_TOKEN;
  try {
    await assert.rejects(() => runCaptureScreenCommand(["--spool", ":memory:"]), /REMNIC_CAPTURE_TOKEN must be set/);

    process.env.REMNIC_CAPTURE_TOKEN = "env-token";
    const running = await runCaptureScreenCommand(["--spool", ":memory:"]);
    try {
      const ok = await fetch(`${running.url}/v1/health`, { headers: { authorization: "Bearer env-token" } });
      assert.equal(ok.status, 200);
      const denied = await fetch(`${running.url}/v1/health`);
      assert.equal(denied.status, 401);
    } finally {
      await running.close();
    }
  } finally {
    if (previousToken === undefined) delete process.env.REMNIC_CAPTURE_TOKEN;
    else process.env.REMNIC_CAPTURE_TOKEN = previousToken;
  }
});

test("CLI expands a tilde spool path to the home directory", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "remnic-home-"));
  const previousHome = process.env.HOME;
  const previousToken = process.env.REMNIC_CAPTURE_TOKEN;
  process.env.HOME = home;
  process.env.REMNIC_CAPTURE_TOKEN = "test-token";
  try {
    const daemon = await runCaptureScreenCommand(["--spool", "~/capture.sqlite"]);
    try {
      const stats = await stat(path.join(home, "capture.sqlite"));
      assert.ok(stats.isFile());
    } finally {
      await daemon.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousToken === undefined) delete process.env.REMNIC_CAPTURE_TOKEN;
    else process.env.REMNIC_CAPTURE_TOKEN = previousToken;
    await rm(home, { recursive: true, force: true });
  }
});

test("capture daemon CLI rejects malformed input and the unsafe --auth-token flag", () => {
  assert.throws(() => parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite"]), /--auth-token is not accepted/);
  assert.throws(() => parseCaptureScreenArgs([]), /--spool is required/);
  assert.throws(
    () => parseCaptureScreenArgs(["--spool", "capture.sqlite", "--port", "1.5"]),
    /integer/,
  );
  assert.throws(() => parseCaptureScreenArgs(["--spool", ""]), /--spool requires a value/);
  assert.throws(
    () => parseCaptureScreenArgs(["--spool", "capture.sqlite", "--port", ""]),
    /--port requires a value/,
  );
  assert.deepEqual(
    parseCaptureScreenArgs(["--spool", "capture.sqlite", "--port", "0"]),
    { spoolPath: "capture.sqlite", port: 0 },
  );
});
