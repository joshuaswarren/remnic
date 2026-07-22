import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MEETING_APP_PATTERNS } from "./detect.js";
import { DEFAULT_MEETINGS_CONFIG, parseMeetingsConfig } from "./config.js";

test("absent config is the disabled default with shipped app patterns", () => {
  const cfg = parseMeetingsConfig(undefined);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.appPatterns, [...DEFAULT_MEETING_APP_PATTERNS]);
  assert.equal(cfg.minOverlapMinutes, DEFAULT_MEETINGS_CONFIG.minOverlapMinutes);
  assert.equal(cfg.maxContextChars, 4000);
});

test("appPatterns are additive over the shipped defaults and de-duplicated", () => {
  const cfg = parseMeetingsConfig({ appPatterns: ["Around", "Zoom"] });
  for (const shipped of DEFAULT_MEETING_APP_PATTERNS) assert.ok(cfg.appPatterns.includes(shipped));
  assert.ok(cfg.appPatterns.includes("Around"));
  // "Zoom" is already shipped — no duplicate.
  assert.equal(cfg.appPatterns.filter((p) => p === "Zoom").length, 1);
});

test("boolean-like strings coerce for enabled", () => {
  assert.equal(parseMeetingsConfig({ enabled: "true" }).enabled, true);
  assert.equal(parseMeetingsConfig({ enabled: "0" }).enabled, false);
});

test("invalid values reject loudly", () => {
  assert.throws(() => parseMeetingsConfig({ enabled: "maybe" }), /boolean-like/);
  assert.throws(() => parseMeetingsConfig({ minOverlapMinutes: -1 }), /between 0 and 1440/);
  assert.throws(() => parseMeetingsConfig({ audioOnlyMinMinutes: 0 }), /between 1 and 1440/);
  assert.throws(() => parseMeetingsConfig({ contextDwellSeconds: 1.5 }), /between 0 and 86400/);
  assert.throws(() => parseMeetingsConfig({ appPatterns: [""] }), /non-empty strings/);
  assert.throws(() => parseMeetingsConfig({ appPatterns: "Zoom" }), /must be an array/);
  assert.throws(() => parseMeetingsConfig([]), /must be an object/);
});

test("numeric knobs coerce CLI string values", () => {
  const cfg = parseMeetingsConfig({ minOverlapMinutes: "5", contextDwellSeconds: "45" });
  assert.equal(cfg.minOverlapMinutes, 5);
  assert.equal(cfg.contextDwellSeconds, 45);
});
