import assert from "node:assert/strict";
import test from "node:test";

import { locationTagSlug, matchDominantPlace, memoryLocationWindow, type LocationTagPolicy } from "./matching.js";
import type { LocationPlace, LocationSegment } from "./types.js";

const policy: LocationTagPolicy = {
  minimumOverlapSeconds: 60,
  minimumConfidence: 0.4,
  retainCoordinates: false,
};

const home: LocationPlace = { id: "home", label: "Home", kind: "home" };
const work: LocationPlace = { id: "work", label: "Work", kind: "work" };

function segment(place: LocationPlace, start: string, end: string, confidence = 0.9): LocationSegment {
  return { startUtc: start, endUtc: end, place, confidence };
}

test("untimed and over-long memories stay untagged", () => {
  const day = (iso: string) => iso.slice(0, 10);
  assert.equal(memoryLocationWindow({}, day).rejected, "untimed");
  assert.equal(
    memoryLocationWindow(
      { valid_at: "2026-08-01T00:00:00.000Z", invalid_at: "2026-08-03T00:00:00.000Z" },
      day,
    ).rejected,
    "span-too-long",
  );
});

test("dominant named place wins; ties stay unmatched", () => {
  const window = { kind: "interval" as const, startUtc: "2026-08-01T12:00:00.000Z", endUtc: "2026-08-01T14:00:00.000Z" };
  const matched = matchDominantPlace(
    window,
    [
      {
        sourceId: "reitti",
        segments: [
          segment(home, "2026-08-01T11:00:00.000Z", "2026-08-01T13:30:00.000Z"),
          segment(work, "2026-08-01T13:30:00.000Z", "2026-08-01T14:00:00.000Z"),
        ],
      },
    ],
    policy,
  );
  assert.equal(matched.status, "matched");
  if (matched.status === "matched") assert.equal(matched.match.place.id, "home");

  const tied = matchDominantPlace(
    window,
    [
      {
        sourceId: "reitti",
        segments: [
          segment(home, "2026-08-01T12:00:00.000Z", "2026-08-01T13:00:00.000Z"),
          segment(work, "2026-08-01T13:00:00.000Z", "2026-08-01T14:00:00.000Z"),
        ],
      },
    ],
    policy,
  );
  assert.equal(tied.status, "unmatched");
  if (tied.status === "unmatched") assert.equal(tied.reason, "ambiguous");
});

test("locationTagSlug: pins slug collapsing and edge trimming", () => {
  assert.equal(locationTagSlug("reitti:place:7"), "reitti-place-7");
  assert.equal(locationTagSlug("  --Mixed CASE--  "), "mixed-case");
  assert.equal(locationTagSlug("---"), "");
  assert.equal(locationTagSlug("a---b"), "a-b");
  assert.equal(locationTagSlug("Café Central"), "caf-central");
});

test("locationTagSlug: the collapse keeps edges single-dash, so the trim is complete", () => {
  // This is the invariant the single-character edge strips depend on: the
  // /[^a-z0-9]+/ collapse cannot leave two dashes at an edge. Relax or reorder
  // the collapse and the strips silently stop being complete, so assert the
  // OUTPUT contract directly rather than timing something the collapse has
  // already bounded.
  const adversarial = [
    "-".repeat(5_000),
    "a" + "-".repeat(5_000) + "b",
    "-".repeat(5_000) + "a",
    "a" + "-".repeat(5_000),
    "___---...   a   ...---___",
    "\u2014\u2014a\u2014\u2014",
  ];
  for (const placeId of adversarial) {
    const slug = locationTagSlug(placeId);
    assert.ok(!slug.startsWith("-"), `leading dash survived: ${JSON.stringify(slug)}`);
    assert.ok(!slug.endsWith("-"), `trailing dash survived: ${JSON.stringify(slug)}`);
    assert.doesNotMatch(slug, /--/, `adjacent dashes survived: ${JSON.stringify(slug)}`);
  }
});