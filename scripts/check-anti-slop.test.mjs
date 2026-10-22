import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("the required lint gate rejects new violations without repinning legacy code", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-anti-slop-"));
  const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${dir}`, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    cwd: dir, encoding: "utf8", stdio: "pipe",
  });
  const check = () => spawnSync(process.execPath, [path.join(root, "scripts/check-anti-slop.mjs")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, REMNIC_ANTI_SLOP_BASE_REF: "origin/main" },
  });
  try {
    git("init", "-b", "main");
    const config = JSON.parse(await readFile(path.join(root, ".oxlintrc.json"), "utf8"));
    config.jsPlugins[0].specifier = path.join(root, "tools/oxlint/anti-slop/index.ts");
    await writeFile(path.join(dir, ".oxlintrc.json"), JSON.stringify(config));
    const old = "export function existing(value: unknown) { return value; }\n";
    await writeFile(path.join(dir, "sample.ts"), old);
    git("add", ".");
    git("commit", "-m", "Baseline");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("commit", "--allow-empty", "-m", "Head");
    await writeFile(path.join(dir, "sample.ts"), old + "export const valid = 1;\n");
    const legacy = check();
    assert.equal(legacy.status, 0, legacy.stdout + legacy.stderr);
    await writeFile(path.join(dir, "sample.ts"), old + "export function added(value: unknown) { return value; }\n");
    const changed = check();
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stderr, /no-unknown-parameters/);
    await writeFile(path.join(dir, "sample.ts"), old);
    await writeFile(path.join(dir, "new.ts"), "export function untracked(value: unknown) { return value; }\n");
    const untracked = check();
    assert.equal(untracked.status, 1, untracked.stdout + untracked.stderr);
    assert.match(untracked.stderr, /new\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
