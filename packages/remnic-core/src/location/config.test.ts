import assert from "node:assert/strict";
import test from "node:test";

import { defaultLocationConfig, parseLocationConfig } from "./config.js";

test("parseLocationConfig defaults to an inert configuration", () => {
  assert.deepEqual(defaultLocationConfig(), {
    enabled: false,
    timezone: "UTC",
    syncDays: 1,
    retainCoordinates: false,
    sources: [],
  });
  assert.deepEqual(parseLocationConfig(undefined), defaultLocationConfig());
  assert.deepEqual(parseLocationConfig(null), defaultLocationConfig());
});

test("parseLocationConfig treats string false gates as disabled", () => {
  assert.equal(parseLocationConfig({ enabled: "false", sources: [{ id: "reitti" }] }).enabled, false);
  assert.equal(
    parseLocationConfig({
      enabled: true,
      retainCoordinates: "0",
      sources: [{ id: "reitti", enabled: "false" }],
    }).retainCoordinates,
    false,
  );
});

test("parseLocationConfig rejects unrecognized gate values instead of defaulting", () => {
  assert.throws(() => parseLocationConfig({ enabled: "maybe" }), TypeError);
  assert.throws(() => parseLocationConfig({ retainCoordinates: 42 }), TypeError);
  assert.throws(() => parseLocationConfig({ sources: [{ id: "reitti", enabled: "nope" }] }), TypeError);
});

test("parseLocationConfig validates the timezone at parse time", () => {
  assert.throws(() => parseLocationConfig({ timezone: "Mars/Olympus" }), RangeError);
  assert.equal(parseLocationConfig({ timezone: "America/Chicago" }).timezone, "America/Chicago");
  assert.throws(() => parseLocationConfig({ timezone: "" }), TypeError);
});

test("parseLocationConfig enforces the syncDays integer range", () => {
  assert.equal(parseLocationConfig({ syncDays: "3" }).syncDays, 3);
  assert.throws(() => parseLocationConfig({ syncDays: 0 }), RangeError);
  assert.throws(() => parseLocationConfig({ syncDays: 1.5 }), RangeError);
  assert.throws(() => parseLocationConfig({ syncDays: 91 }), RangeError);
  assert.throws(() => parseLocationConfig({ syncDays: "abc" }), TypeError);
});

test("parseLocationConfig requires a source when enabled", () => {
  assert.throws(() => parseLocationConfig({ enabled: true }), RangeError);
  assert.throws(() => parseLocationConfig({ enabled: true, sources: "reitti" }), TypeError);
  const parsed = parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }] });
  assert.deepEqual(parsed.sources, [{ id: "reitti", enabled: true }]);
});

test("parseLocationConfig rejects malformed source entries", () => {
  assert.throws(() => parseLocationConfig({ sources: [{ id: "" }] }), TypeError);
  assert.throws(() => parseLocationConfig({ sources: [{}] }), TypeError);
  assert.throws(() => parseLocationConfig({ sources: [{ id: "Bad_Id" }] }), RangeError);
  assert.throws(() => parseLocationConfig({ sources: [{ id: "../escape" }] }), RangeError);
  assert.throws(() => parseLocationConfig({ sources: ["reitti"] }), TypeError);
});

test("parseLocationConfig rejects duplicate source ids", () => {
  assert.throws(
    () => parseLocationConfig({ enabled: true, sources: [{ id: "reitti" }, { id: "reitti", enabled: false }] }),
    RangeError,
  );
});

test("parseLocationConfig rejects non-object blocks", () => {
  assert.throws(() => parseLocationConfig("nope"), TypeError);
  assert.throws(() => parseLocationConfig([1, 2]), TypeError);
});
