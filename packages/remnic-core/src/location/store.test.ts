import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composeLocationDayBody,
  composeLocationDayMeta,
  emptyLocationSyncState,
  listLocationDayDates,
  loadLocationSyncState,
  locationDayFilePath,
  locationSyncStateFilePath,
  parseLocationDaySummary,
  serializeLocationDay,
  updateLocationSourceDay,
  writeLocationDay,
} from "./store.js";
import type { LocationDaySourceEntry } from "./store.js";

function entry(overrides: Partial<LocationDaySourceEntry> = {}): LocationDaySourceEntry {
  return {
    observationCount: 1,
    segments: [
      {
        startUtc: "2026-08-17T09:00:00.000Z",
        endUtc: "2026-08-17T09:30:00.000Z",
        place: { id: "home", label: "Home" },
      },
    ],
    ...overrides,
  };
}

test("day rendering is deterministic across source-map insertion order", () => {
  const a: Record<string, LocationDaySourceEntry> = {
    reitti: entry({ providerDisplayName: "Reitti" }),
    other: entry({
      providerDisplayName: "Other",
      observationCount: 0,
      segments: [],
    }),
  };
  const b: Record<string, LocationDaySourceEntry> = {
    other: entry({ providerDisplayName: "Other", observationCount: 0, segments: [] }),
    reitti: entry({ providerDisplayName: "Reitti" }),
  };
  const render = (sources: Record<string, LocationDaySourceEntry>) => {
    const body = composeLocationDayBody("2026-08-17", "UTC", sources);
    return serializeLocationDay(composeLocationDayMeta("2026-08-17", "UTC", sources, body), body);
  };
  const first = render(a);
  const second = render(b);
  assert.equal(first, second, "identical content renders byte-identical regardless of key order");
  const reparsed = parseLocationDaySummary(first);
  assert.deepEqual(reparsed, {
    date: "2026-08-17",
    timezone: "UTC",
    sources: ["other", "reitti"],
    observationCount: 1,
    contentHash: parseLocationDaySummary(second)!.contentHash,
  });
  assert.equal(parseLocationDaySummary("# not a location day\n"), null);
});

test("writeLocationDay is idempotent and read-back verifies content", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-store-"));
  try {
    const body = composeLocationDayBody("2026-08-17", "UTC", { reitti: entry() });
    const serialized = serializeLocationDay(
      composeLocationDayMeta("2026-08-17", "UTC", { reitti: entry() }, body),
      body,
    );
    assert.equal(await writeLocationDay(memoryDir, "2026-08-17", serialized), true);
    assert.equal(await writeLocationDay(memoryDir, "2026-08-17", serialized), false, "unchanged content rewrites nothing");
    assert.equal(await readFile(locationDayFilePath(memoryDir, "2026-08-17"), "utf-8"), serialized);
    assert.deepEqual(await listLocationDayDates(memoryDir), ["2026-08-17"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("locationDayFilePath rejects traversal-shaped dates", () => {
  assert.throws(() => locationDayFilePath("/tmp/x", "../../etc/passwd"), RangeError);
  assert.throws(() => locationDayFilePath("/tmp/x", "2026-13-01"), RangeError);
});

test("store rejects a symlinked locations directory even when it resolves inside memoryDir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-location-symlink-"));
  try {
    const memoryDir = path.join(root, "memory");
    const target = path.join(root, "elsewhere");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, path.join(memoryDir, "locations"));
    await assert.rejects(
      () => writeLocationDay(memoryDir, "2026-08-17", "---\nkind: location-day\n"),
      /symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects a symlinked day file that escapes the memory dir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-location-symlinkfile-"));
  try {
    const memoryDir = path.join(root, "memory");
    await mkdir(path.join(memoryDir, "locations"), { recursive: true });
    await writeFile(path.join(root, "secret.md"), "outside", "utf-8");
    await symlink(path.join(root, "secret.md"), path.join(memoryDir, "locations", "2026-08-17.md"));
    await assert.rejects(
      () => writeLocationDay(memoryDir, "2026-08-17", "---\nkind: location-day\n"),
      /outside the memory dir|symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sync state cold-starts on absence and corrupt JSON, then persists atomically", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-state-"));
  try {
    assert.deepEqual(await loadLocationSyncState(memoryDir), emptyLocationSyncState());
    await mkdir(path.dirname(locationSyncStateFilePath(memoryDir)), { recursive: true });
    await writeFile(locationSyncStateFilePath(memoryDir), "{not json", "utf-8");
    assert.deepEqual(await loadLocationSyncState(memoryDir), emptyLocationSyncState());
    await updateLocationSourceDay(memoryDir, "reitti", "2026-08-17", entry(), "2026-08-18T00:00:05.000Z");
    const state = await loadLocationSyncState(memoryDir);
    assert.equal(state.sources.reitti?.lastSyncedAtUtc, "2026-08-18T00:00:05.000Z");
    assert.equal(state.sources.reitti?.days?.["2026-08-17"]?.observationCount, 1);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("concurrent source state updates do not lose each other", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-concurrent-"));
  try {
    await Promise.all([
      updateLocationSourceDay(memoryDir, "reitti", "2026-08-17", entry(), "2026-08-18T00:00:01.000Z"),
      updateLocationSourceDay(memoryDir, "other", "2026-08-17", entry({ observationCount: 2 }), "2026-08-18T00:00:02.000Z"),
      updateLocationSourceDay(memoryDir, "third", "2026-08-16", entry(), "2026-08-18T00:00:03.000Z"),
    ]);
    const state = await loadLocationSyncState(memoryDir);
    assert.deepEqual(Object.keys(state.sources).sort(), ["other", "reitti", "third"]);
    assert.equal(state.sources.reitti?.days?.["2026-08-17"]?.observationCount, 1);
    assert.equal(state.sources.other?.days?.["2026-08-17"]?.observationCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("day payloads prune beyond the retention cap, newest kept", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-prune-"));
  try {
    for (let day = 0; day < 95; day += 1) {
      const date = new Date(Date.UTC(2026, 5, 1) + day * 86_400_000).toISOString().slice(0, 10);
      await updateLocationSourceDay(memoryDir, "reitti", date, entry(), "2026-09-01T00:00:00.000Z");
    }
    const state = await loadLocationSyncState(memoryDir);
    const days = Object.keys(state.sources.reitti?.days ?? {});
    assert.equal(days.length, 90);
    assert.equal(days.includes("2026-06-01"), false, "oldest days pruned");
    assert.equal(days.includes("2026-06-06"), true, "newest 90 days kept");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
