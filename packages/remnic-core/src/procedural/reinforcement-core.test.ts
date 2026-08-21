import assert from "node:assert/strict";
import test from "node:test";

import { clusterByKey, summarizeCluster } from "./reinforcement-core.js";

interface Sample {
  id: string;
  group: string;
  ts: string;
}

test("clusterByKey returns empty map for empty input", () => {
  const out = clusterByKey<Sample>([], (s) => s.group);
  assert.equal(out.size, 0);
});

test("clusterByKey returns a single cluster when all items share a key", () => {
  const items: Sample[] = [
    { id: "a", group: "g1", ts: "2026-04-01T00:00:00Z" },
    { id: "b", group: "g1", ts: "2026-04-02T00:00:00Z" },
    { id: "c", group: "g1", ts: "2026-04-03T00:00:00Z" },
  ];
  const out = clusterByKey(items, (s) => s.group);
  assert.equal(out.size, 1);
  const cluster = out.get("g1");
  assert.ok(cluster);
  assert.equal(cluster.length, 3);
  // Preserves input order
  assert.deepEqual(
    cluster.map((s) => s.id),
    ["a", "b", "c"],
  );
});

test("clusterByKey splits items into multiple clusters by key", () => {
  const items: Sample[] = [
    { id: "a", group: "g1", ts: "2026-04-01T00:00:00Z" },
    { id: "b", group: "g2", ts: "2026-04-02T00:00:00Z" },
    { id: "c", group: "g1", ts: "2026-04-03T00:00:00Z" },
    { id: "d", group: "g3", ts: "2026-04-04T00:00:00Z" },
    { id: "e", group: "g2", ts: "2026-04-05T00:00:00Z" },
  ];
  const out = clusterByKey(items, (s) => s.group);
  assert.equal(out.size, 3);
  assert.deepEqual(out.get("g1")?.map((s) => s.id), ["a", "c"]);
  assert.deepEqual(out.get("g2")?.map((s) => s.id), ["b", "e"]);
  assert.deepEqual(out.get("g3")?.map((s) => s.id), ["d"]);
  // First-seen insertion order
  assert.deepEqual(Array.from(out.keys()), ["g1", "g2", "g3"]);
});

test("clusterByKey throws TypeError when keyFn returns a non-string", () => {
  const items = [{ id: "a" }];
  assert.throws(
    () => clusterByKey(items, () => undefined as unknown as string),
    (err: Error) => err instanceof TypeError && /must return a string/.test(err.message),
  );
  assert.throws(
    () => clusterByKey(items, () => null as unknown as string),
    (err: Error) => err instanceof TypeError && /null/.test(err.message),
  );
  assert.throws(
    () => clusterByKey(items, () => 42 as unknown as string),
    (err: Error) => err instanceof TypeError && /number/.test(err.message),
  );
});

test("summarizeCluster throws RangeError on empty cluster", () => {
  assert.throws(
    () => summarizeCluster<Sample>([], (s) => s.ts),
    (err: Error) => err instanceof RangeError,
  );
});

test("summarizeCluster computes count and firstSeen/lastSeen for single-item cluster", () => {
  const items: Sample[] = [{ id: "a", group: "g", ts: "2026-04-01T00:00:00Z" }];
  const out = summarizeCluster(items, (s) => s.ts);
  assert.equal(out.count, 1);
  assert.equal(out.firstSeen, "2026-04-01T00:00:00Z");
  assert.equal(out.lastSeen, "2026-04-01T00:00:00Z");
});

test("summarizeCluster finds min/max regardless of input order", () => {
  const items: Sample[] = [
    { id: "b", group: "g", ts: "2026-04-15T00:00:00Z" },
    { id: "a", group: "g", ts: "2026-04-01T00:00:00Z" },
    { id: "c", group: "g", ts: "2026-04-30T00:00:00Z" },
    { id: "d", group: "g", ts: "2026-04-10T00:00:00Z" },
  ];
  const out = summarizeCluster(items, (s) => s.ts);
  assert.equal(out.count, 4);
  assert.equal(out.firstSeen, "2026-04-01T00:00:00Z");
  assert.equal(out.lastSeen, "2026-04-30T00:00:00Z");
});

test("summarizeCluster handles all-equal timestamps", () => {
  const ts = "2026-04-25T12:00:00Z";
  const items: Sample[] = [
    { id: "a", group: "g", ts },
    { id: "b", group: "g", ts },
    { id: "c", group: "g", ts },
  ];
  const out = summarizeCluster(items, (s) => s.ts);
  assert.equal(out.count, 3);
  assert.equal(out.firstSeen, ts);
  assert.equal(out.lastSeen, ts);
});

test("summarizeCluster works with non-ISO string keys via localeCompare", () => {
  // Simple lexicographic ordering — extractTimestamp can return any string.
  const items = [{ k: "b" }, { k: "a" }, { k: "c" }];
  const out = summarizeCluster(items, (s) => s.k);
  assert.equal(out.firstSeen, "a");
  assert.equal(out.lastSeen, "c");
});

test("clusterByKey + summarizeCluster compose for end-to-end summarization", () => {
  const items: Sample[] = [
    { id: "a", group: "g1", ts: "2026-04-01T00:00:00Z" },
    { id: "b", group: "g2", ts: "2026-04-02T00:00:00Z" },
    { id: "c", group: "g1", ts: "2026-04-10T00:00:00Z" },
    { id: "d", group: "g1", ts: "2026-04-05T00:00:00Z" },
  ];
  const clusters = clusterByKey(items, (s) => s.group);
  const g1 = summarizeCluster(clusters.get("g1") ?? [], (s) => s.ts);
  assert.equal(g1.count, 3);
  assert.equal(g1.firstSeen, "2026-04-01T00:00:00Z");
  assert.equal(g1.lastSeen, "2026-04-10T00:00:00Z");
  const g2 = summarizeCluster(clusters.get("g2") ?? [], (s) => s.ts);
  assert.equal(g2.count, 1);
  assert.equal(g2.firstSeen, g2.lastSeen);
});
