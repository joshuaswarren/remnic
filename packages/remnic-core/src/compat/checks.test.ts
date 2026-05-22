import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCompatChecks } from "./checks.js";
import type { CompatCheckResult } from "./types.js";

async function writeCompatFixture(options: {
  enginesNode: string;
  indexSource?: string;
}): Promise<string> {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-compat-"));
  await writeFile(
    path.join(repoRoot, "openclaw.plugin.json"),
    JSON.stringify({ id: "openclaw-remnic", kind: "memory" }),
  );
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({
      engines: { node: options.enginesNode },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
  );
  await mkdir(path.join(repoRoot, "src"));
  await writeFile(
    path.join(repoRoot, "src", "index.ts"),
    options.indexSource ?? [
      "api.on('before_prompt_build', async () => {});",
      "api.on('agent_end', async () => {});",
      "api.registerService({ start: async () => {} });",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  );
  return repoRoot;
}

async function runFixture(options: {
  enginesNode: string;
  currentNodeVersion: string;
  indexSource?: string;
}): Promise<CompatCheckResult[]> {
  const repoRoot = await writeCompatFixture(options);
  try {
    const report = await runCompatChecks({
      repoRoot,
      currentNodeVersion: options.currentNodeVersion,
      runner: { commandExists: async () => false },
      now: new Date("2026-05-20T00:00:00.000Z"),
    });
    return report.checks;
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
}

function checkById(
  checks: readonly CompatCheckResult[],
  id: string,
): CompatCheckResult {
  const check = checks.find((candidate) => candidate.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

test("node engine compatibility rejects versions above an exclusive upper bound", async () => {
  const checks = await runFixture({
    enginesNode: ">=20.0.0 <23.0.0",
    currentNodeVersion: "v24.0.0",
  });

  const nodeCheck = checkById(checks, "node-version-compat");
  assert.equal(nodeCheck.level, "error");
  assert.match(nodeCheck.message, /does not satisfy/);
});

test("node engine compatibility honors disjunctions and caret ranges", async () => {
  const checks = await runFixture({
    enginesNode: "^20.0.0 || >=22.12.0",
    currentNodeVersion: "v22.12.0",
  });

  const nodeCheck = checkById(checks, "node-version-compat");
  assert.equal(nodeCheck.level, "ok");
});

test("node engine compatibility expands wildcard comparator ranges", async () => {
  const lteChecks = await runFixture({
    enginesNode: "<=22.x",
    currentNodeVersion: "v22.5.0",
  });
  assert.equal(checkById(lteChecks, "node-version-compat").level, "ok");

  const gtChecks = await runFixture({
    enginesNode: ">22.x",
    currentNodeVersion: "v22.5.0",
  });
  assert.equal(checkById(gtChecks, "node-version-compat").level, "error");
});

test("node engine compatibility keeps spaced comparator operators with versions", async () => {
  const checks = await runFixture({
    enginesNode: ">= 22.12.0",
    currentNodeVersion: "v22.12.0",
  });

  assert.equal(checkById(checks, "node-version-compat").level, "ok");
});

test("node engine compatibility honors hyphen ranges", async () => {
  const checks = await runFixture({
    enginesNode: "22.12.0 - 23.0.0",
    currentNodeVersion: "v23.0.0",
  });

  assert.equal(checkById(checks, "node-version-compat").level, "ok");
});

test("node engine compatibility expands zero-major partial caret ranges", async () => {
  const checks = await runFixture({
    enginesNode: "^0",
    currentNodeVersion: "v0.5.0",
  });

  assert.equal(checkById(checks, "node-version-compat").level, "ok");
});

test("node engine compatibility reports version mismatch when any disjunct is valid", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0 || unsupported-range",
    currentNodeVersion: "v20.0.0",
  });

  const nodeCheck = checkById(checks, "node-version-compat");
  assert.equal(nodeCheck.level, "error");
  assert.match(nodeCheck.message, /does not satisfy/);
});

test("memory prompt section registration must be on the plugin api object", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('agent_end', async () => {});",
      "api.registerService({ start: async () => {} });",
      "someOtherObject.registerMemoryPromptSection(() => null);",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "error");
  assert.match(hookCheck.message, /before_prompt_build|before_agent_start/);
});

test("memory prompt section registration on api satisfies recall hook requirement", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('agent_end', async () => {});",
      "api.registerService({ start: async () => {} });",
      "api.registerMemoryPromptSection(() => null);",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "ok");
});

test("service start detection ignores nested start properties", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('before_prompt_build', async () => {});",
      "api.on('agent_end', async () => {});",
      "api.registerService({ id: 'x', stop() {}, metadata: { start: false } });",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "error");
  assert.match(hookCheck.message, /startup wiring/);
});

test("service start detection accepts top-level start methods", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('before_prompt_build', async () => {});",
      "api.on('agent_end', async () => {});",
      "api.registerService({ id: 'x', stop() {}, metadata: { start: false }, start() {} });",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "ok");
});

test("memory prompt section registration accepts casted api receivers", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('agent_end', async () => {});",
      "api.registerService({ start: async () => {} });",
      "(api as any).registerMemoryPromptSection(() => null);",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "ok");
});

test("memory prompt section registration accepts optional chaining on api", async () => {
  const checks = await runFixture({
    enginesNode: ">=22.12.0",
    currentNodeVersion: "v22.12.0",
    indexSource: [
      "api.on('agent_end', async () => {});",
      "api.registerService({ start: async () => {} });",
      "api?.registerMemoryPromptSection?.(() => null);",
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const hookCheck = checkById(checks, "hook-registration-core");
  assert.equal(hookCheck.level, "ok");
});
