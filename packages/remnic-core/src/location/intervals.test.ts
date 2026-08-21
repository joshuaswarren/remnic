import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketObservationsByDay,
  dominantPlace,
  intervalOverlapMs,
  localDayKey,
  locationDayWindow,
  observationSegments,
} from "./intervals.js";
import type { LocationObservation, LocationSegment } from "./types.js";

const HOUR_MS = 3_600_000;

function observation(observedAtUtc: string, placeId: string, label = placeId): LocationObservation {
  return { observedAtUtc, place: { id: placeId, label } };
}

function segment(startUtc: string, endUtc: string, placeId: string): LocationSegment {
  return { startUtc, endUtc, place: { id: placeId, label: placeId } };
}

test("intervalOverlapMs is 0 for disjoint intervals and exact for partial overlap", () => {
  assert.equal(
    intervalOverlapMs(
      { startUtc: "2026-08-17T09:00:00Z", endUtc: "2026-08-17T10:00:00Z" },
      { startUtc: "2026-08-17T10:00:00Z", endUtc: "2026-08-17T11:00:00Z" },
    ),
    0,
    "half-open intervals that touch at one instant do not overlap",
  );
  assert.equal(
    intervalOverlapMs(
      { startUtc: "2026-08-17T09:00:00Z", endUtc: "2026-08-17T10:30:00Z" },
      { startUtc: "2026-08-17T10:00:00Z", endUtc: "2026-08-17T11:00:00Z" },
    ),
    30 * 60_000,
  );
  assert.equal(
    intervalOverlapMs(
      { startUtc: "2026-08-17T09:00:00Z", endUtc: "2026-08-17T12:00:00Z" },
      { startUtc: "2026-08-17T09:30:00Z", endUtc: "2026-08-17T10:00:00Z" },
    ),
    30 * 60_000,
    "a contained interval overlaps by its own length",
  );
  assert.equal(
    intervalOverlapMs(
      { startUtc: "2026-08-17T09:00:00Z", endUtc: "2026-08-17T10:00:00Z" },
      { startUtc: "2026-08-17T09:00:00Z", endUtc: "2026-08-17T10:00:00Z" },
    ),
    HOUR_MS,
    "identical intervals overlap by their full length",
  );
});

test("locationDayWindow produces 23h spring-forward and 25h fall-back days in America/Chicago", () => {
  // US DST 2026: spring forward 2026-03-08, fall back 2026-11-01.
  const spring = locationDayWindow("2026-03-08", "America/Chicago");
  assert.equal(
    Date.parse(spring.endUtc) - Date.parse(spring.startUtc),
    23 * HOUR_MS,
    "spring-forward local day is 23 hours",
  );
  assert.equal(spring.startUtc, "2026-03-08T06:00:00.000Z");

  const fall = locationDayWindow("2026-11-01", "America/Chicago");
  assert.equal(
    Date.parse(fall.endUtc) - Date.parse(fall.startUtc),
    25 * HOUR_MS,
    "fall-back local day is 25 hours",
  );
  assert.equal(fall.startUtc, "2026-11-01T05:00:00.000Z");

  const utc = locationDayWindow("2026-08-17", "UTC");
  assert.equal(Date.parse(utc.endUtc) - Date.parse(utc.startUtc), 24 * HOUR_MS);
  assert.throws(() => locationDayWindow("2026-02-30", "UTC"), RangeError);
  assert.throws(() => locationDayWindow("2026-8-7", "UTC"), RangeError);
});

test("localDayKey buckets midnight exactly on the owning day (half-open)", () => {
  assert.equal(localDayKey("2026-08-17T00:00:00.000Z", "UTC"), "2026-08-17");
  assert.equal(localDayKey("2026-08-17T23:59:59.999Z", "UTC"), "2026-08-17");
  assert.equal(localDayKey("2026-08-18T00:00:00.000Z", "UTC"), "2026-08-18");
  // Zones east of UTC roll over mid-UTC-afternoon.
  assert.equal(localDayKey("2026-08-17T18:30:00.000Z", "Asia/Tokyo"), "2026-08-18");
  assert.throws(() => localDayKey("not-an-instant", "UTC"), RangeError);
});

