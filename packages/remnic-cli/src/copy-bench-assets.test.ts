import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const copyScriptPath = path.join(repoRoot, "packages", "remnic-cli", "scripts", "copy-bench-assets.mjs");
const repoDownloadWrapperPath = path.join(repoRoot, "evals", "scripts", "download-datasets.sh");

test("copy-bench-assets works from an isolated CLI package layout", async () => {
  const fixtureRoot = await makeCliPackageFixture();
  const assetPath = path.join(fixtureRoot, "assets", "download-datasets.sh");
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, "#!/usr/bin/env bash\necho fixture-download\n", {
    encoding: "utf8",
    mode: 0o755,
  });

  const result = spawnSync(process.execPath, [path.join(fixtureRoot, "scripts", "copy-bench-assets.mjs")], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /assets\/download-datasets\.sh/);

  const copiedPath = path.join(fixtureRoot, "dist", "assets", "download-datasets.sh");
  assert.equal(await readFile(copiedPath, "utf8"), "#!/usr/bin/env bash\necho fixture-download\n");

  const copiedStat = await stat(copiedPath);
  assert.equal(copiedStat.mode & 0o111, 0o111);
});

test("copy-bench-assets reports a package-local missing asset path", async () => {
  const fixtureRoot = await makeCliPackageFixture();

  const result = spawnSync(process.execPath, [path.join(fixtureRoot, "scripts", "copy-bench-assets.mjs")], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[copy-bench-assets\] source not found:/);
  assert.match(result.stderr, /assets\/download-datasets\.sh/);
  assert.doesNotMatch(result.stderr, /\.\.\/\.\.\/evals/);
});

test("repo download wrapper preserves evals datasets as the default destination", async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-download-wrapper-"));
  const wrapperPath = path.join(fixtureRoot, "evals", "scripts", "download-datasets.sh");
  const packageScriptPath = path.join(fixtureRoot, "packages", "remnic-cli", "assets", "download-datasets.sh");
  await mkdir(path.dirname(wrapperPath), { recursive: true });
  await mkdir(path.dirname(packageScriptPath), { recursive: true });
  await writeFile(wrapperPath, await readFile(repoDownloadWrapperPath, "utf8"), {
    encoding: "utf8",
    mode: 0o755,
  });
  await writeFile(packageScriptPath, "#!/usr/bin/env bash\nprintf '%s\\n' \"$DATASETS_DIR\"\n", {
    encoding: "utf8",
    mode: 0o755,
  });

  const defaultResult = spawnSync("bash", [wrapperPath], {
    cwd: fixtureRoot,
    encoding: "utf8",
  });
  assert.equal(defaultResult.status, 0, defaultResult.stderr);
  assert.equal(defaultResult.stdout.trim(), path.join(fixtureRoot, "evals", "datasets"));

  const explicitDatasetsDir = path.join(fixtureRoot, "custom-datasets");
  const explicitResult = spawnSync("bash", [wrapperPath], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: { ...process.env, DATASETS_DIR: explicitDatasetsDir },
  });
  assert.equal(explicitResult.status, 0, explicitResult.stderr);
  assert.equal(explicitResult.stdout.trim(), explicitDatasetsDir);
});

async function makeCliPackageFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-copy-assets-"));
  const scriptsDir = path.join(fixtureRoot, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(
    path.join(scriptsDir, "copy-bench-assets.mjs"),
    await readFile(copyScriptPath, "utf8"),
    "utf8",
  );
  return fixtureRoot;
}
