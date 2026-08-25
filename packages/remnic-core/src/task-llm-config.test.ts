import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import { initLogger, resetLogger } from "./logger.js";
import { parseTaskLlmConfig, resetTaskLlmLegacyWarningsForTest } from "./task-llm-config.js";

function captureWarns(): string[] {
  const warns: string[] = [];
  initLogger(
    {
      info() {},
      warn(msg) {
        warns.push(msg);
      },
      error() {},
    },
    false,
    { timestamps: false },
  );
  return warns;
}

test("taskLlmTimeoutMs wins over legacy localLlmTimeoutMs", () => {
  resetTaskLlmLegacyWarningsForTest();
  const parsed = parseTaskLlmConfig({
    taskLlmTimeoutMs: 90_000,
    localLlmTimeoutMs: 12_000,
  });
  assert.equal(parsed.timeoutMs, 90_000);
  assert.equal(parsed.localTimeoutMs, 12_000);
});

test("taskLlmFallback wins over legacy localLlmFallback", () => {
  resetTaskLlmLegacyWarningsForTest();
  const parsed = parseTaskLlmConfig({
    taskLlmFallback: false,
    localLlmFallback: true,
  });
  assert.equal(parsed.fallback, false);
});

test("legacy localLlmTimeoutMs is read when taskLlmTimeoutMs is absent and warns once", () => {
  resetTaskLlmLegacyWarningsForTest();
  const warns = captureWarns();
  try {
    const first = parseTaskLlmConfig({ localLlmTimeoutMs: 45_000 });
    const second = parseTaskLlmConfig({ localLlmTimeoutMs: 45_000 });
    assert.equal(first.timeoutMs, 45_000);
    assert.equal(second.timeoutMs, 45_000);
    const legacyWarns = warns.filter((line) => line.includes("localLlmTimeoutMs is a legacy alias for taskLlmTimeoutMs"));
    assert.equal(legacyWarns.length, 1);
  } finally {
    resetLogger();
    resetTaskLlmLegacyWarningsForTest();
  }
});

test("legacy localLlmFallback is read when taskLlmFallback is absent and warns once", () => {
  resetTaskLlmLegacyWarningsForTest();
  const warns = captureWarns();
  try {
    const first = parseTaskLlmConfig({ localLlmFallback: false });
    const second = parseTaskLlmConfig({ localLlmFallback: false });
    assert.equal(first.fallback, false);
    assert.equal(second.fallback, false);
    const legacyWarns = warns.filter((line) => line.includes("localLlmFallback is a legacy alias for taskLlmFallback"));
    assert.equal(legacyWarns.length, 1);
  } finally {
    resetLogger();
    resetTaskLlmLegacyWarningsForTest();
  }
});

test("neither key uses defaults and does not warn", () => {
  resetTaskLlmLegacyWarningsForTest();
  const warns = captureWarns();
  try {
    const parsed = parseTaskLlmConfig({});
    assert.equal(parsed.timeoutMs, 180_000);
    assert.equal(parsed.localTimeoutMs, 180_000);
    assert.equal(parsed.fallback, true);
    assert.equal(warns.some((line) => line.includes("legacy alias")), false);
  } finally {
    resetLogger();
    resetTaskLlmLegacyWarningsForTest();
  }
});

test("present-with-undefined taskLlmTimeoutMs does not fall through to the legacy key", () => {
  resetTaskLlmLegacyWarningsForTest();
  const parsed = parseTaskLlmConfig({
    taskLlmTimeoutMs: undefined,
    localLlmTimeoutMs: 12_000,
  });
  assert.equal(parsed.timeoutMs, 180_000);
  assert.equal(parsed.localTimeoutMs, 12_000);
});

test("taskLlmFallback coerces string false", () => {
  resetTaskLlmLegacyWarningsForTest();
  const parsed = parseTaskLlmConfig({ taskLlmFallback: "false" });
  assert.equal(parsed.fallback, false);
});

test("parseConfig wires taskLlmTimeoutMs onto PluginConfig and keeps localLlmTimeoutMs independent", () => {
  resetTaskLlmLegacyWarningsForTest();
  const cfg = parseConfig({
    taskLlmTimeoutMs: 90_000,
    localLlmTimeoutMs: 12_000,
    taskLlmFallback: false,
  });
  assert.equal(cfg.taskLlmTimeoutMs, 90_000);
  assert.equal(cfg.localLlmTimeoutMs, 12_000);
  assert.equal(cfg.localLlmFallback, false);
  assert.equal(cfg.taskLlmFallback, false);
});

test("parseConfig legacy-only timeout still populates taskLlmTimeoutMs", () => {
  resetTaskLlmLegacyWarningsForTest();
  const cfg = parseConfig({ localLlmTimeoutMs: 600_000 });
  assert.equal(cfg.taskLlmTimeoutMs, 600_000);
  assert.equal(cfg.localLlmTimeoutMs, 600_000);
});
