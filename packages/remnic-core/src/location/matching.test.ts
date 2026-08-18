import assert from "node:assert/strict";
import test from "node:test";

import { matchDominantPlace, memoryLocationWindow, type LocationTagPolicy } from "./matching.js";
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
