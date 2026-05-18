/**
 * codex-materialize-runner.test.ts — runner-level behavior for #378.
 *
 * These tests exercise the I/O bridge in
 * `packages/remnic-core/src/connectors/codex-materialize-runner.ts`:
 *
 *  1. Namespaced memories are read from the same storage root that
 *     `NamespaceStorageRouter` writes to (`memoryDir/namespaces/<ns>`),
 *     not from the legacy `memoryDir/<ns>` layout. The default namespace
 *     still maps to `memoryDir` itself unless a namespaced root exists.
 *  2. `reason="session_end"` short-circuits when
 *     `codexMaterializeOnSessionEnd=false`, honoring the per-trigger toggle
 *     that users control via config.
 *
 * All memory data is synthetic — no real user content per repo privacy
 * policy (see CLAUDE.md).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  runCodexMaterialize,
  runPostConsolidationMaterialize,
} from "../src/connectors/codex-materialize-runner.js";
import { ensureSentinel, SENTINEL_FILE } from "../src/connectors/codex-materialize.js";
import { parseConfig } from "../src/config.js";
import {
  SecureStoreLockedError,
  writeMaybeEncryptedFile,
} from "../src/secure-store/index.js";
import { StorageManager } from "../src/storage.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeCodexHome(): { root: string; memoriesDir: string } {
  const root = makeTempDir("codex-materialize-runner-home-");
  const memoriesDir = path.join(root, "memories");
  mkdirSync(memoriesDir, { recursive: true });
  return { root, memoriesDir };
}

test("parseConfig coerces string Codex materialization config values", () => {
  const config = parseConfig({
    codexMaterializeMemories: "false",
    codexMaterializeOnSessionEnd: "false",
    codexMaterializeOnConsolidation: "false",
    codexMaterializeMaxSummaryTokens: "0",
    codexMaterializeRolloutRetentionDays: "0",
  });

  assert.equal(config.codexMaterializeMemories, false);
  assert.equal(config.codexMaterializeOnSessionEnd, false);
  assert.equal(config.codexMaterializeOnConsolidation, false);
  assert.equal(config.codexMaterializeMaxSummaryTokens, 0);
  assert.equal(config.codexMaterializeRolloutRetentionDays, 0);
});

test("parseConfig rejects invalid Codex materialization numeric config values", () => {
  assert.throws(
    () => parseConfig({ codexMaterializeMaxSummaryTokens: "abc" }),
    /codexMaterializeMaxSummaryTokens must be an integer greater than or equal to 0/,
  );
  assert.throws(
    () => parseConfig({ codexMaterializeRolloutRetentionDays: "3.7" }),
    /codexMaterializeRolloutRetentionDays must be an integer greater than or equal to 0/,
  );
});

test("runner reads namespaced memories from memoryDir/namespaces/<ns> (P1 fix)", async () => {
  const memoryDir = makeTempDir("codex-materialize-runner-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-workspace-");
  const { root: codexHome, memoriesDir } = makeCodexHome();

  try {
    // Seed a synthetic memory into the *namespaced* storage root that
    // NamespaceStorageRouter would use for non-default namespaces.
    const nsName = "synth-ns";
    const nsRoot = path.join(memoryDir, "namespaces", nsName);
    mkdirSync(nsRoot, { recursive: true });
    const nsStorage = new StorageManager(nsRoot);
    await nsStorage.writeMemory(
      "fact",
      "synthetic namespaced memory used to verify runner path resolution.",
      { source: "runner-test" },
    );

    // Intentionally also write a memory to the WRONG legacy path
    // (memoryDir/<ns>) so we can assert the runner is *not* reading it.
    const legacyPath = path.join(memoryDir, nsName);
    mkdirSync(legacyPath, { recursive: true });
    const legacyStorage = new StorageManager(legacyPath);
    await legacyStorage.writeMemory(
      "fact",
      "LEGACY decoy memory that the runner must NOT pick up.",
      { source: "runner-test-decoy" },
    );

    // Opt-in sentinel so the materializer actually writes.
    ensureSentinel(memoriesDir, nsName, new Date("2026-04-02T00:00:00Z"));

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      namespacesEnabled: true,
      defaultNamespace: "default",
      codexMaterializeMemories: true,
    });

    const result = await runCodexMaterialize({
      config,
      namespace: nsName,
      codexHome,
      reason: "manual",
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.ok(result, "runner should have materialized instead of skipping");
    assert.equal(result!.wrote, true);
    assert.equal(result!.skippedNoSentinel, false);

    // MEMORY.md should include the synthetic namespaced memory, and must
    // not include the decoy. We sniff the raw_memories.md contents for
    // concreteness.
    const raw = readdirSync(memoriesDir);
    assert.ok(raw.includes("raw_memories.md"));
    const rawContents = (await import("node:fs")).readFileSync(
      path.join(memoriesDir, "raw_memories.md"),
      "utf-8",
    );
    assert.match(rawContents, /synthetic namespaced memory/);
    assert.doesNotMatch(rawContents, /LEGACY decoy/);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner skips when reason=session_end and codexMaterializeOnSessionEnd=false (P2 fix)", async () => {
  const memoryDir = makeTempDir("codex-materialize-runner-sessend-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-sessend-workspace-");
  const { root: codexHome, memoriesDir } = makeCodexHome();

  try {
    const storage = new StorageManager(memoryDir);
    await storage.writeMemory(
      "fact",
      "synthetic session-end gating memory.",
      { source: "runner-test" },
    );

    ensureSentinel(memoriesDir, "default", new Date("2026-04-02T00:00:00Z"));

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      codexMaterializeMemories: true,
      codexMaterializeOnSessionEnd: false,
    });

    const result = await runCodexMaterialize({
      config,
      codexHome,
      reason: "session_end",
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.equal(result, null, "runner should short-circuit for disabled session_end");

    // No Codex artifacts beyond the sentinel should have been created.
    const filesAfter = readdirSync(memoriesDir).sort();
    assert.deepEqual(filesAfter, [SENTINEL_FILE]);
    assert.equal(existsSync(path.join(memoriesDir, "MEMORY.md")), false);
    assert.equal(existsSync(path.join(memoriesDir, "memory_summary.md")), false);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner propagates schema errors instead of silently returning null", async () => {
  // Regression (Cursor Bugbot on #392): the old catch-all turned schema
  // validation throws from materializeForNamespace into silent `null`
  // returns, breaking the JSDoc contract. Verify a hard I/O error bubbles
  // up to the caller instead of being swallowed.
  //
  // To hit an actual write-path failure we need:
  //   - `codexHome/memories/` exists as a real directory (opt-in branch)
  //   - a valid sentinel is present (idempotent guard doesn't short-circuit)
  //   - writing to `memoriesDir` fails at rename time
  //
  // We accomplish the write failure by placing a pre-existing *directory*
  // at the destination path `memoriesDir/memory_summary.md`. renameSync
  // cannot replace a directory with a file, so we get EISDIR which the
  // runner must propagate rather than silently swallow.
  const fsMod = await import("node:fs");
  const memoryDir = makeTempDir("codex-materialize-runner-throw-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-throw-workspace-");
  const { root: codexHome, memoriesDir } = makeCodexHome();

  try {
    const storage = new StorageManager(memoryDir);
    await storage.writeMemory("fact", "synthetic throw propagation memory.", { source: "runner-test" });
    ensureSentinel(memoriesDir, "default", new Date("2026-04-02T00:00:00Z"));

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      codexMaterializeMemories: true,
    });

    // Block the rename by planting a directory where the renamer wants to
    // put a file. On POSIX this surfaces as EISDIR; on Windows it shows up
    // as EPERM/EACCES/EEXIST. Match any of those.
    fsMod.mkdirSync(path.join(memoriesDir, "memory_summary.md"), { recursive: true });
    fsMod.writeFileSync(
      path.join(memoriesDir, "memory_summary.md", "blocker.txt"),
      "synthetic blocker — forces rename to fail",
    );

    await assert.rejects(
      runCodexMaterialize({
        config,
        codexHome,
        reason: "manual",
        now: new Date("2026-04-02T00:00:00Z"),
      }),
      /EISDIR|ENOTEMPTY|EEXIST|EPERM|EACCES|is a directory|directory not empty|file already exists/iu,
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner skips before reading locked memories when Codex sentinel is missing", async () => {
  const memoryDir = makeTempDir("codex-materialize-runner-nosentinel-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-nosentinel-workspace-");
  const { root: codexHome } = makeCodexHome();

  try {
    const lockedMemoryPath = path.join(memoryDir, "facts", "2026-04-02", "locked.md");
    await writeMaybeEncryptedFile(
      lockedMemoryPath,
      "---\nid: locked-test-memory\ncategory: fact\n---\nsynthetic locked memory",
      Buffer.alloc(32, 0x42),
      {},
      memoryDir,
    );

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      codexMaterializeMemories: true,
    });

    const result = await runCodexMaterialize({
      config,
      codexHome,
      reason: "manual",
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.ok(result, "missing sentinel should return an expected skip result");
    assert.equal(result.skippedNoSentinel, true);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner propagates opted-in storage read failures while post-consolidation catches them", async () => {
  const memoryDir = makeTempDir("codex-materialize-runner-readfail-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-readfail-workspace-");
  const { root: codexHome, memoriesDir } = makeCodexHome();

  try {
    const lockedMemoryPath = path.join(memoryDir, "facts", "2026-04-02", "locked.md");
    await writeMaybeEncryptedFile(
      lockedMemoryPath,
      "---\nid: locked-test-memory\ncategory: fact\n---\nsynthetic locked memory",
      Buffer.alloc(32, 0x42),
      {},
      memoryDir,
    );
    ensureSentinel(memoriesDir, "default", new Date("2026-04-02T00:00:00Z"));

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      codexMaterializeMemories: true,
    });

    await assert.rejects(
      runCodexMaterialize({
        config,
        codexHome,
        reason: "manual",
        now: new Date("2026-04-02T00:00:00Z"),
      }),
      (error) => error instanceof SecureStoreLockedError,
    );

    const postConsolidationResult = await runPostConsolidationMaterialize("[test]", {
      config,
      codexHome,
      now: new Date("2026-04-02T00:00:00Z"),
    });
    assert.equal(postConsolidationResult, null);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("runner still runs on session_end when codexMaterializeOnSessionEnd=true (default)", async () => {
  const memoryDir = makeTempDir("codex-materialize-runner-sessend-on-memdir-");
  const workspaceDir = makeTempDir("codex-materialize-runner-sessend-on-workspace-");
  const { root: codexHome, memoriesDir } = makeCodexHome();

  try {
    const storage = new StorageManager(memoryDir);
    await storage.writeMemory(
      "fact",
      "synthetic session-end enabled memory.",
      { source: "runner-test" },
    );

    ensureSentinel(memoriesDir, "default", new Date("2026-04-02T00:00:00Z"));

    const config = parseConfig({
      openaiApiKey: "sk-test",
      memoryDir,
      workspaceDir,
      qmdEnabled: false,
      codexMaterializeMemories: true,
      // codexMaterializeOnSessionEnd defaults to true.
    });

    const result = await runCodexMaterialize({
      config,
      codexHome,
      reason: "session_end",
      now: new Date("2026-04-02T00:00:00Z"),
    });

    assert.ok(result, "runner should have materialized on session_end when toggle is on");
    assert.equal(result!.wrote, true);
    assert.ok(existsSync(path.join(memoriesDir, "MEMORY.md")));
    assert.ok(existsSync(path.join(memoriesDir, "memory_summary.md")));
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});
