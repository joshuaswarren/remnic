import assert from "node:assert/strict";
import test from "node:test";

import { parseDashboardPort, readDashboardArg } from "../dashboard/server-args.js";

test("dashboard server entrypoint rejects malformed port arguments", () => {
  for (const raw of ["4319abc", "4319.9", "-1", "65536", "", " 4319"]) {
    assert.throws(
      () => parseDashboardPort(raw),
      /invalid --port:/,
      `port ${JSON.stringify(raw)} should be rejected`,
    );
  }
});

test("dashboard server entrypoint accepts valid port arguments", () => {
  assert.equal(parseDashboardPort("4319"), 4319);
  assert.equal(parseDashboardPort("0"), 0);
  assert.equal(parseDashboardPort(undefined), 4319);
});

test("dashboard server entrypoint rejects flags without values before applying defaults", () => {
  assert.throws(
    () => readDashboardArg(["node", "dashboard/server.js", "--port", "--host", "0.0.0.0"], "--port", "4319"),
    /missing --port/,
  );
  assert.throws(
    () => readDashboardArg(["node", "dashboard/server.js", "--host"], "--host", "127.0.0.1"),
    /missing --host/,
  );
  assert.throws(() => readDashboardArg(["node", "dashboard/server.js", "--token"], "--token"), /missing --token/);
});

test("dashboard server entrypoint reads provided flag values and defaults absent flags", () => {
  assert.equal(
    readDashboardArg(["node", "dashboard/server.js", "--port", "4320"], "--port", "4319"),
    "4320",
  );
  assert.equal(readDashboardArg(["node", "dashboard/server.js"], "--port", "4319"), "4319");
  assert.equal(readDashboardArg(["node", "dashboard/server.js"], "--token"), undefined);
});
