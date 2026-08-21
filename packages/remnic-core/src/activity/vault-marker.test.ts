import assert from "node:assert/strict";
import test from "node:test";

import { formatRegionMarkers } from "./vault-marker.js";

test("formatRegionMarkers returns begin and end HTML comments", () => {
  assert.deepEqual(formatRegionMarkers("timeline"), {
    begin: "<!-- remnic:begin timeline -->",
    end: "<!-- remnic:end timeline -->",
  });
});

test("formatRegionMarkers rejects an empty name", () => {
  assert.throws(() => formatRegionMarkers(""), /empty/i);
});

test("formatRegionMarkers rejects a newline in the name", () => {
  assert.throws(() => formatRegionMarkers("time\nline"), /newline/i);
});

test("formatRegionMarkers rejects marker text in the name", () => {
  assert.throws(() => formatRegionMarkers("foo-->bar"), /-->/);
});
