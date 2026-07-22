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

test("parseActivityConfig enforces both ends of the syncDays range", () => {
  assert.equal(parseActivityConfig({ syncDays: 90 }).syncDays, 90);
  assert.equal(parseActivityConfig({ syncDays: 1 }).syncDays, 1);
  assert.throws(() => parseActivityConfig({ syncDays: 91 }), /syncDays must be an integer from 1 to 90/);
  assert.throws(() => parseActivityConfig({ syncDays: 0 }), /syncDays must be an integer from 1 to 90/);
});

test("parseActivityConfig rejects an invalid IANA timezone at parse time", () => {
  assert.throws(() => parseActivityConfig({ timezone: "Not/AZone" }), /Invalid IANA timezone/);
});

test("parseActivityConfig rejects a whitespace-only machineLabel before any sync", () => {
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "   ", baseUrl: "http://127.0.0.1:4319" }] }),
    /machineLabel must not be blank/,
  );
});

test("parseActivityConfig rejects duplicate machine labels that would share a cursor", () => {
  assert.throws(
    () =>
      parseActivityConfig({
        enabled: true,
        sources: [
          { machineLabel: "dup", baseUrl: "http://127.0.0.1:4319" },
          { machineLabel: "dup", baseUrl: "http://127.0.0.1:4320" },
        ],
      }),
    /machineLabel must be unique/,
  );
});

test("parseActivityConfig reports a malformed baseUrl with a prefixed validation error", () => {
  assert.throws(
    () => parseActivityConfig({ enabled: true, sources: [{ machineLabel: "fixture", baseUrl: "not a url" }] }),
    /activity source baseUrl must be a valid URL/,
  );
});
