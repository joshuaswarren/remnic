import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Topological publish order: core first, then the à-la-carte companion
// packages (bench, importer/exporter family, connector-replit) that install
// surfaces depend on, then the depend-on-core runtimes (server, CLI) and
// plugin bundles (openclaw + per-agent plugins), and finally the legacy
// shim that lives at the tail. Keep in sync with PUBLISH_ORDER in
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
});
