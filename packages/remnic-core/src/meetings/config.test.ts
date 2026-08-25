import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_MEETING_APP_PATTERNS } from "./detect.js";
import { parseConfig } from "../config.js";
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

test("fully-specified valid config round-trips unchanged through the canonical parser (#2936)", () => {
  const full = {
    enabled: true,
    appPatterns: ["CustomConf App"],
    minOverlapMinutes: 5,
    audioOnlyMinMinutes: 30,
    mergeGapMinutes: 7,
    contextDwellSeconds: 60,
    maxContextChars: 12_000,
    summaryMode: "review",
    sourceTrust: 0.9,
    autoApproveTrust: 0.8,
    reviewTrust: 0.6,
  };
  const cfg = parseMeetingsConfig(full);
  // Every knob must come back exactly as supplied — no re-normalization,
  // no silent defaulting of valid values.
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.appPatterns, [...DEFAULT_MEETING_APP_PATTERNS, "CustomConf App"]);
  assert.equal(cfg.minOverlapMinutes, 5);
  assert.equal(cfg.audioOnlyMinMinutes, 30);
  assert.equal(cfg.mergeGapMinutes, 7);
  assert.equal(cfg.contextDwellSeconds, 60);
  assert.equal(cfg.maxContextChars, 12_000);
  assert.equal(cfg.summaryMode, "review");
  assert.equal(cfg.sourceTrust, 0.9);
  assert.equal(cfg.autoApproveTrust, 0.8);
  assert.equal(cfg.reviewTrust, 0.6);
});

test("parseConfig routes meetings through exactly one canonical path — no silent aliases (#2936)", () => {
  const full = {
    enabled: true,
    minOverlapMinutes: 9,
    summaryMode: "off",
    sourceTrust: 0.5,
    autoApproveTrust: 0.5,
    reviewTrust: 0.5,
  };

  // The one canonical entrypoint: a top-level `meetings` block.
  const viaRoot = parseConfig({ meetings: full }).meetings;
  assert.deepEqual(viaRoot, parseMeetingsConfig(full));

  // No legacy-alias shapes feed the meetings block: anything other than the
  // top-level `meetings` key must leave the subsystem at its defaults. A new
  // alias would be a second parsed surface for the same runtime keys and
  // must not land silently (it would also need schema + docs + snapshot
  // updates and would flip this assertion).
  const viaAliasShapes = parseConfig({
    meeting: full,
    desktopCapture: { meetings: full },
    captureCompanions: { meetings: full },
  }).meetings;
  assert.deepEqual(viaAliasShapes, parseMeetingsConfig(undefined));
});
