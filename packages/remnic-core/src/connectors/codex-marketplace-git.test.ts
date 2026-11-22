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
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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

test("#3611 ambient git config cannot re-enable ext:: or run hooks", async () => {
  // w7X's second exploit: a hostile global gitconfig can re-enable the ext::
  // transport (arbitrary command execution) and point hooksPath at a
  // post-checkout hook that runs during our clone. The clone must run with
  // GIT_CONFIG_NOSYSTEM/GIT_CONFIG_GLOBAL neutralized, a closed protocol
  // allowlist, and hooks disabled.
  const hostile = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-hostile-"));
  const remote = await makeGitRemote();
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  const hooksDir = path.join(hostile, "hooks");
  const hookMarker = path.join(hostile, "hook-ran");
  const extMarker = path.join(hostile, "ext-ran");
  try {
    await mkdir(hooksDir);
    await writeFile(
      path.join(hooksDir, "post-checkout"),
      `#!/bin/sh\ntouch ${hookMarker}\n`,
      { mode: 0o755 },
    );
    const cfgFile = path.join(hostile, "gitconfig");
    await writeFile(
      cfgFile,
      `[protocol "ext"]\n\tallow = always\n[core]\n\thooksPath = ${hooksDir}\n`,
    );

    const prev = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfgFile;
    try {
      const cloned = await installFromMarketplace(
        remote.fileUrl,
        "git",
        marketplaceConfig(memoryDir),
      );
      assert.equal(cloned.ok, true, cloned.message);
      assert.equal(
        existsSync(hookMarker),
        false,
        "ambient hooksPath ran a post-checkout hook during clone",
      );

      const ext = await installFromMarketplace(
        `ext::sh -c "touch ${extMarker}"`,
        "git",
        marketplaceConfig(memoryDir),
      );
      assert.equal(ext.ok, false, "ext:: transport must not be allowed");
      assert.equal(
        existsSync(extMarker),
        false,
        "ambient protocol.ext.allow=always let ext:: execute a command",
      );
    } finally {
      if (prev === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = prev;
      }
    }
  } finally {
    await rm(hostile, { recursive: true, force: true });
    await rm(remote.dir, { recursive: true, force: true });
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#3611 a failed clone leaves no temp dir behind", async () => {
  // w7X's third finding: mkdtemp ran before the clone, and the rm sat in a
  // finally that only wrapped resolveLocal — every clone failure (including
  // timeout) leaked remnic-marketplace-git-* dirs.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  try {
    const count = async () =>
      (await readdir(os.tmpdir())).filter((d) =>
        d.startsWith("remnic-marketplace-git-"),
      ).length;
    const before = await count();
    const result = await installFromMarketplace(
      "file:///definitely/not/a/repo-3611",
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, false);
    assert.equal(await count(), before, "failed clone leaked a temp dir");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("#3611 scheme-less github.com/owner/repo resolves via the github route", async () => {
  // Post-#3628 regression (Main's diff read): the removed regex also accepted
  // scheme-less `github.com/owner/repo` and routed it to resolveGithub. With
  // resolveGit = clone, the same string is treated as a local path and fails.
  // The fix must restore the github route for that form — proven here by a
  // stubbed fetch observing the raw.githubusercontent.com request.
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mkt-cfg-"));
  const prevFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input: Parameters<typeof fetch>[0]) => {
    calls.push(String(input));
    return new Response(MANIFEST, { status: 200 });
  };
  try {
    const result = await installFromMarketplace(
      "github.com/owner/repo",
      "git",
      marketplaceConfig(memoryDir),
    );
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.pluginsFound, ["demo"]);
    assert.ok(
      calls.some((u) => u.includes("raw.githubusercontent.com/owner/repo")),
      `expected a GitHub raw manifest fetch, got: ${calls.join(", ") || "(none)"}`,
    );
  } finally {
    globalThis.fetch = prevFetch;
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
