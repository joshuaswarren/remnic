import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncLocationDay, sanitizeProviderError } from "./pipeline.js";
import { parseLocationConfig } from "./config.js";
import { locationDayFilePath, locationSyncStateFilePath, loadLocationSyncState } from "./store.js";
import type { LocationConfig, LocationObservation, LocationProvider } from "./types.js";

function config(overrides: Record<string, unknown> = {}): LocationConfig {
  return parseLocationConfig({
    enabled: true,
    sources: [{ id: "fixture" }],
    ...overrides,
  });
}

function observationAt(observedAtUtc: string, placeId: string): LocationObservation {
  return {
    observedAtUtc,
    place: { id: placeId, label: placeId === "home" ? "Home" : placeId, latitude: 41.8781, longitude: -87.6298 },
  };
}

function provider(
  pages: LocationObservation[][],
  options: { failWith?: Error } = {},
): LocationProvider {
  return {
    id: "fixture",
    displayName: "Fixture",
    async verify() {
      return { ok: true };
    },
    async fetchObservations() {
      if (options.failWith !== undefined) throw options.failWith;
      const remaining = pages.splice(0, 1);
      return { observations: remaining[0] ?? [], nextCursor: null };
    },
  };
}

const REGISTRY = new Map<string, LocationProvider>();
function withProviders(providers: LocationProvider[]): (id: string) => LocationProvider | undefined {
  REGISTRY.clear();
  for (const item of providers) REGISTRY.set(item.id, item);
  return (id: string) => REGISTRY.get(id);
}

