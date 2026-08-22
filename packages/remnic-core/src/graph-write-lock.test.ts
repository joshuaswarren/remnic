/**
 * Cross-process safety of the graph JSONL write lock (issue #2330 round
 * N+18 A). The in-process promise chain cannot see a peer Remnic process
 * sharing the memory directory: a peer append landing between this
 * process's read-snapshot and its rename-backed rewrite was silently
 * discarded by the stale snapshot. Every withGraphWriteLock section must
 * serialize against peers through the shared withHeldFileLock advisory
 * lock (the same primitive the page-versioning manifest uses).
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { graphFilePath } from "./graph.js";
import {
  assertGraphLockHeld,
  GraphLockLostError,
  withGraphWriteLock,
} from "./graph-write-lock.js";
import { removeNodeEdgesForRewrite, writeGraphJsonlAtomic } from "./graph-jsonl.js";

test("withGraphWriteLock: a peer append between read and rewrite is never discarded (round N+18 A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-xproc-"));
  const jsonlUrl = new URL("./graph-jsonl.ts", import.meta.url).href;
  const graphUrl = new URL("./graph.ts", import.meta.url).href;
  const APPENDS = 60;
  const REWRITES = 30;
  // Large labels widen the read/write windows so the pre-lock race window
  // is exercised on every round, not just occasionally.
  const pad = "y".repeat(2048);

  // Worker source: plain JS, no nested template literals (tombstones.test.ts
  // pattern). Worker 0 seeds node-owned edges, then alternates
  // removeNodeEdgesForRewrite/restoreRemovedNodeEdges — each round is a
  // read-modify-rename of entity.jsonl. Worker 1 appends distinct edges
  // through appendEdge. Without the cross-process lock, the rewriter's
  // stale snapshot discards appends that land inside its read→rename window.
  const workerSource = [
    "(async () => {",
    "const jsonl = await import(process.argv[1]);",
    "const graph = await import(process.argv[2]);",
    "const dir = process.argv[3];",
    "const workerId = Number(process.argv[4]);",
    "const appends = Number(process.argv[5]);",
    "const rewrites = Number(process.argv[6]);",
    "const pad = process.argv[7];",
    "const node = 'facts/w-a.md';",
    "if (workerId === 0) {",
    "  for (let i = 0; i < 3; i += 1) {",
    "    await graph.appendEdge(dir, { from: node, to: 'facts/w-a-peer-' + i + '.md', type: 'entity', weight: 1, label: 'seed' + i + pad, ts: new Date().toISOString() });",
    "  }",
    "  for (let i = 0; i < rewrites; i += 1) {",
    "    const removed = await jsonl.removeNodeEdgesForRewrite(dir, node, ['entity']);",
    "    for (const entry of removed) await jsonl.restoreRemovedNodeEdges(dir, entry);",
    "  }",
    "} else {",
    "  for (let i = 0; i < appends; i += 1) {",
    "    await graph.appendEdge(dir, { from: 'facts/w-b.md', to: 'facts/w-b-target-' + i + '.md', type: 'entity', weight: 1, label: 'peer' + i + pad, ts: new Date().toISOString() });",
    "  }",
    "}",
    "})();",
  ].join("\n");

  function runWorker(workerId: number): Promise<void> {
    // The workers below resolve their modules from argv URLs at runtime —
    // a static import cannot express "the file under test, by URL".
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const child = spawn(
      process.execPath,
      [
        "--import", "tsx", "-e", workerSource,
        jsonlUrl, graphUrl, dir, String(workerId), String(APPENDS), String(REWRITES), pad,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`));
    });
    return promise;
  }
  await Promise.all([runWorker(0), runWorker(1)]);

  const raw = await readFile(graphFilePath(dir, "entity"), "utf8");
  const rows = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { from: string });
  const peerAppended = rows.filter((edge) => edge.from === "facts/w-b.md");
  assert.equal(
    peerAppended.length,
    APPENDS,
    `every peer-appended edge must survive the concurrent rewrites (found ${peerAppended.length} of ${APPENDS})`,
  );
});

// ── Round N+19 (A): the lock's mtime heartbeat is a timer; it cannot fire
// while a synchronous parse/serialize blocks the event loop, so a peer can
// stale-break the lock past the 30s window and publish its own write. A
// section about to publish must revalidate ownership and abort on loss.

test("withGraphWriteLock: refresh reports a peer-replaced lock and the guarded publish refuses (round N+19 A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-locklost-"));
  const filePath = graphFilePath(dir, "entity");
  await mkdir(path.dirname(filePath), { recursive: true });
  const PEER_ROW = `${JSON.stringify({
    from: "facts/peer.md",
    to: "facts/peer-target.md",
    type: "entity",
    weight: 1,
    label: "peer",
    ts: "2026-08-22T00:00:00.000Z",
  })}\n`;
  await writeFile(filePath, PEER_ROW, "utf8");

  await withGraphWriteLock(filePath, async (lock) => {
    assert.equal(await lock.refresh(), true, "an unbroken lock refreshes");
    // Simulate the stalled-section consequence: a peer stale-broke our lock
    // and published its own (the row above is its write).
    const lockPath = `${filePath}.lock`;
    await unlink(lockPath).catch(() => undefined);
    await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
    assert.equal(await lock.refresh(), false, "ownership was lost to the peer");
    await assert.rejects(assertGraphLockHeld(filePath, lock), GraphLockLostError);
    assert.equal(await readFile(filePath, "utf8"), PEER_ROW, "the refused publish left the peer's write intact");
  });
});

test("removeNodeEdgesForRewrite: a stale-broken lock aborts the rewrite instead of clobbering the peer (round N+19 A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-abort-"));
  const filePath = graphFilePath(dir, "entity");
  await mkdir(path.dirname(filePath), { recursive: true });
  const NODE = "facts/mine.md";
  // A corpus large enough that the section's chunked parse yields to the
  // event loop many times, giving the simulated peer's break a guaranteed
  // landing window inside the section (before the publish guard).
  const rows: string[] = [];
  for (let i = 0; i < 59_999; i += 1) {
    rows.push(
      JSON.stringify({
        from: "facts/other.md",
        to: `facts/x-${i}.md`,
        type: "entity",
        weight: 1,
        label: `row${i}`,
        ts: "2026-08-22T00:00:00.000Z",
      }),
    );
  }
  rows.push(
    JSON.stringify({
      from: NODE,
      to: "facts/mine-target.md",
      type: "entity",
      weight: 1,
      label: "mine",
      ts: "2026-08-22T00:00:00.000Z",
    }),
  );
  await writeFile(filePath, `${rows.join("\n")}\n`, "utf8");

  const lockPath = `${filePath}.lock`;
  const breakAsPeer = (async () => {
    while (!existsSync(lockPath)) await new Promise<void>((resolve) => setImmediate(resolve));
    await unlink(lockPath).catch(() => undefined);
    await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
  })();

  await assert.rejects(
    removeNodeEdgesForRewrite(dir, NODE, ["entity"]),
    (err: unknown) => err instanceof Error && /lost mid-section/.test(err.message),
    "a rewrite whose lock was stale-broken mid-section must abort, not publish",
  );
  await breakAsPeer;
  const after = await readFile(filePath, "utf8");
  assert.equal(
    after.includes(`"from":"${NODE}"`),
    true,
    "the aborted rewrite must leave the node's edges untouched (the peer that broke the lock owns the file)",
  );
  assert.equal(after.split("\n").filter((line) => line.trim().length > 0).length, 60_000);
});

test("writeGraphJsonlAtomic: the rename itself revalidates ownership and refuses a broken lock (round N+20 A)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-graph-rename-guard-"));
  const filePath = graphFilePath(dir, "entity");
  await mkdir(path.dirname(filePath), { recursive: true });
  const PEER_ROW = `${JSON.stringify({
    from: "facts/peer.md",
    to: "facts/peer-target.md",
    type: "entity",
    weight: 1,
    label: "peer",
    ts: "2026-08-22T00:00:00.000Z",
  })}\n`;
  await writeFile(filePath, PEER_ROW, "utf8");

  await withGraphWriteLock(filePath, async (lock) => {
    assert.equal(await lock.refresh(), true, "an unbroken lock refreshes");
    // The N+20 A window: the CALLER's ownership check has passed, then the
    // section stalls past the 30s stale window — a peer breaks the lock and
    // publishes its own write — and the section resumes at the rename.
    const lockPath = `${filePath}.lock`;
    await unlink(lockPath).catch(() => undefined);
    await writeFile(lockPath, `${process.pid} peer-${randomUUID()} ${new Date().toISOString()}\n`, "utf8");
    await assert.rejects(
      writeGraphJsonlAtomic(
        filePath,
        [{ from: "facts/mine.md", to: "facts/mine-target.md", type: "entity", weight: 1, label: "mine", ts: "2026-08-22T00:00:00.000Z" }],
        lock,
      ),
      GraphLockLostError,
      "the publish step must revalidate ownership immediately before the rename",
    );
    assert.equal(await readFile(filePath, "utf8"), PEER_ROW, "the refused rename left the peer's write intact");
  });
});
