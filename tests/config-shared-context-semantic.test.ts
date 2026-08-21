import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig defaults shared cross-signal semantic settings", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.sharedCrossSignalSemanticEnabled, false);
  assert.equal(cfg.sharedCrossSignalSemanticTimeoutMs, 4000);
  assert.equal(cfg.sharedCrossSignalSemanticMaxCandidates, 120);
  assert.equal(cfg.crossSignalsSemanticEnabled, false);
  assert.equal(cfg.crossSignalsSemanticTimeoutMs, 4000);
});

test("parseConfig honors new sharedCrossSignalSemantic* flags", () => {
  const cfg = parseConfig({
    sharedCrossSignalSemanticEnabled: true,
    sharedCrossSignalSemanticTimeoutMs: 2500,
    sharedCrossSignalSemanticMaxCandidates: 42,
  });
  assert.equal(cfg.sharedCrossSignalSemanticEnabled, true);
  assert.equal(cfg.sharedCrossSignalSemanticTimeoutMs, 2500);
  assert.equal(cfg.sharedCrossSignalSemanticMaxCandidates, 42);
  assert.equal(cfg.crossSignalsSemanticEnabled, true);
  assert.equal(cfg.crossSignalsSemanticTimeoutMs, 2500);
});

test("parseConfig keeps backward compatibility with crossSignalsSemantic* flags", () => {
  const cfg = parseConfig({
    crossSignalsSemanticEnabled: true,
    crossSignalsSemanticTimeoutMs: 1800,
  });
  assert.equal(cfg.sharedCrossSignalSemanticEnabled, true);
  assert.equal(cfg.sharedCrossSignalSemanticTimeoutMs, 1800);
  assert.equal(cfg.crossSignalsSemanticEnabled, true);
  assert.equal(cfg.crossSignalsSemanticTimeoutMs, 1800);
});
