import test from "node:test";
import assert from "node:assert/strict";
import {
  runDashboardStartCliCommand,
  runDashboardStatusCliCommand,
  runDashboardStopCliCommand,
} from "../src/cli.js";

test("dashboard CLI wrappers manage lifecycle", async () => {
  let running = false;
  const createServer = () => ({
    async start() {
      running = true;
      return {
        running: true,
        host: "127.0.0.1",
        port: 4319,
        watching: true,
        graphNodeCount: 2,
        graphEdgeCount: 1,
      };
    },
    async stop() {
      running = false;
    },
    status() {
      return {
        running,
        host: "127.0.0.1",
        port: 4319,
        watching: true,
        graphNodeCount: 2,
        graphEdgeCount: 1,
      };
    },
  });

  const start = await runDashboardStartCliCommand({
    memoryDir: "/tmp/engram",
    createServer,
  });
  assert.equal(start.running, true);

  const status = await runDashboardStatusCliCommand();
  assert.equal("running" in status ? status.running : false, true);

  const stop = await runDashboardStopCliCommand();
  assert.deepEqual(stop, { stopped: true });
});

test("dashboard CLI wrapper rejects invalid ports before creating a server", async () => {
  await runDashboardStopCliCommand();
  for (const port of [-1, 3.7, Number.NaN, Number.POSITIVE_INFINITY, 65536]) {
    let createCalled = false;
    await assert.rejects(
      () =>
        runDashboardStartCliCommand({
          memoryDir: "/tmp/engram",
          port,
          createServer: () => {
            createCalled = true;
            throw new Error("server should not be created");
          },
        }),
      /dashboard port must be an integer from 0 to 65535/,
      `port ${String(port)} should be rejected`,
    );
    assert.equal(createCalled, false, `port ${String(port)} should fail before createServer`);
  }
});

test("dashboard stop is idempotent when not running", async () => {
  await runDashboardStopCliCommand();
  const result = await runDashboardStopCliCommand();
  assert.deepEqual(result, { stopped: false });
});
