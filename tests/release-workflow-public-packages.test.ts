import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Topological publish order: core first, then the à-la-carte companion
// packages (bench, importer/exporter family, connector-replit) that install
// surfaces depend on, then the depend-on-core runtimes and plugin bundles.
// Packages that the CLI depends on, such as plugin-pi, must publish before
// remnic-cli. The legacy shim lives at the tail. Keep in sync with PUBLISH_ORDER in
// .github/workflows/release-and-publish.yml and AGENTS.md §44.
const expectedPublishDirs = [
  "packages/remnic-core",
  "packages/bench",
  "packages/export-weclone",
  "packages/import-weclone",
  "packages/import-chatgpt",
  "packages/import-claude",
  "packages/import-gemini",
  "packages/import-mem0",
  "packages/import-lossless-claw",
  "packages/import-supermemory",
  "packages/connector-weclone",
  "packages/connector-replit",
  "packages/hermes-provider",
  "packages/remnic-server",
  "packages/plugin-pi",
  "packages/remnic-cli",
  "packages/plugin-openclaw",
  "packages/plugin-claude-code",
  "packages/plugin-codex",
  "packages/shim-openclaw-engram",
] as const;

test("release workflow publish order matches the supported npm install surfaces", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const publishOrderMatch = workflow.match(/PUBLISH_ORDER=\(\s*([\s\S]*?)\s*\)/);
  assert.ok(publishOrderMatch, "release workflow must define PUBLISH_ORDER");
  const publishDirs = [...publishOrderMatch[1].matchAll(/packages\/[A-Za-z0-9_-]+/g)].map((match) => match[0]);

  assert.deepEqual(publishDirs, [...expectedPublishDirs]);

  for (const pkgDir of expectedPublishDirs) {
    assert.match(
      workflow,
      new RegExp(`\\b${pkgDir.replace("/", "\\/")}\\b`),
      `release-and-publish.yml must publish ${pkgDir}`,
    );
  }
});

test("release workflow verifies the OpenClaw ClawHub packlist after build", async () => {
  const workflow = await readFile(".github/workflows/release-and-publish.yml", "utf8");
  const verifyScript = await readFile("scripts/verify-openclaw-clawpack.mjs", "utf8");

  assert.match(
    workflow,
    /Build all packages[\s\S]*Verify OpenClaw ClawHub artifact packlist[\s\S]*Publish root package to npm/,
    "release workflow must verify the built OpenClaw package before any publish step",
  );
  assert.match(
    workflow,
    /pnpm run verify:openclaw-clawpack/,
    "release workflow must call the OpenClaw ClawPack verifier",
  );
  assert.match(
    verifyScript,
    /dist\/index\.js/,
    "ClawPack verifier must require the OpenClaw runtime entrypoint",
  );
  assert.match(
    verifyScript,
    /packageJson\.openclaw\?\.extensions/,
    "ClawPack verifier must check every declared OpenClaw extension",
  );
  assert.match(
    verifyScript,
    /packageJson\.openclaw\?\.runtimeExtensions/,
    "ClawPack verifier must check every declared OpenClaw runtime extension",
  );
});

test("OpenClaw security scan wrapper handles minified scanner exports", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-openclaw-scan-"));
  try {
    const openclawDir = path.join(tempDir, "openclaw");
    const openclawDistDir = path.join(openclawDir, "dist");
    const pluginDir = path.join(tempDir, "plugin");
    await mkdir(openclawDistDir, { recursive: true });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(openclawDir, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.5.12-beta.4", type: "module" }),
    );
    await writeFile(
      path.join(openclawDistDir, "skill-scanner-fake.js"),
      [
        "function clearSkillScanCacheForTest() {}",
        "async function scanDirectoryWithSummary(dirPath) {",
        "  return { scannedFiles: 1, critical: 0, warn: 0, findings: [] };",
        "}",
        "export { scanDirectoryWithSummary as i, clearSkillScanCacheForTest as t };",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      ["scripts/openclaw-plugin-security-scan.mjs", pluginDir],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_PACKAGE_DIR: openclawDir },
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OpenClaw 2026\.5\.12-beta\.4 scanner:/);
    assert.match(result.stdout, /scanned=1 critical=0 warn=0/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
