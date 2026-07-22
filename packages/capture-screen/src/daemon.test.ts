import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseCaptureScreenArgs } from "./cli.js";
import { startCaptureScreenDaemon } from "./daemon.js";

test("replay daemon persists snapshots and serves authenticated cursor pages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-capture-screen-"));
  const daemon = await startCaptureScreenDaemon({
    authToken: "test-token",
    spoolPath: path.join(dir, "capture.sqlite"),
    replay: [
      {
        capturedAtUtc: "2026-07-22T14:00:00.000Z",
        app: "Browser",
        windowTitle: "Synthetic page",
        text: "Synthetic capture text",
      },
      {
        capturedAtUtc: "2026-07-22T14:01:00.000Z",
        app: "Editor",
        windowTitle: "Synthetic document",
        text: "Another synthetic capture",
      },
    ],
  });

  try {
    const { url } = await daemon.start();
    const denied = await fetch(`${url}/v1/health`);
    assert.equal(denied.status, 401);

    const health = await fetch(`${url}/v1/health`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.deepEqual(await health.json(), { ok: true, snapshots: 2 });

    const first = await fetch(`${url}/v1/snapshots?limit=1`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(first.status, 200);
    const firstPage = await first.json() as { snapshots: Array<{ app: string }>; nextCursor: string | null };
    assert.deepEqual(firstPage.snapshots.map((snapshot) => snapshot.app), ["Browser"]);
    assert.ok(firstPage.nextCursor);

    if (firstPage.nextCursor === null) throw new Error("expected a replay cursor");
    const second = await fetch(`${url}/v1/snapshots?cursor=${encodeURIComponent(firstPage.nextCursor)}`, {
      headers: { authorization: "Bearer test-token" },
    });
    const secondPage = await second.json() as { snapshots: Array<{ app: string }>; nextCursor: string | null };
    assert.deepEqual(secondPage.snapshots.map((snapshot) => snapshot.app), ["Editor"]);
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

test("capture daemon CLI rejects malformed input and preserves an ephemeral port", () => {
  assert.throws(() => parseCaptureScreenArgs(["--auth-token", "token"]), /--spool is required/);
  assert.throws(
    () => parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite", "--port", "1.5"]),
    /integer/,
  );
  assert.deepEqual(
    parseCaptureScreenArgs(["--auth-token", "token", "--spool", "capture.sqlite", "--port", "0"]),
    { authToken: "token", spoolPath: "capture.sqlite", port: 0 },
  );
});
