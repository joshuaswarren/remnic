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

test("summary mode defaults to smart and rejects unknown values", () => {
  assert.equal(parseMeetingsConfig(undefined).summaryMode, "smart");
  assert.equal(parseMeetingsConfig({ summaryMode: "off" }).summaryMode, "off");
  assert.equal(parseMeetingsConfig({ summaryMode: "review" }).summaryMode, "review");
  assert.throws(() => parseMeetingsConfig({ summaryMode: "loud" }), /off, review, smart/);
});

test("trust knobs default and reject out-of-range values", () => {
  const cfg = parseMeetingsConfig(undefined);
  assert.equal(cfg.sourceTrust, 0.85);
  assert.equal(cfg.autoApproveTrust, 0.7);
  assert.equal(cfg.reviewTrust, 0.45);
  assert.equal(parseMeetingsConfig({ sourceTrust: 0.5 }).sourceTrust, 0.5);
  assert.throws(() => parseMeetingsConfig({ sourceTrust: 1.5 }), /in \[0, 1\]/);
  assert.throws(() => parseMeetingsConfig({ reviewTrust: -0.1 }), /in \[0, 1\]/);
  assert.equal(parseMeetingsConfig({ autoApproveTrust: "0.9" }).autoApproveTrust, 0.9);
});

test("finding 5 — inverted trust thresholds (autoApprove < review) are rejected", () => {
  assert.throws(
    () => parseMeetingsConfig({ autoApproveTrust: 0.4, reviewTrust: 0.6 }),
    /autoApproveTrust .* must be >= meetings\.reviewTrust/,
  );
  // Equal thresholds are allowed (auto-approve band coincides with review bar).
  assert.equal(parseMeetingsConfig({ autoApproveTrust: 0.5, reviewTrust: 0.5 }).autoApproveTrust, 0.5);
  // A default reviewTrust (0.45) with a lowered autoApproveTrust below it is
  // still caught (the override interacts with the default).
  assert.throws(() => parseMeetingsConfig({ autoApproveTrust: 0.3 }), /must be >= meetings\.reviewTrust/);
});
