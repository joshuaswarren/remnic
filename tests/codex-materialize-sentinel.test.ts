import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensureSentinel,
  materializeForNamespace,
  SENTINEL_FILE,
  MATERIALIZE_VERSION,
} from "../src/connectors/codex-materialize.js";
import type { MemoryFile } from "../src/types.js";

function makeMemory(): MemoryFile {
  return {
    path: "/tmp/remnic-test/facts/sentinel.md",
    frontmatter: {
      id: "sentinel-synthetic",
      category: "fact" as any,
      created: "2026-04-01T00:00:00Z",
      updated: "2026-04-01T00:00:00Z",
      source: "synthetic-test",
      confidence: 0.9,
      confidenceTier: "implied",
      tags: [],
    } as any,
    content: "synthetic sentinel content",
  };
}

function makeTempCodexHome(): { root: string; memoriesDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-materialize-sentinel-test-"));
  const memoriesDir = path.join(root, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  return { root, memoriesDir };
}

test("sentinel missing → warns and skips, leaves directory untouched", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  let warnings = 0;
  try {
    const result = materializeForNamespace("synthetic-ns", {
      memories: [makeMemory()],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
      logger: {
        info: () => {},
        warn: () => {
          warnings++;
        },
      },
    });
    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
    assert.ok(warnings >= 1, "materializer should emit at least one warning");
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt sentinel throws instead of permanently skipping materialization", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    writeFileSync(path.join(memoriesDir, SENTINEL_FILE), "{");

    assert.throws(
      () =>
        materializeForNamespace("synthetic-ns", {
          memories: [makeMemory()],
          codexHome: root,
          now: new Date("2026-04-02T00:00:00Z"),
          logger: { info: () => {}, warn: () => {} },
        }),
      /codex-materialize: corrupt \.remnic-managed sentinel/,
    );
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSentinel is idempotent and does not overwrite an existing hash", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // First create the sentinel, then run a real materialization to populate hash.
    ensureSentinel(memoriesDir, "idem-ns");
    const result = materializeForNamespace("idem-ns", {
      memories: [makeMemory()],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.wrote, true);
    const before = JSON.parse(readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf-8"));
    assert.equal(before.version, MATERIALIZE_VERSION);
    assert.ok(before.content_hash.length > 0);

    // Second ensureSentinel() must NOT clobber the hash — the real hash
    // should survive so the next run's idempotent check still works.
    ensureSentinel(memoriesDir, "idem-ns");
    const after = JSON.parse(readFileSync(path.join(memoriesDir, SENTINEL_FILE), "utf-8"));
    assert.equal(after.content_hash, before.content_hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing sentinel + hand-edited user files must never be overwritten", () => {
  const { root, memoriesDir } = makeTempCodexHome();
  try {
    // Pretend the user already created their own MEMORY.md by hand.
    const userContent = "# Hand-edited by user, do not touch\n";
    writeFileSync(path.join(memoriesDir, "MEMORY.md"), userContent);

    const result = materializeForNamespace("synthetic-ns", {
      memories: [makeMemory()],
      codexHome: root,
      now: new Date("2026-04-02T00:00:00Z"),
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(result.skippedNoSentinel, true);
    assert.equal(result.wrote, false);
    const after = readFileSync(path.join(memoriesDir, "MEMORY.md"), "utf-8");
    assert.equal(after, userContent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
