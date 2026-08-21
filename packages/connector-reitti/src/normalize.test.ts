import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReittiPlaceVisitSummary, ReittiTimelineEntry } from "./client.js";
import { timelineObservations, visitSummaryObservations } from "./normalize.js";

/** 2026-08-17 UTC day window. */
const WINDOW = { startUtc: "2026-08-17T00:00:00.000Z", endUtc: "2026-08-18T00:00:00.000Z" };

function visit(
  id: string,
  startUtc: string,
  endUtc: string,
  place: ReittiTimelineEntry["place"],
): ReittiTimelineEntry {
  return { id, type: "VISIT", startTime: startUtc, endTime: endUtc, place, transportMode: null, distanceMeters: null };
}

function trip(
  id: string,
  startUtc: string,
  endUtc: string,
  transportMode: ReittiTimelineEntry["transportMode"],
  distanceMeters: number | null,
): ReittiTimelineEntry {
  return { id, type: "TRIP", startTime: startUtc, endTime: endUtc, place: null, transportMode, distanceMeters };
}

const HOME = { id: 7, name: "Home", address: null, city: null, type: "HOME" as const };
const OFFICE = { id: 12, name: "Office", address: "1 Main St", city: "Berlin", type: "WORK" as const };

test("a VISIT-TRIP-VISIT day round-trips into paired observations per interval", () => {
  const entries = [
    visit("v1", "2026-08-17T08:00:00Z", "2026-08-17T09:00:00Z", HOME),
    trip("t1", "2026-08-17T09:00:00Z", "2026-08-17T10:00:00Z", "TRAIN", 12_345),
    visit("v2", "2026-08-17T10:00:00Z", "2026-08-17T11:00:00Z", OFFICE),
  ];
  const observations = timelineObservations(entries, WINDOW);
  assert.equal(observations.length, 6);
  assert.deepEqual(
    observations.map((o) => o.observedAtUtc),
    [
      "2026-08-17T08:00:00.000Z",
      "2026-08-17T09:00:00.000Z",
      "2026-08-17T09:00:00.000Z",
      "2026-08-17T10:00:00.000Z",
      "2026-08-17T10:00:00.000Z",
      "2026-08-17T11:00:00.000Z",
    ],
  );
  assert.equal(observations[0]?.place.id, "reitti:place:7");
  assert.equal(observations[0]?.place.label, "Home");
  assert.equal(observations[0]?.place.kind, "home");
  assert.equal(observations[2]?.place.id, "reitti:trip:t1");
  assert.equal(observations[2]?.place.label, "Trip (TRAIN · 12.3 km)");
  assert.equal(observations[2]?.place.kind, "transit");
  assert.equal(observations[4]?.place.id, "reitti:place:12");
  assert.equal(observations[4]?.place.kind, "work");
});

test("a trip without distance omits the km suffix; unknown mode stays explicit", () => {
  const noDistance = timelineObservations([trip("t1", "2026-08-17T08:00:00Z", "2026-08-17T08:30:00Z", "WALKING", null)], WINDOW);
  assert.equal(noDistance[0]?.place.label, "Trip (WALKING)");
  const noMode = timelineObservations([trip("t2", "2026-08-17T08:00:00Z", "2026-08-17T08:30:00Z", null, 900)], WINDOW);
  assert.equal(noMode[0]?.place.label, "Trip (UNKNOWN · 0.9 km)");
});

test("a nullable place is preserved without inventing a name or coordinates", () => {
  const [visitObs] = timelineObservations([visit("v9", "2026-08-17T08:00:00Z", "2026-08-17T09:00:00Z", null)], WINDOW);
  assert.equal(visitObs?.place.id, "reitti:visit:v9");
  assert.equal(visitObs?.place.label, "Unnamed place");
  assert.equal(visitObs?.place.kind, "other");
  assert.equal("latitude" in (visitObs?.place ?? {}), false);
  assert.equal("longitude" in (visitObs?.place ?? {}), false);
});

test("place labels fall back name > address > city > opaque id", () => {
  const cases: Array<[ReittiTimelineEntry["place"], string]> = [
    [{ id: 1, name: "Gym", address: "2 Oak Ave", city: "Leeds", type: "GYM" }, "Gym"],
    [{ id: 2, name: null, address: "2 Oak Ave", city: "Leeds", type: "OTHER" }, "2 Oak Ave"],
    [{ id: 3, name: null, address: null, city: "Leeds", type: "OTHER" }, "Leeds"],
    [{ id: 4, name: null, address: null, city: null, type: null }, "Place 4"],
  ];
  for (const [place, expected] of cases) {
    const [observation] = timelineObservations([visit("v", "2026-08-17T08:00:00Z", "2026-08-17T09:00:00Z", place)], WINDOW);
    assert.equal(observation?.place.label, expected);
  }
});

