import assert from "node:assert/strict";
import test from "node:test";

import { parseDashboardPort } from "../dashboard/server-args.js";

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
