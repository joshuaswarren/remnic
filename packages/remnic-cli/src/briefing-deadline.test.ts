import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Orchestrator } from "@remnic/core";
import { runCli } from "./run-cli.js";

// A stalled initializer must consume the same budget as the briefing body.
test("briefing exits with an explicit error when startup exhausts its deadline", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-briefing-deadline-"));
  const configPath = path.join(root, "remnic.config.json");
  await writeFile(configPath, JSON.stringify({ memoryDir: path.join(root, "memory"), briefing: { enabled: true } }));
  let signalStarted: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  let releaseInitialization: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  assert.ok(releaseInitialization);
  let storageCalls = 0;
  t.mock.method(Orchestrator.prototype, "initialize", async () => {
    signalStarted();
    await release;
  });
  t.mock.method(Orchestrator.prototype, "getStorage", async () => {
    storageCalls++;
    throw new Error("storage must not be requested after the deadline");
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const command = runCli(["briefing", "--json"], {
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
    assert.equal(settled, true, "startup must fail before the client gives up, without waiting for initialization");
    const result = await command;
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /briefing.*timed out/i);
    assert.equal(result.stdout.trim(), "", "a timeout is not an empty successful briefing");
    releaseInitialization();
    await setImmediate();
    assert.equal(storageCalls, 0, "late initialization must not continue to storage or briefing side effects");
  } finally {
    releaseInitialization();
    await command;
    t.mock.timers.reset();
    await rm(root, { recursive: true, force: true });
  }
});
