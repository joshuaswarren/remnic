import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { StorageManager } from "../src/storage.js";
import { lintWorkspaceFiles } from "../src/hygiene.js";
import type { FileHygieneConfig } from "../src/types.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

test("file hygiene: rotates oversized IDENTITY.md into archive and replaces with lean index", async () => {
  const root = tmpDir("engram-hygiene");
  const workspaceDir = path.join(root, "workspace");
  const memoryDir = path.join(root, "memory");
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });

  const identityPath = path.join(workspaceDir, "IDENTITY.md");
  await writeFile(identityPath, "# IDENTITY\n\n" + "x".repeat(2000), "utf-8");

  const hygiene: FileHygieneConfig = {
    enabled: true,
    lintEnabled: true,
    lintBudgetBytes: 1500,
    lintWarnRatio: 0.8,
    lintPaths: ["IDENTITY.md"],
    rotateEnabled: true,
    rotateMaxBytes: 1500,
    rotateKeepTailChars: 200,
    rotatePaths: ["IDENTITY.md"],
    archiveDir: ".engram-archive",
    runMinIntervalMs: 0,
    warningsLogEnabled: false,
    warningsLogPath: "hygiene/warnings.log",
    indexEnabled: false,
    indexPath: "ENGRAM_INDEX.md",
  };

  const storage = new StorageManager(memoryDir);
  await storage.appendToIdentity(workspaceDir, "hello world", { hygiene });

  const updated = await readFile(identityPath, "utf-8");
  assert.match(updated, /This file is kept intentionally small/i);
  assert.match(updated, /Archives/i);
  assert.match(updated, /hello world/i);

  const archiveDir = path.join(workspaceDir, ".engram-archive");
  const archiveEntries = await readdir(archiveDir, { recursive: true });
  const archived = archiveEntries.filter(
    (p) => typeof p === "string" && p.includes("IDENTITY-") && p.endsWith(".md"),
  );
  assert.ok(archived.length >= 1, "expected at least one archived identity file");
});

test("file hygiene: lintWorkspaceFiles warns when a bootstrap file approaches budget", async () => {
  const root = tmpDir("engram-hygiene-lint");
  const workspaceDir = path.join(root, "workspace");
  await mkdir(workspaceDir, { recursive: true });

  await writeFile(path.join(workspaceDir, "MEMORY.md"), "a".repeat(900), "utf-8");

  const warnings = await lintWorkspaceFiles({
    workspaceDir,
    paths: ["MEMORY.md"],
    budgetBytes: 1000,
    warnRatio: 0.8,
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.message, /approaching.*budget/i);
});

