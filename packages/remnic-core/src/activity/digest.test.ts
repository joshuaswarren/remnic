import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityDateInTimezone,
  activityDayWindow,
  activityDigestPath,
  composeActivityDigestBody,
  composeActivityDigestMeta,
  isValidActivityDate,
  parseActivityDigest,
  serializeActivityDigest,
} from "./digest.js";
import type { ActivitySnapshot } from "./types.js";

function snap(overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    machine: "macstudio",
    capturedAtUtc: "2026-03-10T14:00:00.000Z",
    app: "Chrome",
    windowTitle: "Roadmap",
    text: "quarterly roadmap review notes",
    textSource: "ax",
    contentHash: "h",
    ...overrides,
  };
}

const DAY = [
  snap({ id: 1, contentHash: "a", capturedAtUtc: "2026-03-10T14:00:00.000Z", app: "Chrome", windowTitle: "Roadmap", text: "roadmap planning" }),
  snap({ id: 2, contentHash: "b", capturedAtUtc: "2026-03-10T14:10:00.000Z", app: "Slack", windowTitle: "#eng", text: "deploy staging soon" }),
  snap({ id: 3, contentHash: "c", capturedAtUtc: "2026-03-10T14:12:00.000Z", app: "Chrome", windowTitle: "PR 412", browserUrl: "https://github.com/x/pull/412", text: "review pull request" }),
];

test("composeActivityDigestBody is byte-identical across two renders (deterministic)", () => {
  const a = composeActivityDigestBody("2026-03-10", "America/Chicago", DAY);
  const b = composeActivityDigestBody("2026-03-10", "America/Chicago", [...DAY].reverse());
  assert.equal(a, b);
});

test("per-app time section is sorted with a stable tiebreaker on equal dwell", () => {
  // Two apps with identical (zero) dwell — last snapshots — must order by name.
  const snaps = [
    snap({ id: 1, contentHash: "a", capturedAtUtc: "2026-03-10T14:00:00.000Z", app: "Zed" }),
    snap({ id: 2, contentHash: "b", capturedAtUtc: "2026-03-10T14:00:00.000Z", app: "Arc" }),
  ];
  const body1 = composeActivityDigestBody("2026-03-10", "UTC", snaps);
  const body2 = composeActivityDigestBody("2026-03-10", "UTC", [...snaps].reverse());
  assert.equal(body1, body2);
  // Arc sorts before Zed at equal dwell.
  assert.ok(body1.indexOf("- Arc:") < body1.indexOf("- Zed:"));
});

test("contentHash is stable across renders and meta reflects inputs", () => {
  const body = composeActivityDigestBody("2026-03-10", "UTC", DAY);
  const meta = composeActivityDigestMeta("2026-03-10", ["laptop", "macstudio", "laptop"], DAY, body);
  assert.equal(meta.kind, "activity-digest");
  assert.equal(meta.snapshotCount, 3);
  assert.deepEqual(meta.machines, ["laptop", "macstudio"]); // deduped + sorted
  assert.equal(meta.contentHash, composeActivityDigestMeta("2026-03-10", ["macstudio"], DAY, body).contentHash);
});

test("serialize → parse round-trips meta and body", () => {
  const body = composeActivityDigestBody("2026-03-10", "UTC", DAY);
  const meta = composeActivityDigestMeta("2026-03-10", ["macstudio"], DAY, body);
  const parsed = parseActivityDigest(serializeActivityDigest(meta, body));
  assert.ok(parsed);
  assert.deepEqual(parsed?.meta, meta);
  assert.equal(parsed?.body, body);
});

test("parseActivityDigest returns null on malformed input", () => {
  assert.equal(parseActivityDigest("no frontmatter here"), null);
  assert.equal(parseActivityDigest("---\nkind: activity-digest\n(no closing fence)"), null);
  assert.equal(parseActivityDigest("---\nkind: other\ndate: 2026-03-10\ncontentHash: x\n---\nbody"), null);
});

test("activityDayWindow yields half-open DST-aware bounds", () => {
  const w = activityDayWindow("2026-03-10", "America/Chicago");
  assert.equal(w.startUtc, "2026-03-10T05:00:00.000Z");
  assert.equal(w.endUtc, "2026-03-11T05:00:00.000Z");
  // Spring-forward day: CST→CDT shift reflected.
  const dst = activityDayWindow("2026-03-08", "America/Chicago");
  assert.equal(dst.startUtc, "2026-03-08T06:00:00.000Z");
  assert.equal(dst.endUtc, "2026-03-09T05:00:00.000Z");
});

test("a snapshot at exactly local midnight lands in exactly one day", () => {
  // Local midnight 2026-03-10 in America/Chicago (CST) == 06:00Z.
  const midnightUtc = "2026-03-10T06:00:00.000Z";
  const day10 = activityDayWindow("2026-03-10", "America/Chicago");
  const day09 = activityDayWindow("2026-03-09", "America/Chicago");
  // Included in the 10th (start-inclusive), excluded from the 9th (end-exclusive).
  assert.ok(midnightUtc >= day10.startUtc && midnightUtc < day10.endUtc);
  assert.ok(!(midnightUtc >= day09.startUtc && midnightUtc < day09.endUtc));
});

