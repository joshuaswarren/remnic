import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { runCompatCliCommand } from "../src/cli.js";

async function writeHealthyFixture(baseDir: string): Promise<void> {
  await mkdir(path.join(baseDir, "src"), { recursive: true });
  await writeFile(
    path.join(baseDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "openclaw-engram", kind: "memory" }),
    "utf-8",
  );
  await writeFile(
    path.join(baseDir, "package.json"),
    JSON.stringify({
      engines: { node: ">=22.12.0" },
      openclaw: {
        plugin: "./openclaw.plugin.json",
        extensions: ["./dist/index.js"],
      },
    }),
    "utf-8",
  );
  await writeFile(
    path.join(baseDir, "src", "index.ts"),
    [
      'api.on("before_prompt_build", async () => {});',
      'api.on("agent_end", async () => {});',
      "registerCli(api as unknown as Foo, orchestrator);",
      "api.registerService({ id: \"openclaw-engram\", start: async () => {}, stop: () => {} });",
    ].join("\n"),
    "utf-8",
  );
}

test("runCompatCliCommand returns zero exit code by default", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-cli-compat-ok-"));
  await writeHealthyFixture(repoRoot);

  const result = await runCompatCliCommand({
    repoRoot,
    runner: { commandExists: async () => false },
  });

  assert.equal(result.report.summary.warn > 0, true);
  assert.equal(result.exitCode, 0);
});

test("runCompatCliCommand strict mode fails on warnings", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-cli-compat-strict-warn-"));
  await writeHealthyFixture(repoRoot);

  const result = await runCompatCliCommand({
    repoRoot,
    strict: true,
    runner: { commandExists: async () => false },
  });

  assert.equal(result.report.summary.warn > 0, true);
  assert.equal(result.exitCode, 1);
});

test("runCompatCliCommand strict mode fails on errors", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "engram-cli-compat-strict-error-"));
  await mkdir(path.join(repoRoot, "src"), { recursive: true });
  await writeFile(path.join(repoRoot, "openclaw.plugin.json"), "{}", "utf-8");
  await writeFile(path.join(repoRoot, "package.json"), "{}", "utf-8");
  await writeFile(path.join(repoRoot, "src", "index.ts"), "", "utf-8");

  const result = await runCompatCliCommand({
    repoRoot,
    strict: true,
    runner: { commandExists: async () => true },
  });

  assert.equal(result.report.summary.error > 0, true);
  assert.equal(result.exitCode, 1);
});
