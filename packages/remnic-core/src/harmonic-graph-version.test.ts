import assert from "node:assert/strict";
import { statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bumpHarmonicGraphVersion,
  HARMONIC_GRAPH_VERSION_SENTINEL,
  readHarmonicGraphStamp,
} from "./harmonic-graph-version.js";

test("harmonic version: bump appends one byte to the sentinel, creating it", async (t) => {
  const nodeDir = await mkdtemp(path.join(tmpdir(), "remnic-hgv-"));
  t.after(() => rm(nodeDir, { recursive: true, force: true }));
  const sentinel = path.join(nodeDir, HARMONIC_GRAPH_VERSION_SENTINEL);

  bumpHarmonicGraphVersion(nodeDir);
  assert.equal(statSync(sentinel).size, 1);
  bumpHarmonicGraphVersion(nodeDir);
  assert.equal(statSync(sentinel).size, 2);
});

test("harmonic version: stamp changes when the harmonic sentinel grows", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-hgv-mem-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  const nodeDir = path.join(memoryDir, "abstraction-nodes");

  const before = readHarmonicGraphStamp(memoryDir, nodeDir);
  assert.equal(before, "0:0:0:0");

  bumpHarmonicGraphVersion(nodeDir);
  const after = readHarmonicGraphStamp(memoryDir, nodeDir);
  assert.notEqual(after, before);
  assert.equal(after.split(":")[3], "1");
});

test("harmonic version: stamp reflects the corpus sentinel too", async (t) => {
  const memoryDir = await mkdtemp(path.join(tmpdir(), "remnic-hgv-mem2-"));
  const nodeDir = await mkdtemp(path.join(tmpdir(), "remnic-hgv-node2-"));
  t.after(() => rm(memoryDir, { recursive: true, force: true }));
  t.after(() => rm(nodeDir, { recursive: true, force: true }));

  const { MEMORY_CORPUS_VERSION_SENTINEL } = await import("./memory-corpus-version.js");
  const { mkdirSync } = await import("node:fs");
  const stateDir = path.join(memoryDir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, MEMORY_CORPUS_VERSION_SENTINEL), "xxx");

  const stamp = readHarmonicGraphStamp(memoryDir, nodeDir);
  assert.equal(stamp.split(":")[0], "3");
});

test("harmonic version: a failed bump is fail-open, never throws", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "remnic-hgv-ro-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // A regular file in place of the store dir makes mkdirSync fail; bump swallows it.
  const fileAsDir = path.join(base, "not-a-dir");
  writeFileSync(fileAsDir, "x");

  assert.doesNotThrow(() => bumpHarmonicGraphVersion(fileAsDir));
});
