import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngramAccessService, Orchestrator, initLogger, log } from "@remnic/core";
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

const INSECURE_HTTP_WARNING = /openaiBaseUrl from config is using insecure http/;

/** A fresh `remnic` process starts with a no-op logger; earlier tests in this process installed a real one. */
const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

async function runBriefingWithInsecureConfig(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-logger-"));
  const configPath = path.join(root, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ memoryDir: path.join(root, "memory"), openaiBaseUrl: "http://example.invalid/v1" }));
  initLogger(SILENT_LOGGER);
  try {
    return await runCli(["briefing", ...args], {
      cwd: root,
      env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("briefing keeps config warnings when the format flag is rejected", async () => {
  const result = await runBriefingWithInsecureConfig(["--format", "bogus"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, INSECURE_HTTP_WARNING);
  assert.match(result.stderr, /Invalid --format value/);
});

test("briefing --json keeps config warnings on stderr", async () => {
  const result = await runBriefingWithInsecureConfig(["--json", "--since", "bogus"]);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, INSECURE_HTTP_WARNING);
  assert.doesNotMatch(result.stdout, INSECURE_HTTP_WARNING);
});

test("xray --format json keeps log.info off stdout so JSON.parse succeeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-xray-json-logger-"));
  const configPath = path.join(root, "remnic.config.json");
  const memoryDir = path.join(root, "memory");
  await writeFile(configPath, JSON.stringify({ memoryDir }));

  const MARKER = "xray orchestrator init must not corrupt json";
  t.mock.method(Orchestrator.prototype, "initialize", async () => {
    log.info(MARKER);
  });
  t.mock.method(Orchestrator.prototype, "abortDeferredInit", () => {});
  t.mock.method(Orchestrator.prototype, "destroy", async () => {});
  t.mock.method(EngramAccessService.prototype, "recallXray", async () => ({
    snapshotFound: false,
  }));

  try {
    const result = await runCli(["xray", "signal:memory", "--format", "json"], {
      cwd: root,
      env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
    });
    assert.equal(result.exitCode, 0, `exit ${result.exitCode}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.snapshotFound, false);
    assert.match(result.stderr, new RegExp(MARKER));
    assert.doesNotMatch(result.stdout, new RegExp(MARKER));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("why --format json keeps log.info off stdout so JSON.parse succeeds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-why-json-logger-"));
  const configPath = path.join(root, "remnic.config.json");
  const memoryDir = path.join(root, "memory");
  await writeFile(configPath, JSON.stringify({ memoryDir }));

  const MARKER = "why orchestrator init must not corrupt json";
  t.mock.method(Orchestrator.prototype, "initialize", async () => {
    log.info(MARKER);
  });
  t.mock.method(Orchestrator.prototype, "abortDeferredInit", () => {});
  t.mock.method(Orchestrator.prototype, "destroy", async () => {});
  t.mock.method(EngramAccessService.prototype, "recallWhy", async () => ({
    reportFound: true,
    report: {
      schemaVersion: "1",
      query: "signal:memory",
      plannerMode: "full",
      ok: true,
      recallNamespaces: [],
      appliedResultLimit: 0,
      stages: [],
      recalledMemoryIds: [],
    },
  }));

  try {
    const result = await runCli(["why", "signal:memory", "--format", "json"], {
      cwd: root,
      env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
    });
    assert.equal(result.exitCode, 0, `exit ${result.exitCode}: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.query, "signal:memory");
    assert.match(result.stderr, new RegExp(MARKER));
    assert.doesNotMatch(result.stdout, new RegExp(MARKER));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