test("activityDigestPath places the file under <memoryDir>/activity/", () => {
  assert.equal(activityDigestPath("/mem", "2026-03-10"), "/mem/activity/2026-03-10.md");
});

test("isValidActivityDate rejects impossible and malformed calendar days", () => {
  assert.equal(isValidActivityDate("2026-03-10"), true);
  assert.equal(isValidActivityDate("2026-02-30"), false); // Feb has no 30th
  assert.equal(isValidActivityDate("2026-13-01"), false); // no month 13
  assert.equal(isValidActivityDate("2026-00-10"), false);
  assert.equal(isValidActivityDate("not-a-date"), false);
  assert.equal(isValidActivityDate("2026-3-10"), false); // wrong shape
});

test("activityDigestPath rejects path-traversal / invalid dates", () => {
  assert.equal(activityDigestPath("/mem", "2026-03-10"), "/mem/activity/2026-03-10.md");
  assert.throws(() => activityDigestPath("/mem", "../../etc/passwd"), RangeError);
  assert.throws(() => activityDigestPath("/mem", "2026-02-30"), RangeError);
});

test("activityDayWindow rejects an impossible date", () => {
  assert.throws(() => activityDayWindow("2026-02-30", "UTC"), RangeError);
  assert.throws(() => activityDayWindow("../evil", "UTC"), RangeError);
});

test("parseActivityDigest rejects a non-numeric snapshotCount/formatVersion", () => {
  const body = composeActivityDigestBody("2026-03-10", "UTC", DAY);
  const meta = composeActivityDigestMeta("2026-03-10", ["macstudio"], DAY, body);
  const good = serializeActivityDigest(meta, body);
  const broken = good.replace(/snapshotCount: \d+/, "snapshotCount: lots");
  assert.equal(parseActivityDigest(broken), null);
});

test("dwell is scoped per capture machine — an interleaved machine can't steal it", () => {
  const snaps = [
    snap({ machine: "A", app: "A-app", capturedAtUtc: "2026-03-10T14:00:00.000Z", contentHash: "a1" }),
    snap({ machine: "B", app: "B-app", capturedAtUtc: "2026-03-10T14:01:00.000Z", contentHash: "b1" }),
    snap({ machine: "A", app: "A-app", capturedAtUtc: "2026-03-10T14:10:00.000Z", contentHash: "a2" }),
  ];
  const body = composeActivityDigestBody("2026-03-10", "UTC", snaps);
  // A-app dwell = A@14:00 → A@14:10 = 10m (per-machine), not 1m (global next = B@14:01).
  assert.ok(body.includes("- A-app: 10m"), body);
});

test("digest ordering is deterministic for same-time unsaved snapshots", () => {
  const a = snap({ capturedAtUtc: "2026-03-10T14:00:00.000Z", contentHash: "h-a", app: "Alpha", text: "alpha window" });
  const b = snap({ capturedAtUtc: "2026-03-10T14:00:00.000Z", contentHash: "h-b", app: "Beta", text: "beta window" });
  const one = composeActivityDigestBody("2026-03-10", "UTC", [a, b]);
  const two = composeActivityDigestBody("2026-03-10", "UTC", [b, a]);
  assert.equal(one, two);
});

test("activityDayWindow does not backdate a skipped local midnight", () => {
  // Egypt restarts DST on the last Friday of April at 00:00 (00:00 → 01:00),
  // so local midnight is skipped. The day-start must land on the correct local
  // day (the first existing local time), never backdated into the prior day.
  const w = activityDayWindow("2026-04-24", "Africa/Cairo");
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(w.startUtc));
  assert.ok(local.startsWith("2026-04-24"), local);
});

test("activityDayWindow keeps the last real day whole across an entirely skipped civil date", () => {
  // Pacific/Apia jumped the date line at 2011-12-29 23:59:59-10:00 →
  // 2011-12-31 00:00:00+14:00, so local 2011-12-30 never existed. Pre-fix,
  // the skipped date's day start backdated into 2011-12-29, collapsing the
  // 29th's window to identical bounds — a `wearables sync --date
  // 2011-12-29` then dropped every Fireflies transcript of the day.
  const w = activityDayWindow("2011-12-29", "Pacific/Apia");
  assert.equal(w.startUtc, "2011-12-29T10:00:00.000Z"); // 2011-12-29 00:00 -10:00
  assert.equal(w.endUtc, "2011-12-30T10:00:00.000Z"); // the jump instant
  assert.ok(Date.parse(w.endUtc) > Date.parse(w.startUtc), "window must be non-degenerate");
  // Attribution is exact: every instant in the window is locally the 29th.
  assert.equal(activityDateInTimezone(new Date(w.startUtc), "Pacific/Apia"), "2011-12-29");
  assert.equal(activityDateInTimezone(new Date(Date.parse(w.endUtc) - 1), "Pacific/Apia"), "2011-12-29");
});

