import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { runCompatChecks } from "@remnic/core/compat/checks";

async function writeRepoFixture(baseDir: string, options?: {
  pluginJson?: string;
  packageJson?: string;
  indexTs?: string;
}) {
  await mkdir(path.join(baseDir, "src"), { recursive: true });
  if (options?.pluginJson !== undefined) {
    await writeFile(path.join(baseDir, "openclaw.plugin.json"), options.pluginJson, "utf-8");
  }
  if (options?.packageJson !== undefined) {
    await writeFile(path.join(baseDir, "package.json"), options.packageJson, "utf-8");
  }
  if (options?.indexTs !== undefined) {
    await writeFile(path.join(baseDir, "src", "index.ts"), options.indexTs, "utf-8");
  }
}

test("compat checks report ok for valid fixture", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-ok-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    packageJson: JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    indexTs: [
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
      "registerCli(api as unknown as Foo, orchestrator);",
      "api.registerService({ id: \"openclaw-engram\", start: async () => {}, stop: () => {} });",
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
    now: new Date("2026-02-27T00:00:00.000Z"),
  });

  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.ok > 0, true);
  assert.equal(report.generatedAt, "2026-02-27T00:00:00.000Z");
});

test("compat checks report errors for missing/invalid core files", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-bad-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: "{not-json",
    packageJson: JSON.stringify({
      engines: { node: ">=99.0.0" },
      openclaw: {
        plugin: "./bad.json",
        extensions: [],
      },
    }),
    indexTs: 'api.on("gateway_start", async () => {});',
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => false },
  });

  assert.equal(report.summary.error > 0, true);
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("plugin-manifest-shape")?.level, "error");
  assert.equal(byId.get("package-openclaw-exports")?.level, "error");
  assert.equal(byId.get("hook-registration-core")?.level, "error");
  assert.equal(byId.get("qmd-binary-availability")?.level, "warn");
});

test("compat checks fail when package.json is missing", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-missing-package-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    indexTs: [
      'api.on("gateway_start", async () => {});',
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("package-json-present")?.level, "error");
  assert.equal(byId.get("plugin-manifest-present")?.level, "ok");
});

test("compat checks treat empty manifest and package files as invalid", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-empty-files-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: "",
    packageJson: "",
    indexTs: [
      'api.on("gateway_start", async () => {});',
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
      "registerCli(api, orchestrator);",
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("plugin-manifest-present")?.level, "ok");
  assert.equal(byId.get("plugin-manifest-shape")?.level, "error");
  assert.equal(byId.get("package-json-parse")?.level, "error");
});

test("compat checks ignore commented hook/startup/cli snippets", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-commented-snippets-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    packageJson: JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    indexTs: [
      '// api.on("before_prompt_build", async () => {});',
      '/* api.on("agent_end", async () => {}); */',
      '// api.registerService({ start: async () => {}, stop: () => {} });',
      'const sample = "registerCli(api, orchestrator)";',
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("hook-registration-core")?.level, "error");
  assert.equal(byId.get("cli-registration")?.level, "warn");
});

test("compat checks support method-style service start and enforce api.on boundary", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-boundary-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    packageJson: JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    indexTs: [
      'myapi.on("before_prompt_build", async () => {});',
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
      "registerCli(api as unknown as Foo, orchestrator);",
      "api.registerService({ id: \"openclaw-engram\", async start() {}, stop() {} });",
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("hook-registration-core")?.level, "ok");
});

test("compat checks accept before_prompt_build", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-new-hooks-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    packageJson: JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    indexTs: [
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
      "registerCli(api as unknown as Foo, orchestrator);",
      "api.registerService({ id: \"openclaw-engram\", start: async () => {}, stop: () => {} });",
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  assert.equal(report.summary.error, 0);
  assert.equal(report.summary.warn, 0);
  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("hook-registration-core")?.level, "ok");
});

test("compat checks report error when before_prompt_build is not registered", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-compat-no-recall-hook-"));
  await writeRepoFixture(repoRoot, {
    pluginJson: JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    packageJson: JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    indexTs: [
      'api.on("agent_end", async () => {});',
      "api.registerService({ id: \"openclaw-engram\", start: async () => {}, stop: () => {} });",
    ].join("\n"),
  });

  const report = await runCompatChecks({
    repoRoot,
    runner: { commandExists: async () => true },
  });

  const byId = new Map(report.checks.map((check) => [check.id, check]));
  assert.equal(byId.get("hook-registration-core")?.level, "error");
  assert.ok(byId.get("hook-registration-core")?.remediation?.includes("before_prompt_build"));
});
