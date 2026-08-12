import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultWearablesConfig,
  parseWearablesConfig,
} from "./config.js";

test("undefined yields the disabled default config", () => {
  const parsed = parseWearablesConfig(undefined);
  assert.deepEqual(parsed, defaultWearablesConfig());
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.redactionEnabled, true);
});

test("non-object shapes are rejected loudly", () => {
  assert.throws(() => parseWearablesConfig(false), /must be an object/);
  assert.throws(() => parseWearablesConfig(null), /must be an object/);
  assert.throws(() => parseWearablesConfig([]), /must be an object/);
});

test("boolean-ish strings coerce; garbage booleans throw", () => {
  assert.equal(parseWearablesConfig({ enabled: "true" }).enabled, true);
  assert.equal(parseWearablesConfig({ enabled: "off" }).enabled, false);
  assert.throws(() => parseWearablesConfig({ enabled: "fales" }), /wearables.enabled/);
});

test("source settings default to the fully-automated smart pipeline", () => {
  const parsed = parseWearablesConfig({
    enabled: true,
    sources: { limitless: { enabled: true } },
  });
  const source = parsed.sources.limitless;
  assert.equal(source.memoryMode, "smart");
  assert.equal(source.sourceTrust, 0.8);
  assert.equal(source.autoApproveTrust, 0.7);
  assert.equal(source.reviewTrust, 0.45);
  assert.equal(source.minConfidence, 0.6);
  assert.equal(source.minImportance, "low");
  assert.equal(source.maxMemoriesPerDay, 0, "uncapped by default");
  assert.equal(source.importNativeMemories, "smart");
  assert.deepEqual(source.cleanup, {
    mergeSameSpeaker: true,
    stripFillers: true,
    collapseRepeats: true,
    dropLowQuality: true,
    // Opt-in for Bee only; limitless keeps the legacy default (issue #1811).
    preserveUtteranceBoundaries: false,
  });
});

test("bee source defaults to preserving utterance boundaries (#1811)", () => {
  const parsed = parseWearablesConfig({
    enabled: true,
    sources: { bee: { enabled: true } },
  });
  assert.equal(parsed.sources.bee.cleanup.preserveUtteranceBoundaries, true);
});

test("cleanup.preserveUtteranceBoundaries is parsed and overrides the source default", () => {
  const parsed = parseWearablesConfig({
    enabled: true,
    sources: { bee: { enabled: true, cleanup: { preserveUtteranceBoundaries: false } } },
  });
  assert.equal(parsed.sources.bee.cleanup.preserveUtteranceBoundaries, false);
  assert.throws(
    () =>
      parseWearablesConfig({
        sources: { bee: { cleanup: { preserveUtteranceBoundaries: "maybe" } } },
      }),
    /cleanup.preserveUtteranceBoundaries/,
  );
});

test("top-level defaults are full-featured: digest and off-the-record on", () => {
  const parsed = parseWearablesConfig({});
  assert.equal(parsed.digestEnabled, true);
  assert.equal(parsed.offTheRecordEnabled, true);
  assert.equal(parsed.redactionEnabled, true);
});

test("trust knobs validate range and ordering", () => {
  assert.throws(
    () => parseWearablesConfig({ sources: { bee: { sourceTrust: 1.5 } } }),
    /sourceTrust must be a number between 0 and 1/,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { bee: { autoApproveTrust: -1 } } }),
    /autoApproveTrust/,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { bee: { reviewTrust: 0.9, autoApproveTrust: 0.7 } } }),
    /reviewTrust .* must be below autoApproveTrust/,
  );
  const parsed = parseWearablesConfig({
    sources: { bee: { sourceTrust: 0.5, autoApproveTrust: 0.8, reviewTrust: 0.3 } },
  });
  assert.equal(parsed.sources.bee.sourceTrust, 0.5);
});

test("invalid enum values list the valid options", () => {
  assert.throws(
    () =>
      parseWearablesConfig({
        sources: { limitless: { memoryMode: "yolo" } },
      }),
    /memoryMode must be one of "off", "review", "auto"/,
  );
  assert.throws(
    () =>
      parseWearablesConfig({
        sources: { limitless: { minImportance: "huge" } },
      }),
    /minImportance/,
  );
});

