import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs } from "./bump-changed-packages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "bump-changed-packages.mjs");

function run(cwd, command, args) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function git(cwd, args) {
  return run(cwd, "git", args);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function withRepo(fn) {
  const repo = await mkdtemp(path.join(os.tmpdir(), "remnic-bump-packages-"));
  try {
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.name", "Test User"]);
    git(repo, ["config", "user.email", "test@example.com"]);

    await mkdir(path.join(repo, "packages", "remnic-core", "src"), { recursive: true });
    await mkdir(path.join(repo, "packages", "plugin-openclaw"), { recursive: true });
    await mkdir(path.join(repo, "packages", "plugin-claude-code", ".claude-plugin"), { recursive: true });
    await mkdir(path.join(repo, "packages", "plugin-claude-code", "src"), { recursive: true });
    await mkdir(path.join(repo, "packages", "bench-ui"), { recursive: true });

    await writeJson(path.join(repo, "package.json"), {
      name: "fixture",
      private: true,
      version: "0.0.0",
      workspaces: ["packages/*"],
    });
    await writeJson(path.join(repo, "packages", "remnic-core", "package.json"), {
      name: "@remnic/core",
      version: "1.0.0",
    });
    await writeFile(path.join(repo, "packages", "remnic-core", "src", "index.ts"), "export {};\n");
    await writeJson(path.join(repo, "packages", "plugin-openclaw", "package.json"), {
      name: "@remnic/plugin-openclaw",
      version: "2.0.0",
    });
    await writeJson(path.join(repo, "packages", "plugin-openclaw", "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "2.0.0",
    });
    await writeJson(path.join(repo, "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "2.0.0",
    });
    await writeJson(path.join(repo, "packages", "plugin-claude-code", "package.json"), {
      name: "@remnic/plugin-claude-code",
      version: "3.0.0",
    });
    await writeFile(
      path.join(repo, "packages", "plugin-claude-code", "src", "index.ts"),
      "export {};\n",
    );
    await writeJson(path.join(repo, "packages", "plugin-claude-code", ".claude-plugin", "plugin.json"), {
      name: "Remnic",
      version: "3.0.0",
    });
    await writeJson(path.join(repo, "packages", "bench-ui", "package.json"), {
      name: "@remnic/bench-ui",
      private: true,
      version: "0.1.0",
    });

    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "initial"]);
    git(repo, ["tag", "v1.0.0"]);

    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

test("bumps only the public package whose files changed", async () => {
  await withRepo(async (repo) => {
    await writeFile(
      path.join(repo, "packages", "remnic-core", "src", "index.ts"),
      "export const changed = true;\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "change core"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const core = await readJson(path.join(repo, "packages", "remnic-core", "package.json"));
    const plugin = await readJson(path.join(repo, "packages", "plugin-openclaw", "package.json"));
    const benchUi = await readJson(path.join(repo, "packages", "bench-ui", "package.json"));
    assert.equal(core.version, "1.0.1");
    assert.equal(plugin.version, "2.0.0");
    assert.equal(benchUi.version, "0.1.0");
  });
});

test("root OpenClaw manifest changes bump plugin package and synced manifests", async () => {
  await withRepo(async (repo) => {
    await writeJson(path.join(repo, "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "2.0.0",
      description: "changed",
    });
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "change root manifest"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const plugin = await readJson(path.join(repo, "packages", "plugin-openclaw", "package.json"));
    const rootManifest = await readJson(path.join(repo, "openclaw.plugin.json"));
    const packageManifest = await readJson(
      path.join(repo, "packages", "plugin-openclaw", "openclaw.plugin.json"),
    );
    assert.equal(plugin.version, "2.0.1");
    assert.equal(rootManifest.version, "2.0.1");
    assert.equal(packageManifest.version, "2.0.1");
  });
});

test("Claude package changes bump and sync the Claude companion manifest", async () => {
  await withRepo(async (repo) => {
    await writeFile(
      path.join(repo, "packages", "plugin-claude-code", "src", "index.ts"),
      "export const changed = true;\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "change claude plugin"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const plugin = await readJson(path.join(repo, "packages", "plugin-claude-code", "package.json"));
    const companionManifest = await readJson(
      path.join(repo, "packages", "plugin-claude-code", ".claude-plugin", "plugin.json"),
    );
    assert.equal(plugin.version, "3.0.1");
    assert.equal(companionManifest.version, "3.0.1");
  });
});

test("does not auto-bump when the package version already changed", async () => {
  await withRepo(async (repo) => {
    const packageJson = path.join(repo, "packages", "remnic-core", "package.json");
    const manifest = await readJson(packageJson);
    manifest.version = "1.2.0";
    await writeJson(packageJson, manifest);
    await writeFile(
      path.join(repo, "packages", "remnic-core", "src", "index.ts"),
      "export const manuallyBumped = true;\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "manual package bump"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const core = await readJson(packageJson);
    assert.equal(core.version, "1.2.0");
  });
});

test("bumps from tagged version when current package version lags behind base tag", async () => {
  await withRepo(async (repo) => {
    const packageJson = path.join(repo, "packages", "remnic-core", "package.json");
    const manifest = await readJson(packageJson);
    manifest.version = "0.9.0";
    await writeJson(packageJson, manifest);
    await writeFile(
      path.join(repo, "packages", "remnic-core", "src", "index.ts"),
      "export const sourceChanged = true;\n",
    );
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "lagging main package version"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const core = await readJson(packageJson);
    assert.equal(core.version, "1.0.1");
  });
});

test("uses release tag source sha for changed files while reading versions from tag", async () => {
  await withRepo(async (repo) => {
    const sourceSha = git(repo, ["rev-parse", "HEAD"]);

    const corePackageJson = path.join(repo, "packages", "remnic-core", "package.json");
    const coreManifest = await readJson(corePackageJson);
    coreManifest.version = "1.0.1";
    await writeJson(corePackageJson, coreManifest);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "release-only package bump"]);
    git(repo, [
      "tag",
      "-f",
      "-a",
      "v1.0.0",
      "-m",
      "Release v1.0.0",
      "-m",
      `source-main-sha: ${sourceSha}`,
    ]);

    git(repo, ["reset", "--hard", sourceSha]);
    await writeJson(path.join(repo, "packages", "plugin-openclaw", "openclaw.plugin.json"), {
      id: "openclaw-remnic",
      version: "2.0.0",
      description: "changed",
    });
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "change plugin manifest"]);

    run(repo, "node", [scriptPath, "--base", "v1.0.0"]);

    const core = await readJson(corePackageJson);
    const plugin = await readJson(path.join(repo, "packages", "plugin-openclaw", "package.json"));
    assert.equal(core.version, "1.0.0");
    assert.equal(plugin.version, "2.0.1");
  });
});

test("rejects missing option values before parsing later flags", () => {
  assert.throws(
    () => parseArgs(["--base", "--head", "HEAD"]),
    /Missing value for --base/,
  );
});

test("rejects invalid bump values upfront", () => {
  assert.throws(
    () => parseArgs(["--base", "v1.0.0", "--bump", "banana"]),
    /Invalid --bump value "banana". Valid values: major, minor, patch./,
  );
});
