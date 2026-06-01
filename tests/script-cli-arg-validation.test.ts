import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runScript(script: string, args: string[]) {
  return spawnSync(process.execPath, [tsxCli, script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      REMNIC_OPENCLAW_SURFACE_DISABLE_AUTO_RESOLVE: "1",
    },
    timeout: 30_000,
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

test("codex-materialize rejects missing --memory-dir value before consuming --json", () => {
  const result = runScript("scripts/codex-materialize.ts", [
    "--memory-dir",
    "--json",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--memory-dir requires a value/);
});

test("eval-ci-gate rejects missing --base value before consuming --candidate", () => {
  const result = runScript("scripts/eval-ci-gate.ts", [
    "--base",
    "--candidate",
    "./candidate",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--base requires a value/);
});

test("eval-baseline-ci-gate rejects missing --snapshot-id value before consuming --base", () => {
  const result = runScript("scripts/eval-baseline-ci-gate.ts", [
    "--snapshot-id",
    "--base",
    "./base",
    "--candidate",
    "./candidate",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--snapshot-id requires a value/);
});

test("set-release-version accepts prerelease and build metadata SemVer", () => {
  const result = runScript("scripts/set-release-version.mjs", [
    "1.0.0-rc.1+001",
    "--dry-run",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\.0\.0-rc\.1\+001/);
});

test("set-release-version syncs OpenClaw companion manifests", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "remnic-release-version-"));
  try {
    await mkdir(path.join(repo, "packages", "plugin-openclaw"), { recursive: true });
    await mkdir(path.join(repo, "packages", "shim-openclaw-engram"), { recursive: true });
    await writeJson(path.join(repo, "package.json"), {
      private: true,
      version: "0.0.0",
    });
    await writeJson(path.join(repo, "packages", "plugin-openclaw", "package.json"), {
      name: "@remnic/plugin-openclaw",
      version: "1.2.3",
    });
    await writeJson(path.join(repo, "packages", "plugin-openclaw", "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "1.0.0",
    });
    await writeJson(path.join(repo, "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "1.0.0",
    });
    await writeJson(path.join(repo, "packages", "shim-openclaw-engram", "package.json"), {
      name: "@remnic/openclaw-engram",
      version: "1.0.0",
    });
    await writeJson(path.join(repo, "packages", "shim-openclaw-engram", "openclaw.plugin.json"), {
      id: "openclaw-engram",
      version: "1.0.0",
    });

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "set-release-version.mjs"),
      "1.2.3",
    ], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      (await readJson(path.join(repo, "packages", "plugin-openclaw", "package.json"))).version,
      "1.2.3",
    );
    assert.equal(
      (await readJson(path.join(repo, "packages", "plugin-openclaw", "openclaw.plugin.json"))).version,
      "1.2.3",
    );
    assert.equal((await readJson(path.join(repo, "openclaw.plugin.json"))).version, "1.2.3");
    assert.equal(
      (await readJson(path.join(repo, "packages", "shim-openclaw-engram", "package.json"))).version,
      "1.2.3",
    );
    assert.equal(
      (await readJson(path.join(repo, "packages", "shim-openclaw-engram", "openclaw.plugin.json"))).version,
      "1.2.3",
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("set-release-version syncs Remnic peer dependency ranges", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "remnic-release-peers-"));
  try {
    await mkdir(path.join(repo, "packages", "remnic-core"), { recursive: true });
    await mkdir(path.join(repo, "packages", "import-mem0"), { recursive: true });
    await writeJson(path.join(repo, "package.json"), {
      private: true,
      version: "0.0.0",
    });
    await writeJson(path.join(repo, "packages", "remnic-core", "package.json"), {
      name: "@remnic/core",
      version: "9.3.0",
    });
    await writeJson(path.join(repo, "packages", "import-mem0", "package.json"), {
      name: "@remnic/import-mem0",
      version: "9.3.0",
      peerDependencies: {
        "@remnic/core": "^1.1.31",
      },
    });

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "set-release-version.mjs"),
      "9.3.0",
    ], {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr);
    const importer = await readJson(path.join(repo, "packages", "import-mem0", "package.json"));
    assert.deepEqual(importer.peerDependencies, {
      "@remnic/core": "^9.3.0",
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
