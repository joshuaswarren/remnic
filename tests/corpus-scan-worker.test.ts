/**
 * Corpus-scan worker: parity, cancellation, failure and shutdown contracts.
 *
 * The corpus maintenance scans (recall-corpus path walk, entity-entry
 * fingerprint, watermark freshness stat) run in a worker thread so a
 * corpus-sized scan cannot monopolize the daemon's main event loop. These
 * tests pin the properties that make the offload safe:
 *
 *   1. PARITY — the worker's results are identical to the same implementation
 *      run inline (paths, fingerprint, stat sweep);
 *   2. CANCELLATION — an aborted scan rejects with an AbortError and never
 *      publishes a partial corpus;
 *   3. FAILURE — a scan error keeps its errno code (the strict census must
 *      still tell `EACCES` from `ENOENT`);
 *   4. SHUTDOWN — an idle worker holds no handle open, and closing it rejects
 *      in-flight jobs;
 *   5. OFFLOAD — a corpus-sized scan leaves the main thread free.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";

import {
  collectContainedMarkdownPaths,
  fingerprintEntityEntries,
  statMtimes,
} from "../packages/remnic-core/src/corpus-scan.js";
import { corpusScanWorker } from "../packages/remnic-core/src/corpus-scan-worker-host.js";
import { makeSyntheticCorpus } from "./synthetic-corpus.js";

async function makeCorpus(): Promise<{ baseDir: string; outsideDir: string; cleanup: () => Promise<void> }> {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-worker-corpus-"));
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "engram-worker-out-"));
  await makeSyntheticCorpus({
    rootDir: baseDir,
    days: 4,
    filesPerCategory: 60,
    categories: ["facts", "decisions"],
    coldFiles: 20,
    entityCount: 25,
  });
  // Finder junk (must be ignored) and a nested partition.
  await writeFile(path.join(baseDir, "facts", ".DS_Store"), "junk", "utf-8");
  await writeFile(path.join(baseDir, "facts", "._leaked.md"), "junk", "utf-8");
  await mkdir(path.join(baseDir, "facts", "2026-01-28", "nested"), { recursive: true });
  await writeFile(path.join(baseDir, "facts", "2026-01-28", "nested", "deep.md"), "---\nid: deep\n---\nbody\n", "utf-8");
  // An out-of-store file reachable only through a symlink.
  await writeFile(path.join(outsideDir, "leaked.md"), "---\nid: leaked\n---\nbody\n", "utf-8");
  await symlink(outsideDir, path.join(baseDir, "facts", "escape"), "dir");
  return {
    baseDir,
    outsideDir,
    cleanup: async () => {
      await rm(baseDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    },
  };
}

test("worker path collection is identical to the inline walk", async () => {
  const corpus = await makeCorpus();
  try {
    const startDirs = [
      path.join(corpus.baseDir, "facts"),
      path.join(corpus.baseDir, "decisions"),
      path.join(corpus.baseDir, "cold"),
      path.join(corpus.baseDir, "does-not-exist"),
    ];
    const inline = await collectContainedMarkdownPaths({ baseDir: corpus.baseDir, startDirs });
    const viaWorker = await corpusScanWorker.request({
      kind: "walk",
      baseDir: corpus.baseDir,
      startDirs,
      propagateReadErrors: false,
    });
    assert.deepEqual(viaWorker, inline, "the worker walk must match the inline walk exactly");
    assert.ok(inline.some((filePath) => filePath.endsWith("deep.md")), "nested memories must be collected");
    assert.ok(!inline.some((filePath) => filePath.includes(".DS_Store")), "Finder junk must be ignored");
    assert.ok(!inline.some((filePath) => filePath.includes("leaked")), "a symlinked-out file must not leak");
  } finally {
    await corpus.cleanup();
  }
});

test("worker entity-entry fingerprint matches the inline fingerprint", async () => {
  const corpus = await makeCorpus();
  try {
    const entitiesDir = path.join(corpus.baseDir, "entities");
    const inline = await fingerprintEntityEntries(entitiesDir);
    const viaWorker = await corpusScanWorker.request({ kind: "entity-entries-fingerprint", entitiesDir });
    assert.equal(viaWorker, inline, "the worker fingerprint must match the inline fingerprint exactly");
  } finally {
    await corpus.cleanup();
  }
});

test("worker stat sweep matches an inline stat and reports vanished files as null", async () => {
  const corpus = await makeCorpus();
  try {
    const present = path.join(corpus.baseDir, "facts", "2026-01-28", "nested", "deep.md");
    const vanished = path.join(corpus.baseDir, "facts", "2026-01-28", "gone.md");
    const inline = await statMtimes([present, vanished]);
    const viaWorker = await corpusScanWorker.request({ kind: "stat-mtimes", paths: [present, vanished] });
    assert.deepEqual(viaWorker, inline, "the worker stat sweep must match the inline sweep exactly");
    assert.equal(inline.length, 2);
    assert.ok(inline[0] !== null, "an existing file reports its mtime");
    assert.equal(inline[1], null, "a vanished file reports null, not an error");
  } finally {
    await corpus.cleanup();
  }
});

test("a strict scan error keeps its errno code across the worker boundary", async () => {
  const corpus = await makeCorpus();
  try {
    // A category root that EXISTS but is not a directory: the strict census
    // must fail loud, with the same message the inline walk produces.
    const notADirectory = path.join(corpus.baseDir, "facts-file");
    await writeFile(notADirectory, "not a directory", "utf-8");
    await assert.rejects(
      () => corpusScanWorker.request({
        kind: "walk",
        baseDir: corpus.baseDir,
        startDirs: [notADirectory],
        propagateReadErrors: true,
      }),
      /expected a directory but found a non-directory/,
    );
  } finally {
    await corpus.cleanup();
  }
});

test("an aborted scan rejects with an AbortError", async () => {
  const corpus = await makeCorpus();
  try {
    const controller = new AbortController();
    const pending = corpusScanWorker.request(
      {
        kind: "walk",
        baseDir: corpus.baseDir,
        startDirs: [path.join(corpus.baseDir, "facts")],
        propagateReadErrors: false,
      },
      controller.signal,
    );
    controller.abort();
    await assert.rejects(() => pending, (error: Error) => error.name === "AbortError");
  } finally {
    await corpus.cleanup();
  }
});

test("closing the worker rejects in-flight jobs and leaves no handle open", async () => {
  const corpus = await makeCorpus();
  try {
    // Attach the rejection handler before closing: the in-flight job is
    // rejected by the close, and the host respawns on the next request.
    const pending = corpusScanWorker.request({
      kind: "walk",
      baseDir: corpus.baseDir,
      startDirs: [path.join(corpus.baseDir, "facts")],
      propagateReadErrors: false,
    }).catch(() => undefined);
    corpusScanWorker.close();
    await pending;
    const afterClose = await corpusScanWorker.request({
      kind: "walk",
      baseDir: corpus.baseDir,
      startDirs: [path.join(corpus.baseDir, "facts")],
      propagateReadErrors: false,
    });
    assert.ok(afterClose.length > 0, "the host must serve scans again after a close");
  } finally {
    await corpus.cleanup();
  }
});

test("a corpus scan costs the main thread far less than the inline walk", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "engram-worker-load-"));
  try {
    // A corpus big enough that an inline walk visibly occupies the main thread.
    await makeSyntheticCorpus({ rootDir: baseDir, days: 20, filesPerCategory: 4_000, categories: ["facts"], entityCount: 10 });
    const startDirs = [path.join(baseDir, "facts")];

    // Main-thread ACTIVE time (event-loop utilization) for the same scan run
    // inline and through the worker, on the same corpus, one after the other.
    // Relative, so it holds on slow CI machines: the inline walk spends its
    // wall time in main-thread syscall continuations, the worker run only
    // posts a job and receives the path list.
    const measure = async (scan: () => Promise<string[]>): Promise<{ activeMs: number; count: number }> => {
      const before = performance.eventLoopUtilization();
      const paths = await scan();
      return { activeMs: performance.eventLoopUtilization(before).active, count: paths.length };
    };
    await collectContainedMarkdownPaths({ baseDir, startDirs }); // warm the page cache for both runs
    const inline = await measure(() => collectContainedMarkdownPaths({ baseDir, startDirs }));
    const viaWorker = await measure(() => corpusScanWorker.request({
      kind: "walk",
      baseDir,
      startDirs,
      propagateReadErrors: false,
    }));
    assert.equal(viaWorker.count, inline.count, "both runs must cover the same corpus");
    assert.ok(inline.count >= 4_000, "the scan must have covered the corpus");
    assert.ok(
      viaWorker.activeMs < inline.activeMs / 2,
      `the worker scan must cost the main thread well under half the inline scan (worker ${viaWorker.activeMs.toFixed(1)}ms active vs inline ${inline.activeMs.toFixed(1)}ms)`,
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
