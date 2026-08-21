import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

test("parseConfig applies recall timeout and qmd recall cache defaults", () => {
  const config = parseConfig({});

  assert.equal(config.recallOuterTimeoutMs, 75_000);
  assert.equal(config.recallCoreDeadlineMs, 75_000);
  assert.equal(config.recallEnrichmentDeadlineMs, 25_000);
  assert.equal(config.qmdRecallCacheTtlMs, 60_000);
  assert.equal(config.qmdRecallCacheStaleTtlMs, 10 * 60_000);
  assert.equal(config.qmdRecallCacheMaxEntries, 128);
});

test("parseConfig applies the default profile share cap", () => {
  assert.equal(parseConfig({}).recallProfileMaxRatio, 0.3);
});

test("parseConfig accepts a configurable profile share cap", () => {
  assert.equal(
    parseConfig({ recallProfileMaxRatio: 0.5 }).recallProfileMaxRatio,
    0.5,
  );
});

test("parseConfig preserves profile share cap boundaries", () => {
  assert.equal(parseConfig({ recallProfileMaxRatio: 0 }).recallProfileMaxRatio, 0);
  assert.equal(parseConfig({ recallProfileMaxRatio: 1 }).recallProfileMaxRatio, 1);
});

test("parseConfig rejects an explicit null profile share cap", () => {
  assert.throws(
    () => parseConfig({ recallProfileMaxRatio: null }),
    /recallProfileMaxRatio must be a finite number in \[0, 1\]/,
  );
});

test("parseConfig rejects an invalid profile share cap", () => {
  assert.throws(
    () => parseConfig({ recallProfileMaxRatio: 1.1 }),
    /recallProfileMaxRatio must be a finite number in \[0, 1\]/,
  );
});

test("parseConfig respects explicit recall timeout and qmd recall cache settings", () => {
  const config = parseConfig({
    recallOuterTimeoutMs: 18_000,
    recallCoreDeadlineMs: 9_000,
    recallEnrichmentDeadlineMs: 2_500,
    qmdRecallCacheTtlMs: 5_000,
    qmdRecallCacheStaleTtlMs: 45_000,
    qmdRecallCacheMaxEntries: 32,
  });

  assert.equal(config.recallOuterTimeoutMs, 18_000);
  assert.equal(config.recallCoreDeadlineMs, 9_000);
  assert.equal(config.recallEnrichmentDeadlineMs, 2_500);
  assert.equal(config.qmdRecallCacheTtlMs, 5_000);
  assert.equal(config.qmdRecallCacheStaleTtlMs, 45_000);
  assert.equal(config.qmdRecallCacheMaxEntries, 32);
});

test("parseConfig preserves zero qmd recall cache entries to disable caching", () => {
  const config = parseConfig({
    qmdRecallCacheMaxEntries: 0,
  });

  assert.equal(config.qmdRecallCacheMaxEntries, 0);
});

test("parseConfig preserves zero recall timeout settings to disable those limits", () => {
  const config = parseConfig({
    recallOuterTimeoutMs: 0,
    recallCoreDeadlineMs: 0,
    recallEnrichmentDeadlineMs: 0,
  });

  assert.equal(config.recallOuterTimeoutMs, 0);
  assert.equal(config.recallCoreDeadlineMs, 0);
  assert.equal(config.recallEnrichmentDeadlineMs, 0);
});

test("parseConfig applies MMR defaults (enabled, lambda=0.7, topN=40)", () => {
  const config = parseConfig({});
  assert.equal(config.recallMmrEnabled, true);
  assert.equal(config.recallMmrLambda, 0.7);
  assert.equal(config.recallMmrTopN, 40);
});

test("parseConfig honors explicit MMR overrides", () => {
  const config = parseConfig({
    recallMmrEnabled: false,
    recallMmrLambda: 0.3,
    recallMmrTopN: 25,
  });
  assert.equal(config.recallMmrEnabled, false);
  assert.equal(config.recallMmrLambda, 0.3);
  assert.equal(config.recallMmrTopN, 25);
});

test("parseConfig clamps MMR lambda into [0, 1]", () => {
  const tooLow = parseConfig({ recallMmrLambda: -0.5 });
  assert.equal(tooLow.recallMmrLambda, 0);
  const tooHigh = parseConfig({ recallMmrLambda: 1.7 });
  assert.equal(tooHigh.recallMmrLambda, 1);
});

test("parseConfig preserves recallMmrTopN=0 as a true zero limit", () => {
  // AGENTS.md §4 ("Config is runtime API"): `0` limits are compatibility
  // guarantees. The write-time representation of `recallMmrTopN=0` must be
  // preserved, and the read-time behavior in applyMmrToQmdResults must
  // honor the zero limit by skipping MMR entirely (see orchestrator.ts).
  const config = parseConfig({ recallMmrTopN: 0 });
  assert.equal(config.recallMmrTopN, 0);
});
