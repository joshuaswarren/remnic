import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngramAccessService, Orchestrator, log } from "@remnic/core";
import { runCli } from "./run-cli.js";

test("query --json keeps log.info off stdout so JSON.parse succeeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-json-logger-"));
  const configPath = path.join(root, "remnic.config.json");
  const memoryDir = path.join(root, "memory");
  await writeFile(configPath, JSON.stringify({ memoryDir }));

  const MARKER = "entity-migration progress must not corrupt json";
  t.mock.method(Orchestrator.prototype, "initialize", async () => {
    log.info(MARKER);
  });
  t.mock.method(Orchestrator.prototype, "abortDeferredInit", () => {});
  t.mock.method(Orchestrator.prototype, "destroy", async () => {});
  t.mock.method(EngramAccessService.prototype, "recall", async () => ({
    count: 0,
    results: [],
    memoryIds: [],
  }));

  try {
    const result = await runCli(["query", "signal:memory", "--json"], {
      cwd: root,
      env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
    });
    assert.equal(result.exitCode, 0, `exit ${result.exitCode}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.count, 0);
    assert.match(result.stderr, new RegExp(MARKER));
    assert.doesNotMatch(result.stdout, new RegExp(MARKER));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