test("maxMemoriesPerDay honors the documented 0-disables value and bounds", () => {
  const parsed = parseWearablesConfig({
    sources: { limitless: { maxMemoriesPerDay: 0 } },
  });
  assert.equal(parsed.sources.limitless.maxMemoriesPerDay, 0);
  // No ceiling: any non-negative integer cap is the operator's call.
  assert.equal(
    parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: 99999 } } })
      .sources.limitless.maxMemoriesPerDay,
    99999,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: -1 } } }),
    /maxMemoriesPerDay must be a non-negative integer/,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: "lots" } } }),
    /maxMemoriesPerDay/,
  );
  // Fractional values must reject, not floor — 0.5 flooring to 0 would
  // silently disable the cap.
  assert.throws(
    () => parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: 0.5 } } }),
    /maxMemoriesPerDay/,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: -3 } } }),
    /maxMemoriesPerDay/,
  );
});

test("source ids are validated against the path-safe pattern", () => {
  assert.throws(
    () => parseWearablesConfig({ sources: { "Bad Source!": {} } }),
    /lowercase source ids/,
  );
  // Custom (non-built-in) ids are allowed — third-party connectors.
  const parsed = parseWearablesConfig({ sources: { "my-recorder": {} } });
  assert.ok(parsed.sources["my-recorder"]);
});

test("timezone is validated as a real IANA identifier", () => {
  assert.equal(
    parseWearablesConfig({ timezone: "America/Chicago" }).timezone,
    "America/Chicago",
  );
  assert.throws(() => parseWearablesConfig({ timezone: "Mars/Olympus" }), /IANA/);
});

test("correction rules and redaction patterns are compiled at parse time", () => {
  assert.throws(
    () => parseWearablesConfig({ corrections: [{ match: "(", replace: "x", regex: true }] }),
    /not a valid regular expression/,
  );
  assert.throws(
    () => parseWearablesConfig({ redactionPatterns: ["("] }),
    /redactionPatterns/,
  );
  const parsed = parseWearablesConfig({
    corrections: [{ match: "remnick", replace: "Remnic", sources: ["limitless"] }],
    redactionPatterns: ["internal-codename-\\w+"],
  });
  assert.equal(parsed.corrections.length, 1);
  assert.equal(parsed.redactionPatterns.length, 1);
});

test("minConfidence rejects out-of-range values instead of clamping", () => {
  assert.throws(
    () => parseWearablesConfig({ sources: { bee: { minConfidence: 7 } } }),
    /minConfidence must be a number between 0 and 1/,
  );
  assert.throws(
    () => parseWearablesConfig({ sources: { bee: { minConfidence: -1 } } }),
    /minConfidence/,
  );
  assert.equal(
    parseWearablesConfig({ sources: { bee: { minConfidence: 0.85 } } }).sources.bee.minConfidence,
    0.85,
  );
});

test("auto-sync defaults to enabled with sane window settings", () => {
  const parsed = parseWearablesConfig({});
  assert.equal(parsed.autoSyncEnabled, true);
  assert.equal(parsed.autoSyncIntervalMinutes, 15);
  assert.equal(parsed.autoSyncDays, 2);
  assert.equal(parsed.autoSyncDeepDays, 7);
});

test("auto-sync knobs parse, coerce, and loud-reject invalid values", () => {
  const parsed = parseWearablesConfig({
    autoSyncEnabled: "false",
    autoSyncIntervalMinutes: "30",
    autoSyncDays: 3,
    autoSyncDeepDays: 14,
  });
  assert.equal(parsed.autoSyncEnabled, false, "boolean-ish strings coerce");
  assert.equal(parsed.autoSyncIntervalMinutes, 30, "numeric strings coerce");
  assert.equal(parsed.autoSyncDays, 3);
  assert.equal(parsed.autoSyncDeepDays, 14);

  assert.throws(
    () => parseWearablesConfig({ autoSyncIntervalMinutes: 0 }),
    /autoSyncIntervalMinutes must be an integer between 1 and 1440/,
  );
  assert.throws(
    () => parseWearablesConfig({ autoSyncIntervalMinutes: 2.5 }),
    /autoSyncIntervalMinutes/,
  );
  assert.throws(
    () => parseWearablesConfig({ autoSyncDays: 0 }),
    /autoSyncDays must be an integer between 1 and 90/,
  );
  assert.throws(
    () => parseWearablesConfig({ autoSyncDeepDays: 91 }),
    /autoSyncDeepDays must be an integer between 0 and 90/,
  );
});

