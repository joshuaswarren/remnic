import assert from "node:assert/strict";
import { test } from "node:test";

import {
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
