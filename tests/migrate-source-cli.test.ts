import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runMigrate(args: string[], homeDir: string) {
  return spawnSync(process.execPath, [tsxCli, "scripts/migrate.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      HONCHO_API_KEY: "",
    },
    timeout: 30_000,
  });
}

test("migrate accepts --source as a separate argument and limits selected sources", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-home-"));
  try {
    const result = runMigrate(["--dry-run", "--source", "context"], homeDir);

    assert.equal(
      result.status,
      0,
      `expected migrate to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /Source:\s+context/);
    assert.match(result.stdout, /Migrating context files/);
    assert.doesNotMatch(result.stdout, /Migrating Supermemory daily logs/);
    assert.doesNotMatch(result.stdout, /Migrating Honcho conclusions/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("migrate rejects invalid --source values before creating migration directories", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-home-"));
  try {
    const result = runMigrate(["--source", "bogus"], homeDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--source must be one of context\|supermemory\|honcho\|all/);
    assert.equal(existsSync(path.join(homeDir, ".openclaw")), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("migrate rejects --source with no value", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-home-"));
  try {
    const result = runMigrate(["--source", "--dry-run"], homeDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--source requires a value/);
    assert.equal(existsSync(path.join(homeDir, ".openclaw")), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("migrate rejects unknown arguments instead of defaulting to all sources", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-home-"));
  try {
    const result = runMigrate(["--sourc", "context"], homeDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown argument: --sourc/);
    assert.equal(existsSync(path.join(homeDir, ".openclaw")), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("migrate preserves corrupt meta.json instead of replacing it", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "remnic-migrate-home-"));
  try {
    const stateDir = path.join(homeDir, ".openclaw", "workspace", "memory", "local", "state");
    const metaPath = path.join(stateDir, "meta.json");
    await mkdir(stateDir, { recursive: true });
    await writeFile(metaPath, "{not valid json", "utf-8");

    const result = runMigrate(["--source", "context"], homeDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed to read existing migration meta state/);
    assert.equal(await readFile(metaPath, "utf-8"), "{not valid json");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
