import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultDaemonConfig, parseDaemonConfig, serializeDaemonConfig } from "./config.js";
import { CaptureConfigError } from "./errors.js";

test("defaults are the documented à-la-carte knobs", () => {
  const cfg = defaultDaemonConfig();
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.port, 4341);
  assert.equal(cfg.spoolRetentionDays, 14);
  assert.equal(cfg.simhashThreshold, 10);
  assert.equal(cfg.dedupTtlSeconds, 60);
  assert.equal(cfg.maxNodes, 4000);
  assert.deepEqual(cfg.denyApps, []);
});

test("valid overrides parse; string-boolean-like numbers coerce at the boundary", () => {
  const cfg = parseDaemonConfig({
    port: "5000",
    spoolRetentionDays: 7,
    simhashThreshold: 4,
    denyApps: ["Foo*"],
    terminalApps: ["MyTerm"],
    redactionPatterns: ["\\bsecret\\b"],
  });
  assert.equal(cfg.port, 5000);
  assert.equal(cfg.spoolRetentionDays, 7);
  assert.equal(cfg.simhashThreshold, 4);
  assert.deepEqual(cfg.denyApps, ["Foo*"]);
  assert.deepEqual(cfg.terminalApps, ["MyTerm"]);
});

test("invalid values throw loudly (no silent defaulting)", () => {
  assert.throws(() => parseDaemonConfig({ port: 0 }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ port: 70000 }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ simhashThreshold: 65 }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ denyApps: "nope" }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig({ denyApps: [1, 2] }), CaptureConfigError);
  assert.throws(() => parseDaemonConfig("not an object"), CaptureConfigError);
});

test("serialize round-trips through parse", () => {
  const cfg = parseDaemonConfig({ port: 5001, denyTitles: ["*secret*"] });
  const reparsed = parseDaemonConfig(JSON.parse(serializeDaemonConfig(cfg)));
  assert.deepEqual(reparsed, cfg);
});