test("activityDayWindow gives an entirely skipped civil date no interval", () => {
  // 2011-12-30 never occurred in Pacific/Apia: the date-line jump went
  // 2011-12-29 23:59:59-10:00 → 2011-12-31 00:00:00+14:00. The skipped
  // date's nominal start and 2011-12-31's start both resolve to that jump
  // instant, so its window is zero-width [jump, jump). A date that never
  // occurred owns no interval: it must not adopt 2011-12-31's, which
  // double-attributed the 31st's cards to two daily totals and made
  // connector syncs for the skipped date fetch the 31st's records.
  const w = activityDayWindow("2011-12-30", "Pacific/Apia");
  assert.equal(w.startUtc, "2011-12-30T10:00:00.000Z"); // the jump instant
  assert.equal(w.endUtc, w.startUtc); // zero-width: syncs nothing
  // The 31st keeps its OWN window; no interval is shared with the skip.
  const dec31 = activityDayWindow("2011-12-31", "Pacific/Apia");
  assert.equal(dec31.startUtc, "2011-12-30T10:00:00.000Z");
  assert.equal(dec31.endUtc, "2011-12-31T10:00:00.000Z");
  assert.notDeepEqual(w, dec31);
});

test("activityDayWindow resolves second-granularity transitions exactly (Asia/Manila 1844)", () => {
  // Manila's 1844 date-line change carried seconds: LMT −15:56:08 ran until
  // 1844-12-31T15:56:08Z, then the wall clock read 1845-01-01T00:00:00 —
  // civil 1844-12-31 never existed. Offsets with a seconds component must not
  // truncate to whole minutes: pre-fix, the skipped date owned a 60000 ms
  // window starting locally on 1844-12-30, and the neighbors' bounds missed
  // the true transition by up to a minute.
  const transition = "1844-12-31T15:56:08.000Z";
  const skip = activityDayWindow("1844-12-31", "Asia/Manila");
  assert.equal(skip.startUtc, transition); // zero-width: syncs nothing
  assert.equal(skip.endUtc, transition);
  const before = activityDayWindow("1844-12-30", "Asia/Manila");
  assert.equal(before.startUtc, "1844-12-30T15:56:08.000Z"); // local midnight at LMT −15:56:08
  assert.equal(before.endUtc, transition);
  const after = activityDayWindow("1845-01-01", "Asia/Manila");
  assert.equal(after.startUtc, transition);
  assert.equal(after.endUtc, "1845-01-01T15:56:08.000Z");
  // Consistency at the skip instant: the transition is the first instant of
  // 1845-01-01, and the last pre-transition instant still belongs to Dec 30.
  assert.equal(activityDateInTimezone(new Date(transition), "Asia/Manila"), "1845-01-01");
  assert.equal(activityDateInTimezone(new Date(Date.parse(transition) - 1), "Asia/Manila"), "1844-12-30");
  assert.equal(activityDateInTimezone(new Date(Date.parse(before.endUtc) - 1), "Asia/Manila"), "1844-12-30");
});

test("activityDayWindow pads pre-1000 years before the local-date comparison", () => {
  // Intl.DateTimeFormat formats years before 1000 unpadded: the year 0999
  // comes back as "999". Pre-fix, `localStamp` rejected the valid midnight
  // ("999-01-01T00:00:00" ≠ "0999-01-01T00:00:00") and the fallback's
  // lexicographic comparison treated "998-12-31" as ≥ "0999-01-01", so
  // activityDayWindow("0999-01-01", "UTC") resolved its start to
  // 0998-12-31T00:00:00.000Z — fetching and attributing an extra day.
  const w = activityDayWindow("0999-01-01", "UTC");
  assert.equal(w.startUtc, "0999-01-01T00:00:00.000Z");
  assert.equal(w.endUtc, "0999-01-02T00:00:00.000Z");
});

test("timeline keeps a second machine's span even with the same app/window", () => {
  const a = snap({ machine: "A", capturedAtUtc: "2026-03-10T14:00:00.000Z", app: "Chrome", windowTitle: "Doc", contentHash: "a1", text: "" });
  const b = snap({ machine: "B", capturedAtUtc: "2026-03-10T14:00:30.000Z", app: "Chrome", windowTitle: "Doc", contentHash: "b1", text: "" });
  const body = composeActivityDigestBody("2026-03-10", "UTC", [a, b]);
  // machine is part of the timeline-span key, so the same app/window on a
  // different machine is not coalesced away.
  const timelineLines = body.split("\n").filter((line) => line.startsWith("- ["));
  assert.equal(timelineLines.length, 2);
});

test("machine labels with YAML-special chars round-trip through the digest", () => {
  const body = composeActivityDigestBody("2026-03-10", "UTC", DAY);
  const meta = composeActivityDigestMeta("2026-03-10", ["alpha, beta", "macstudio"], DAY, body);
  const parsed = parseActivityDigest(serializeActivityDigest(meta, body));
  assert.deepEqual(parsed?.meta.machines, ["alpha, beta", "macstudio"]);
});
