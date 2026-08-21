import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("profiling defaults to disabled", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.profilingEnabled, false);
});

test("profiling can be enabled via config", () => {
  const cfg = parseConfig({ profilingEnabled: true });
  assert.equal(cfg.profilingEnabled, true);
});

test("profiling storage dir defaults to memoryDir/profiling", () => {
  const cfg = parseConfig({ profilingEnabled: true });
  assert.ok(cfg.profilingStorageDir?.endsWith("/profiling"), `got: ${cfg.profilingStorageDir}`);
});

test("profiling max traces defaults to 100", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.profilingMaxTraces, 100);
});

test("profiling max traces can be overridden", () => {
  const cfg = parseConfig({ profilingMaxTraces: 50 });
  assert.equal(cfg.profilingMaxTraces, 50);
});
