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
  assert.equal(source.maxMemoriesPerDay, 50);
  assert.equal(source.importNativeMemories, "smart");
  assert.deepEqual(source.cleanup, {
    mergeSameSpeaker: true,
    stripFillers: true,
    collapseRepeats: true,
    dropLowQuality: true,
  });
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
  // Over-ceiling values reject instead of silently clamping to 500.
  assert.throws(
    () => parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: 99999 } } }),
    /maxMemoriesPerDay must be an integer between 0 and 500/,
  );
  assert.equal(
    parseWearablesConfig({ sources: { limitless: { maxMemoriesPerDay: 500 } } })
      .sources.limitless.maxMemoriesPerDay,
    500,
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
