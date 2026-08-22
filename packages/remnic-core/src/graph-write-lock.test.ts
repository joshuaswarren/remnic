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
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { graphFilePath } from "./graph.js";

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