test("a non-HOME/WORK place type maps to poi", () => {
  const cafe = { id: 9, name: "Cafe", address: null, city: null, type: "CAFE" as const };
  const [observation] = timelineObservations([visit("v", "2026-08-17T08:00:00Z", "2026-08-17T09:00:00Z", cafe)], WINDOW);
  assert.equal(observation?.place.kind, "poi");
});

test("entries spilling across the window boundary clamp into the window", () => {
  const entries = [
    // Started the previous day, ends inside the window: one observation at its end.
    visit("v1", "2026-08-16T23:00:00Z", "2026-08-17T01:00:00Z", HOME),
    // Entirely outside the window: dropped.
    visit("v2", "2026-08-18T05:00:00Z", "2026-08-18T06:00:00Z", HOME),
    // Spans the whole day: observations at the window edges.
    visit("v3", "2026-08-16T12:00:00Z", "2026-08-18T12:00:00Z", OFFICE),
  ];
  const observations = timelineObservations(entries, WINDOW);
  assert.deepEqual(
    observations.map((o) => o.observedAtUtc),
    [
      "2026-08-17T00:00:00.000Z",
      "2026-08-17T00:00:00.000Z",
      "2026-08-17T01:00:00.000Z",
      "2026-08-17T23:59:59.999Z",
    ],
  );
  assert.deepEqual(
    observations.map((o) => o.place.id),
    ["reitti:place:7", "reitti:place:12", "reitti:place:7", "reitti:place:12"],
  );
});

test("a zero-duration entry yields a single observation", () => {
  const observations = timelineObservations([visit("v1", "2026-08-17T08:00:00Z", "2026-08-17T08:00:00Z", HOME)], WINDOW);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.observedAtUtc, "2026-08-17T08:00:00.000Z");
});

test("an invalid window throws instead of normalizing", () => {
  assert.throws(() => timelineObservations([], { startUtc: "2026-08-17T00:00:00Z", endUtc: "2026-08-17T00:00:00Z" }), RangeError);
  assert.throws(() => timelineObservations([], { startUtc: "later", endUtc: "2026-08-17T00:00:00Z" }), RangeError);
});

test("visit summaries normalize per visit interval under the summary's place", () => {
  const summaries: ReittiPlaceVisitSummary[] = [
    {
      place: { id: 7, name: "Home", address: null, city: null, type: "HOME" },
      visits: [
        { startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z" },
        { startTime: "2026-08-17T20:00:00Z", endTime: "2026-08-17T21:00:00Z" },
      ],
    },
  ];
  const observations = visitSummaryObservations(summaries, WINDOW);
  assert.equal(observations.length, 4);
  assert.ok(observations.every((o) => o.place.id === "reitti:place:7"));
  assert.deepEqual(
    observations.map((o) => o.observedAtUtc),
    [
      "2026-08-17T08:00:00.000Z",
      "2026-08-17T09:00:00.000Z",
      "2026-08-17T20:00:00.000Z",
      "2026-08-17T21:00:00.000Z",
    ],
  );
});

test("two unresolved visit places keep distinct identities", () => {
  const summaries: ReittiPlaceVisitSummary[] = [
    { place: null, visits: [{ startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z" }] },
    { place: null, visits: [{ startTime: "2026-08-17T20:00:00Z", endTime: "2026-08-17T21:00:00Z" }] },
  ];
  const ids = new Set(visitSummaryObservations(summaries, WINDOW).map((o) => o.place.id));
  assert.equal(ids.size, 2, "distinct unresolved places must not merge into one segment");
});

test("a place Reitti left without an id does not collapse with another", () => {
  const nameless = { id: null, name: null, address: null, city: null, type: null } as const;
  const summaries: ReittiPlaceVisitSummary[] = [
    { place: { ...nameless }, visits: [{ startTime: "2026-08-17T08:00:00Z", endTime: "2026-08-17T09:00:00Z" }] },
    { place: { ...nameless }, visits: [{ startTime: "2026-08-17T20:00:00Z", endTime: "2026-08-17T21:00:00Z" }] },
  ];
  const ids = new Set(visitSummaryObservations(summaries, WINDOW).map((o) => o.place.id));
  assert.equal(ids.size, 2, "a null upstream id must not become one shared identity");
});
