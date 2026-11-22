/**
 * #3611: `resolveGit` delegated git URLs to raw-URL resolution — only
 * GitHub-HTTPS-shaped inputs survived; SSH URLs (git@host:o/r.git), GitLab,
 * self-hosted remotes, and file:// / local-path git sources all threw
 * "Git URL resolution requires a GitHub-format URL", and the error even
 * misdirected to --type github, which cannot parse SSH form either.
 *
 * Root fix: resolve the manifest by really cloning the source
 * (`git clone --depth 1`), then reading marketplace.json from the
 * checkout. These tests use local file:// remotes so they are hermetic —
 * the same code path carries SSH and hosted HTTPS URLs because git
 * handles the transport.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "../config.js";
import { installFromMarketplace } from "./codex-marketplace.js";

const MANIFEST = JSON.stringify(
  {
    version: 1,
    name: "test-market",
    description: "fixture",
    plugins: [
      {
        name: "demo",
        version: "1.0.0",
        description: "demo plugin",
        repository: "owner/repo",
        installType: "git",
      },
    ],
  },
  null,
  2,
);

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function makeGitRemote(): Promise<{ dir: string; fileUrl: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-git-"));
  git(dir, ["init", "-q", "-b", "main"]);
  // Fleet git-identity-guard hook lives in a global core.hooksPath and
  // refuses fixture commits; point this throwaway repo at an empty dir.
  const noHooks = path.join(dir, ".no-hooks");
  await mkdir(noHooks);
  git(dir, ["config", "core.hooksPath", noHooks]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  await writeFile(path.join(dir, "marketplace.json"), MANIFEST);
  git(dir, ["add", "marketplace.json"]);
  git(dir, ["commit", "-qm", "init"]);
  return { dir, fileUrl: `file://${dir}` };
}

function marketplaceConfig(memoryDir: string) {
  return parseConfig({
    openaiApiKey: "sk-test",
    memoryDir,
    workspaceDir: path.join(memoryDir, "workspace"),
    codexMarketplaceEnabled: true,
  });
}

test("#3611 git source resolves a file:// remote by cloning", async () => {
  const remote = await makeGitRemote();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  try {
    const result = await installFromMarketplace(
      remote.fileUrl,
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.pluginsFound, ["demo"]);
  } finally {
    await rm(remote.dir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#3611 git source resolves a local-path remote by cloning", async () => {
  const remote = await makeGitRemote();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  try {
    const result = await installFromMarketplace(
      remote.dir,
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.pluginsFound, ["demo"]);
  } finally {
    await rm(remote.dir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#3611 flag-shaped git source is rejected before clone", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  try {
    const result = await installFromMarketplace(
      "--upload-pack=/bin/false",
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes("must not look like a flag")),
      `expected the flag guard, got: ${result.errors.join("; ")}`,
    );
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#3611 non-repo git source fails as a clone error, not the stub", async () => {
  const notRepo = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-notgit-"));
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  try {
    const result = await installFromMarketplace(
      `file://${notRepo}`,
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, false);
    assert.equal(result.pluginsFound.length, 0);
    assert.ok(
      !result.errors.some((e) => e.includes("GitHub-format URL")),
      `must not fall back to the raw-URL delegation stub: ${result.errors.join("; ")}`,
    );
  } finally {
    await rm(notRepo, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});
