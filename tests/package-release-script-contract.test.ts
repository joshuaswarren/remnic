import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("prepack runs the type gate before building package artifacts", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };

  const prepack = pkg.scripts?.prepack ?? "";
  const typeGateIndex = prepack.indexOf("pnpm run check-types");
  const buildIndex = prepack.indexOf("pnpm run build");

  assert.notEqual(typeGateIndex, -1, "prepack must include the repository type gate");
  assert.notEqual(buildIndex, -1, "prepack must build package artifacts");
  assert.ok(typeGateIndex < buildIndex, "prepack must typecheck before building artifacts");
  assert.doesNotMatch(prepack, /\bnpm run build\b/, "prepack should use pnpm consistently");
});

test("release smoke coverage verifies build artifacts after the build", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const releaseSmoke = pkg.scripts?.["test:release-smoke"] ?? "";

  assert.match(releaseSmoke, /pnpm run build/);
  assert.match(releaseSmoke, /node scripts\/check-release-artifacts\.mjs/);

  const smokeScript = readFileSync(join(repoRoot, "scripts", "check-release-artifacts.mjs"), "utf8");
  assert.match(smokeScript, /"dist\/index\.js"/);
  assert.match(smokeScript, /"dist\/connectors\/codex-materialize-runner\.js"/);
  assert.match(smokeScript, /"dist\/admin-console\/public\/index\.html"/);
  assert.match(smokeScript, /"dist\/admin-console\/public\/app\.js"/);
  assert.match(smokeScript, /"openclaw\.plugin\.json"/);

  const ciWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciWorkflow, /pnpm run build\s*\n\s*\n\s*- name: Release artifact smoke test\s*\n\s*run: node scripts\/check-release-artifacts\.mjs/);

  const releaseWorkflow = readFileSync(
    join(repoRoot, ".github", "workflows", "release-and-publish.yml"),
    "utf8",
  );
  assert.match(releaseWorkflow, /pnpm run build\s*\n\s*node scripts\/check-release-artifacts\.mjs/);
  assert.match(releaseWorkflow, /pnpm -r run build\s*\n\s*pnpm run build\s*\n\s*\n\s*- name: Verify root release artifacts/);
  assert.match(releaseWorkflow, /- name: Verify root release artifacts\s*\n\s*run: node scripts\/check-release-artifacts\.mjs/);
});

test("release workflow updates lockfile after version mutations without frozen CI installs", () => {
  const releaseWorkflow = readFileSync(
    join(repoRoot, ".github", "workflows", "release-and-publish.yml"),
    "utf8",
  );
  const lockfileOnlyInstalls = releaseWorkflow.match(/pnpm install --lockfile-only[^\n]*/g) ?? [];

  assert.equal(lockfileOnlyInstalls.length, 4);
  for (const installCommand of lockfileOnlyInstalls) {
    assert.match(installCommand, /--no-frozen-lockfile/);
  }
});
