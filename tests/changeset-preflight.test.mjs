import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preflight = path.join(repoRoot, "scripts", "pr-preflight.sh");

function check(...paths) {
  return spawnSync("bash", [preflight, "--check-changeset", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

test("preflight warns for a code diff without a changeset", () => {
  const result = check("packages/remnic-core/src/index.ts");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: code changes detected without a changeset/);
  assert.match(result.stdout, /node scripts\/changeset-stub\.mjs/);
});

test("preflight stays silent when a changeset exists", () => {
  const result = check("packages/remnic-core/src/index.ts", ".changeset/fix-core.md");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("preflight stays silent for documentation-only changes", () => {
  const result = check("docs/plugins/core.md", "README.md");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
test("preflight warns for shipped skill markdown without a changeset", () => {
  const result = check("packages/plugin-openclaw/skills/recall/SKILL.md");

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARNING: code changes detected without a changeset/);
});

test("preflight stays silent for release-only root manifests", () => {
  const result = check("openclaw.plugin.json", "packages/plugin-openclaw/package.json");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
