import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { EngramAccessService, Orchestrator } from "@remnic/core";
import { runCli } from "./run-cli.js";

test("query exits with a bounded JSON error when startup never resolves", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-query-deadline-"));
  const configPath = path.join(root, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ memoryDir: path.join(root, "memory") }));
  let signalStarted: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let releaseInitialization: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  assert.ok(releaseInitialization);
  let recallCalls = 0;
  t.mock.method(Orchestrator.prototype, "initialize", async () => {
    signalStarted();
    await release;
  });
  t.mock.method(EngramAccessService.prototype, "recall", async () => {
    recallCalls++;
    throw new Error("recall must not be requested after the deadline");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const command = runCli(["query", "--json", "known fact"], {
    cwd: root,
    env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
  });
  let settled = false;
  void command.then(() => {
    settled = true;
  });
  try {
    await started;
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(settled, true, "query must fail at the deadline instead of hanging on startup");
    const result = await command;
    assert.equal(result.exitCode, 1);
    // The last stderr line is the JSON error; earlier lines are logger notices.
    const errorLine = result.stderr.trim().split("\n").at(-1) ?? "";
    // SAFETY: the deadline error path writes one JSON object with an error string on stderr.
    const parsed = JSON.parse(errorLine) as { error: string };
    assert.match(parsed.error, /query timed out/i);
    assert.equal(result.stdout.trim(), "", "a timeout is not a valid query result");
    releaseInitialization();
    await setImmediate();
    assert.equal(recallCalls, 0, "late initialization must not continue to recall");
  } finally {
    releaseInitialization();
    await command;
    t.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  }
});

test("a fast query still prints its recall result unchanged", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-query-fast-"));
  const configPath = path.join(root, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ memoryDir: path.join(root, "memory") }));
  const recallResult = {
    query: "known fact",
    namespace: "default",
    context: "known fact",
    count: 1,
    memoryIds: ["m1"],
    results: [
      { id: "m1", path: "facts/m1.md", category: "fact", status: "active", tags: [], preview: "known fact" },
    ],
  };
  t.mock.method(Orchestrator.prototype, "initialize", async () => {});
  t.mock.method(EngramAccessService.prototype, "recall", async () => recallResult);
  try {
    const result = await runCli(["query", "--json", "known fact"], {
      cwd: root,
      env: { HOME: root, REMNIC_CONFIG_PATH: configPath },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, `${JSON.stringify(recallResult, null, 2)}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
