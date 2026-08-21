import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultDaemonConfig } from "./config.js";
import { startDaemon, type DaemonHandle } from "./daemon.js";
import { ingestReplayDir } from "./replay.js";
import { Spool } from "./spool.js";

const TOKEN = "replay-token";
const open: DaemonHandle[] = [];
const spools: Spool[] = [];
after(async () => {
  for (const h of open) await h.close();
  for (const s of spools) s.close();
});

/**
 * Faithful re-implementation of @remnic/core's ActivityHttpSourceClient wire
 * parser (packages/remnic-core/src/activity/source-client.ts). capture-screen
 * is standalone (no @remnic/core dep), so we assert the served page satisfies
 * that parser here instead of importing it. Throws exactly where core would.
 */
function assertCoreWouldAccept(page: unknown): void {
  assert.ok(page !== null && typeof page === "object" && Array.isArray((page as { snapshots?: unknown }).snapshots));
  const body = page as { snapshots: unknown[]; nextCursor?: unknown };
  const nextCursor = body.nextCursor === undefined ? null : body.nextCursor;
  assert.ok(nextCursor === null || typeof nextCursor === "string", "nextCursor must be string|null");
  for (const raw of body.snapshots) {
    assert.ok(raw !== null && typeof raw === "object", "snapshot must be an object");
    const s = raw as Record<string, unknown>;
    for (const field of ["capturedAtUtc", "contentHash", "textSource"]) {
      assert.equal(typeof s[field], "string", `${field} must be a non-empty string`);
      assert.ok((s[field] as string).length > 0, `${field} must be non-empty`);
    }
    assert.ok(s.textSource === "ax" || s.textSource === "ocr", "textSource must be ax|ocr");
    for (const field of ["app", "windowTitle", "text"]) {
      assert.equal(typeof s[field], "string", `${field} must be a string (may be empty)`);
    }
    if (s.browserUrl !== undefined && s.browserUrl !== null) assert.equal(typeof s.browserUrl, "string");
    if (s.simhash !== undefined && s.simhash !== null) assert.equal(typeof s.simhash, "string");
  }
}

function writeFixtures(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "csr-replay-"));
  const write = (name: string, doc: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(doc), "utf8");
  write("a-normal.json", {
    capturedAtUtc: "2026-07-20T10:00:00.000Z",
    app: "Safari",
    windowTitle: "Docs",
    ax: { role: "AXWindow", children: [{ role: "AXStaticText", value: "Hello Docs body text" }] },
  });
  write("b-deny.json", {
    capturedAtUtc: "2026-07-20T10:01:00.000Z",
    app: "1Password 8",
    windowTitle: "Vault",
    text: "super secret vault contents",
  });
  write("c-terminal.json", {
    capturedAtUtc: "2026-07-20T10:02:00.000Z",
    app: "iTerm2",
    windowTitle: "zsh",
    ax: { role: "AXWindow" },
  });
  write("d-secure.json", {
    capturedAtUtc: "2026-07-20T10:03:00.000Z",
    app: "Login",
    windowTitle: "Sign in",
    ax: {
      role: "AXWindow",
      children: [
        { role: "AXStaticText", value: "Username field label" },
        { role: "AXSecureTextField", value: "topsecretpassword" },
      ],
    },
  });
  write(
    "e-dedup.json",
    Array.from({ length: 5 }, (_, i) => ({
      capturedAtUtc: `2026-07-20T10:04:0${i}.000Z`,
      app: "Reader",
      windowTitle: "Book",
      text: "a static page of prose that does not change between scroll frames",
    })),
  );
  return dir;
}

test("replay runs candidates through the full pipeline with honest per-rule counts", () => {
  const spool = new Spool(":memory:");
  spools.push(spool);
  const result = ingestReplayDir(spool, writeFixtures(), defaultDaemonConfig());
  assert.equal(result.candidates, 9);
  assert.equal(result.denied, 1, "1Password window dropped whole");
  assert.equal(result.ocrSkipped, 1, "terminal window with no OCR skipped");
  assert.equal(result.deduped, 4, "5 identical scroll states → 1 stored, 4 deduped");
  assert.equal(result.stored, 3, "normal + secure + first scroll state");
  assert.equal(spool.countSnapshots(), 3);
});

test("replayed snapshots serve a page ActivityHttpSourceClient would accept", async () => {
  const spool = new Spool(":memory:");
  spools.push(spool);
  const config = defaultDaemonConfig();
  ingestReplayDir(spool, writeFixtures(), config);
  const handle = await startDaemon({ spool, config: { ...config, host: "127.0.0.1", port: 0 }, token: TOKEN });
  open.push(handle);

  const res = await fetch(`${handle.url}/v1/snapshots?date=2026-07-20&timezone=UTC`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 200);
  const page: unknown = await res.json();
  assertCoreWouldAccept(page);

  const body = page as { snapshots: Array<Record<string, unknown>> };
  assert.equal(body.snapshots.length, 3);
  assert.equal(body.snapshots[0].app, "Safari");
  assert.ok(body.snapshots.every((s) => s.textSource === "ax"));
  // Deny + secure-field guarantees: no dropped/secret content reaches the wire.
  const allText = body.snapshots.map((s) => String(s.text)).join("\n");
  assert.doesNotMatch(allText, /topsecretpassword/);
  assert.doesNotMatch(allText, /vault contents/);
});

test("replay rejects a fixture carrying neither text nor ax (upfront, atomic)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "csr-replay-bad-"));
  writeFileSync(
    path.join(dir, "bad.json"),
    JSON.stringify({ capturedAtUtc: "2026-07-20T10:00:00.000Z", app: "Safari", windowTitle: "x" }),
    "utf8",
  );
  const spool = new Spool(":memory:");
  spools.push(spool);
  assert.throws(() => ingestReplayDir(spool, dir, defaultDaemonConfig()), /must carry 'text' or 'ax'/);
});
