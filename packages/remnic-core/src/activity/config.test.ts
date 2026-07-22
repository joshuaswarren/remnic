import assert from "node:assert/strict";
import test from "node:test";

import { parseActivityConfig } from "./config.js";

test("parseActivityConfig defaults to an inert configuration", () => {
  assert.deepEqual(parseActivityConfig(undefined), {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    sources: [],
  });
});

test("parseActivityConfig treats a string false gate as disabled", () => {
  assert.equal(parseActivityConfig({ enabled: "false" }).enabled, false);
});

test("parseActivityConfig preserves explicit source settings", () => {
  assert.deepEqual(
    parseActivityConfig({
      enabled: true,
      timezone: "America/Chicago",
      syncDays: 3,
      sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319", token: "fixture-token" }],
    }),
    {
      enabled: true,
      timezone: "America/Chicago",
      syncDays: 3,
      sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319", token: "fixture-token" }],
    },
  );
});

test("parseActivityConfig rejects enabled configurations without valid source definitions", () => {
  assert.throws(() => parseActivityConfig({ enabled: true, sources: [] }), /at least one source/);
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "fixture", baseUrl: "ftp://example.test" }] }),
    /HTTP or HTTPS/,
  );
  assert.throws(() => parseActivityConfig({ syncDays: 0 }), /syncDays/);
});