test("the master gate short-circuits every path: no providers, no filesystem", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    let fetches = 0;
    const getProvider = withProviders([
      {
        id: "fixture",
        displayName: "Fixture",
        async verify() {
          return { ok: true };
        },
        async fetchObservations() {
          fetches += 1;
          return { observations: [], nextCursor: null };
        },
      },
    ]);
    const disabled = parseLocationConfig({ enabled: false, sources: [{ id: "fixture" }] });
    const results = await syncLocationDay({ config: disabled, memoryDir, date: "2026-08-17", getProvider });
    assert.deepEqual(results, []);
    assert.equal(fetches, 0);
    await assert.rejects(() => access(locationSyncStateFilePath(memoryDir)), /ENOENT/);
    await assert.rejects(() => access(locationDayFilePath(memoryDir, "2026-08-17")), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a disabled source is skipped without contacting its provider", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    let fetches = 0;
    const getProvider = withProviders([
      {
        id: "fixture",
        displayName: "Fixture",
        async verify() {
          return { ok: true };
        },
        async fetchObservations() {
          fetches += 1;
          return { observations: [], nextCursor: null };
        },
      },
    ]);
    const results = await syncLocationDay({
      config: config({ sources: [{ id: "fixture", enabled: false }] }),
      memoryDir,
      date: "2026-08-17",
      getProvider,
    });
    assert.deepEqual(results, [
      {
        sourceId: "fixture",
        status: "skipped",
        skipReason: "source-disabled",
        fetched: 0,
        dayWritten: false,
        stateSaved: false,
      },
    ]);
    assert.equal(fetches, 0);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a configured source whose provider is not registered is skipped, not failed", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const results = await syncLocationDay({
      config: config(),
      memoryDir,
      date: "2026-08-17",
      getProvider: () => undefined,
    });
    assert.equal(results[0]?.status, "skipped");
    assert.equal(results[0]?.skipReason, "provider-not-registered");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a successful sync writes the day document and only then advances state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const getProvider = withProviders([
      provider([[observationAt("2026-08-17T09:00:00Z", "home"), observationAt("2026-08-17T12:00:00Z", "office")]]),
    ]);
    const results = await syncLocationDay({
      config: config(),
      memoryDir,
      date: "2026-08-17",
      getProvider,
      now: () => new Date("2026-08-18T00:00:05.000Z"),
    });
    assert.deepEqual(
      results.map((result) => [result.status, result.fetched, result.dayWritten, result.stateSaved]),
      [["synced", 2, true, true]],
    );
    const day = await readFile(locationDayFilePath(memoryDir, "2026-08-17"), "utf-8");
    assert.match(day, /kind: "location-day"/);
    assert.match(day, /Home: 3h 00m/);
    assert.doesNotMatch(day, /41\.8781/, "coordinates are not persisted unless retention is enabled");
    const state = await loadLocationSyncState(memoryDir);
    assert.equal(state.sources.fixture?.lastSyncedAtUtc, "2026-08-18T00:00:05.000Z");
    assert.equal(state.sources.fixture?.days?.["2026-08-17"]?.observationCount, 2);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("an empty fetch is a successful sync, not a provider failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const getProvider = withProviders([provider([[]])]);
    const results = await syncLocationDay({ config: config(), memoryDir, date: "2026-08-17", getProvider });
    assert.deepEqual(
      results.map((result) => [result.status, result.fetched, result.dayWritten, result.stateSaved, result.error]),
      [["synced", 0, false, true, undefined]],
    );
    await assert.rejects(() => access(locationDayFilePath(memoryDir, "2026-08-17")), /ENOENT/);
    const state = await loadLocationSyncState(memoryDir);
    assert.notEqual(state.sources.fixture, undefined, "state advances for an empty day");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a provider failure fails only that source and never advances its state", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const getProvider = withProviders([
      provider([], { failWith: new Error("Bearer sk-live-abc123 failed at http://api.example/v1?key=hunter2 near 41.8781,-87.6298") }),
      (() => {
        const healthy = provider([[observationAt("2026-08-17T08:00:00Z", "gym")]]);
        return { ...healthy, id: "healthy", displayName: "Healthy" };
      })(),
    ]);
    const results = await syncLocationDay({
      config: config({ sources: [{ id: "fixture" }, { id: "healthy" }] }),
      memoryDir,
      date: "2026-08-17",
      getProvider,
    });
    const failed = results.find((result) => result.sourceId === "fixture")!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.stateSaved, false);
    assert.doesNotMatch(failed.error ?? "", /sk-live-abc123|hunter2|41\.8781/);
    assert.match(failed.error ?? "", /\[redacted\]/);
    assert.match(failed.error ?? "", /\[coordinates\]/);
    const healthy = results.find((result) => result.sourceId === "healthy")!;
    assert.equal(healthy.status, "synced");
    const state = await loadLocationSyncState(memoryDir);
    assert.equal(state.sources.fixture, undefined, "the failed source's state was never written");
    assert.notEqual(state.sources.healthy, undefined);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("state is not advanced when the day write fails (durable write before state)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const memoryDir = path.join(root, "memory");
    await mkdir(memoryDir, { recursive: true });
    // A symlinked locations root fails containment BEFORE any write lands.
    await mkdir(path.join(root, "elsewhere"), { recursive: true });
    await symlink(path.join(root, "elsewhere"), path.join(memoryDir, "locations"));
    const getProvider = withProviders([provider([[observationAt("2026-08-17T09:00:00Z", "home")]])]);
    const results = await syncLocationDay({ config: config(), memoryDir, date: "2026-08-17", getProvider });
    assert.equal(results[0]?.status, "failed");
    assert.equal(results[0]?.stateSaved, false);
    await assert.rejects(() => access(locationSyncStateFilePath(memoryDir)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a re-sync of one source preserves the other sources' sections in the day file", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const alpha = { ...provider([[observationAt("2026-08-17T09:00:00Z", "home")]]), id: "alpha", displayName: "Alpha" };
    const beta = { ...provider([[observationAt("2026-08-17T13:00:00Z", "office")]]), id: "beta", displayName: "Beta" };
    let getProvider = withProviders([alpha, beta]);
    await syncLocationDay({
      config: config({ sources: [{ id: "alpha" }, { id: "beta" }] }),
      memoryDir,
      date: "2026-08-17",
      getProvider,
    });
    let day = await readFile(locationDayFilePath(memoryDir, "2026-08-17"), "utf-8");
    assert.match(day, /## Timeline — Alpha/);
    assert.match(day, /## Timeline — Beta/);

    // Re-sync only alpha with fresh observations; beta's section must survive
    // from sync state without contacting beta again.
    const alphaRefreshed = {
      ...provider([[observationAt("2026-08-17T09:00:00Z", "cafe")]]),
      id: "alpha",
      displayName: "Alpha",
    };
    getProvider = withProviders([alphaRefreshed]);
    const results = await syncLocationDay({
      config: config({ sources: [{ id: "alpha" }] }),
      memoryDir,
      date: "2026-08-17",
      getProvider,
    });
    assert.equal(results[0]?.status, "synced");
    day = await readFile(locationDayFilePath(memoryDir, "2026-08-17"), "utf-8");
    assert.match(day, /## Timeline — Alpha/);
    assert.match(day, /## Timeline — Beta/, "the untouched source's day payload survives from state");
    assert.match(day, /cafe/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("retainCoordinates: true persists coordinates end to end", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const getProvider = withProviders([provider([[observationAt("2026-08-17T09:00:00Z", "home")]])]);
    await syncLocationDay({
      config: config({ retainCoordinates: true }),
      memoryDir,
      date: "2026-08-17",
      getProvider,
    });
    const day = await readFile(locationDayFilePath(memoryDir, "2026-08-17"), "utf-8");
    assert.match(day, /@ 41\.8781,-87\.6298/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("malformed provider output is rejected loudly", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-location-pipeline-"));
  try {
    const broken: LocationProvider = {
      id: "fixture",
      displayName: "Fixture",
      async verify() {
        return { ok: true };
      },
      async fetchObservations() {
        return {
          observations: [{ observedAtUtc: "garbage", place: { id: "home", label: "Home" } }],
          nextCursor: null,
        };
      },
    };
    const results = await syncLocationDay({
      config: config(),
      memoryDir,
      date: "2026-08-17",
      getProvider: withProviders([broken]),
    });
    assert.equal(results[0]?.status, "failed");
    await assert.rejects(() => access(locationSyncStateFilePath(memoryDir)), /ENOENT/);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("sanitizeProviderError strips credentials, query strings, and coordinates", () => {
  const sanitized = sanitizeProviderError(
    new Error("GET http://x.example/v1?token=sekrit failed: Bearer abc.def.ghi at 41.878113,-87.629798"),
  );
  assert.doesNotMatch(sanitized, /sekrit|abc\.def\.ghi|41\.878113/);
  assert.match(sanitized, /\[redacted\]/);
  assert.match(sanitized, /\[coordinates\]/);
});