test("bucketObservationsByDay sorts within each local day bucket", () => {
  const buckets = bucketObservationsByDay(
    [
      observation("2026-08-17T20:00:00Z", "b"),
      observation("2026-08-17T09:00:00Z", "a"),
      observation("2026-08-18T01:00:00Z", "c"),
    ],
    "UTC",
  );
  assert.deepEqual([...buckets.keys()].sort(), ["2026-08-17", "2026-08-18"]);
  assert.deepEqual(
    buckets.get("2026-08-17")!.map((item) => item.observedAtUtc),
    ["2026-08-17T09:00:00Z", "2026-08-17T20:00:00Z"],
  );
  assert.throws(
    () => bucketObservationsByDay([observation("garbage", "a")], "UTC"),
    RangeError,
    "a malformed instant is rejected loudly, never bucketed",
  );
});

test("observationSegments attributes dwell to the next observation and caps at window end", () => {
  const window = locationDayWindow("2026-08-17", "UTC");
  const segments = observationSegments(
    [observation("2026-08-17T09:00:00Z", "home"), observation("2026-08-17T09:30:00Z", "office")],
    window,
    { retainCoordinates: false },
  );
  assert.deepEqual(
    segments.map((item) => [item.startUtc, item.endUtc, item.place.id]),
    [
      ["2026-08-17T09:00:00.000Z", "2026-08-17T09:30:00.000Z", "home"],
      ["2026-08-17T09:30:00.000Z", window.endUtc, "office"],
    ],
    "the last observation dwells until the day window ends, never across it",
  );
});

test("observationSegments drops coordinates unless retention is enabled", () => {
  const window = locationDayWindow("2026-08-17", "UTC");
  const withCoords: LocationObservation[] = [
    {
      observedAtUtc: "2026-08-17T09:00:00Z",
      place: { id: "home", label: "Home", latitude: 41.8781, longitude: -87.6298 },
    },
  ];
  const stripped = observationSegments(withCoords, window, { retainCoordinates: false });
  assert.equal(stripped[0]!.place.latitude, undefined);
  assert.equal(stripped[0]!.place.longitude, undefined);
  const kept = observationSegments(withCoords, window, { retainCoordinates: true });
  assert.equal(kept[0]!.place.latitude, 41.8781);
  assert.equal(kept[0]!.place.longitude, -87.6298);
});

test("observationSegments rejects observations outside the requested window", () => {
  const window = locationDayWindow("2026-08-17", "UTC");
  assert.throws(
    () => observationSegments([observation("2026-08-18T00:00:00Z", "home")], window, { retainCoordinates: false }),
    RangeError,
    "the window end is exclusive",
  );
  assert.throws(
    () =>
      observationSegments([observation("2026-08-16T23:59:59.999Z", "home")], window, { retainCoordinates: false }),
    RangeError,
  );
  assert.throws(
    () =>
      observationSegments(
        [observation("2026-08-17T09:00:00Z", "home")],
        { startUtc: "2026-08-17T10:00:00Z", endUtc: "2026-08-17T09:00:00Z" },
        { retainCoordinates: false },
      ),
    RangeError,
    "an inverted window is rejected",
  );
});

test("dominantPlace breaks duration ties by earlier first start, then place id", () => {
  const tieEarlierStart = [
    segment("2026-08-17T09:00:00Z", "2026-08-17T10:00:00Z", "gym"),
    segment("2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "alpha"),
    segment("2026-08-17T11:00:00Z", "2026-08-17T12:00:00Z", "alpha"),
  ];
  assert.equal(dominantPlace(tieEarlierStart)?.place.id, "alpha");

  const tieSameStartLexicographic = [
    segment("2026-08-17T09:00:00Z", "2026-08-17T10:00:00Z", "zeta"),
    segment("2026-08-17T09:00:00Z", "2026-08-17T10:00:00Z", "beta"),
  ];
  assert.equal(
    dominantPlace(tieSameStartLexicographic)?.place.id,
    "beta",
    "equal totals and equal first starts fall back to the smaller place id",
  );

  // Deterministic across orderings (insertion order must never win).
  const shuffled = [...tieEarlierStart].reverse();
  assert.equal(dominantPlace(shuffled)?.place.id, "alpha");
  assert.equal(dominantPlace([]), null);
});

test("dominantPlace unions overlapping segments so two sources do not double-count", () => {
  const overlapping = [
    segment("2026-08-17T09:00:00Z", "2026-08-17T12:00:00Z", "home"),
    segment("2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", "office"),
    segment("2026-08-17T14:00:00Z", "2026-08-17T18:00:00Z", "office"),
  ];
  const dominant = dominantPlace(overlapping)!;
  assert.equal(dominant.place.id, "office");
  assert.equal(dominant.totalMs, 5 * HOUR_MS, "1h overlapping office + 4h afternoon office");
});
