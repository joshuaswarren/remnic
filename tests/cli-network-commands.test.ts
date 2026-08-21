import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  runTailscaleStatusCliCommand,
  runTailscaleSyncCliCommand,
  runWebDavServeCliCommand,
  runWebDavStopCliCommand,
} from "../src/cli.js";

test("tailscale-status CLI wrapper returns helper status", async () => {
  const status = await runTailscaleStatusCliCommand({
    helper: {
      async status() {
        return {
          available: true,
          running: true,
          backendState: "Running",
          version: "1.80.0",
          selfHostname: "engram-node",
          selfIp: "100.90.10.20",
        };
      },
      async syncDirectory() {
        throw new Error("not used");
      },
    },
  });

  assert.equal(status.available, true);
  assert.equal(status.running, true);
  assert.equal(status.selfHostname, "engram-node");
});

test("tailscale-sync CLI wrapper passes options through", async () => {
  const calls: Array<{
    sourceDir: string;
    destination: string;
    delete?: boolean;
    dryRun?: boolean;
    extraArgs?: string[];
  }> = [];

  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "engram-cli-ts-sync-"));

  const result = await runTailscaleSyncCliCommand({
    sourceDir,
    destination: "peer:/srv/engram",
    delete: true,
    dryRun: true,
    extraArgs: ["--numeric-ids"],
    helper: {
      async status() {
        return { available: true, running: true };
      },
      async syncDirectory(options) {
        calls.push(options);
      },
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    sourceDir,
    destination: "peer:/srv/engram",
    delete: true,
    dryRun: true,
    extraArgs: ["--numeric-ids"],
  });
});

test("webdav serve/stop CLI wrappers manage server lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-"));

  const started = await runWebDavServeCliCommand({
    host: "127.0.0.1",
    port: 0,
    allowlistDirs: [root],
  });

  assert.equal(started.running, true);
  assert.equal(started.rootCount, 1);
  assert.ok(started.port > 0);

  const stopResult = await runWebDavStopCliCommand();
  assert.deepEqual(stopResult, { stopped: true });

  const stopAgain = await runWebDavStopCliCommand();
  assert.deepEqual(stopAgain, { stopped: false });
});

test("webdav serve wrapper requires both auth fields when either is set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-auth-"));

  await assert.rejects(
    () =>
      runWebDavServeCliCommand({
        allowlistDirs: [root],
        authUsername: "engram",
      }),
    /requires both username and password/i,
  );

  await assert.rejects(
    () =>
      runWebDavServeCliCommand({
        allowlistDirs: [root],
        authPassword: "secret",
      }),
    /requires both username and password/i,
  );

  await assert.rejects(
    () =>
      runWebDavServeCliCommand({
        allowlistDirs: [root],
        authUsername: "   ",
        authPassword: "   ",
      }),
    /must be non-empty/i,
  );
});

test("webdav serve serializes concurrent startups and reuses singleton", async () => {
  await runWebDavStopCliCommand();

  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-lock-"));
  let running = false;
  let createCount = 0;
  let startCount = 0;

  const createServer = async () => {
    createCount += 1;
    return {
      async start() {
        startCount += 1;
        await delay(25);
        running = true;
        return { running: true, host: "127.0.0.1", port: 9000, rootCount: 1 };
      },
      async stop() {
        running = false;
      },
      status() {
        return { running, host: "127.0.0.1", port: 9000, rootCount: 1 };
      },
    };
  };

  const [first, second] = await Promise.all([
    runWebDavServeCliCommand({ allowlistDirs: [root], createServer }),
    runWebDavServeCliCommand({ allowlistDirs: [root], createServer }),
  ]);

  assert.equal(createCount, 1);
  assert.equal(startCount, 1);
  assert.equal(first.running, true);
  assert.equal(second.running, true);

  const stopped = await runWebDavStopCliCommand();
  assert.deepEqual(stopped, { stopped: true });
});

test("webdav stop retains active handle when stop fails so retry can succeed", async () => {
  await runWebDavStopCliCommand();

  const root = await mkdtemp(path.join(os.tmpdir(), "engram-cli-webdav-stop-retry-"));
  let running = false;
  let stopCalls = 0;

  const createServer = async () => ({
    async start() {
      running = true;
      return { running: true, host: "127.0.0.1", port: 9001, rootCount: 1 };
    },
    async stop() {
      stopCalls += 1;
      if (stopCalls === 1) {
        throw new Error("close failed");
      }
      running = false;
    },
    status() {
      return { running, host: "127.0.0.1", port: 9001, rootCount: 1 };
    },
  });

  await runWebDavServeCliCommand({ allowlistDirs: [root], createServer });

  await assert.rejects(() => runWebDavStopCliCommand(), /close failed/i);

  const secondStop = await runWebDavStopCliCommand();
  assert.deepEqual(secondStop, { stopped: true });
  assert.equal(stopCalls, 2);
});