test("a deep window narrower than the tick window is rejected, 0 disables", () => {
  assert.throws(
    () => parseWearablesConfig({ autoSyncDays: 5, autoSyncDeepDays: 3 }),
    /autoSyncDeepDays must be 0 \(disabled\) or >= wearables.autoSyncDays/,
  );
  assert.equal(parseWearablesConfig({ autoSyncDeepDays: 0 }).autoSyncDeepDays, 0);
  assert.equal(
    parseWearablesConfig({ autoSyncDays: 5, autoSyncDeepDays: 5 }).autoSyncDeepDays,
    5,
  );
});


test("fusion defaults to disabled with documented knobs", () => {
  const parsed = parseWearablesConfig({});
  assert.equal(parsed.fusion.enabled, false);
  assert.equal(parsed.fusion.proximityGapMs, 300_000);
  assert.equal(parsed.fusion.windowToleranceMs, 30_000);
});

test("fusion enabled flag and knobs parse and validate", () => {
  const parsed = parseWearablesConfig({
    fusion: { enabled: true, proximityGapMs: 120_000, windowToleranceMs: 15_000 },
  });
  assert.equal(parsed.fusion.enabled, true);
  assert.equal(parsed.fusion.proximityGapMs, 120_000);
  assert.equal(parsed.fusion.windowToleranceMs, 15_000);
});

test("fusion knobs reject non-positive integers", () => {
  assert.throws(
    () => parseWearablesConfig({ fusion: { proximityGapMs: 0 } }),
    /proximityGapMs must be a positive integer/,
  );
  assert.throws(
    () => parseWearablesConfig({ fusion: { windowToleranceMs: -5 } }),
    /windowToleranceMs must be a positive integer/,
  );
});

test("fusion block must be an object when present", () => {
  assert.throws(() => parseWearablesConfig({ fusion: "on" }), /must be an object/);
});

test("off-the-record marker phrases and filler tokens parse", () => {
  const parsed = parseWearablesConfig({
    offTheRecordMarkers: {
      start: ["  poza protokołem  "],
      end: ["z powrotem do protokołu"],
    },
    fillerTokens: ["bueno", "那个"],
  });
  assert.deepEqual(parsed.offTheRecordMarkers.start, ["poza protokołem"]);
  assert.deepEqual(parsed.offTheRecordMarkers.end, ["z powrotem do protokołu"]);
  assert.equal(parsed.offTheRecordMarkers.useBuiltIns, true);
  assert.deepEqual(parsed.fillerTokens, ["bueno", "那个"]);
});

test("marker and filler lists reject unusable entries loudly", () => {
  assert.throws(
    () => parseWearablesConfig({ offTheRecordMarkers: { start: "poza" } }),
    /offTheRecordMarkers\.start must be an array of strings/,
  );
  assert.throws(
    () => parseWearablesConfig({ offTheRecordMarkers: { end: ["  "] } }),
    /offTheRecordMarkers\.end\[0\] must be a non-empty string/,
  );
  assert.throws(
    () => parseWearablesConfig({ fillerTokens: ["a".repeat(65)] }),
    /fillerTokens\[0\] exceeds 64 characters/,
  );
  assert.throws(
    () => parseWearablesConfig({ offTheRecordMarkers: { start: ["a".repeat(129)] } }),
    /offTheRecordMarkers\.start\[0\] exceeds 128 characters/,
  );
  assert.throws(
    () => parseWearablesConfig({ offTheRecordMarkers: [] }),
    /offTheRecordMarkers must be an object/,
  );
});

test("disabling built-in markers without a start phrase is rejected, not silent", () => {
  assert.throws(
    () =>
      parseWearablesConfig({
        offTheRecordEnabled: true,
        offTheRecordMarkers: { useBuiltIns: false },
      }),
    /useBuiltIns is false but no start phrase is configured/,
  );
  // Turning the whole feature off is the documented escape hatch.
  const parsed = parseWearablesConfig({
    offTheRecordEnabled: false,
    offTheRecordMarkers: { useBuiltIns: false },
  });
  assert.equal(parsed.offTheRecordEnabled, false);
  assert.equal(parsed.offTheRecordMarkers.useBuiltIns, false);
});
