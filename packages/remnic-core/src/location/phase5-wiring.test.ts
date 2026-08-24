/**
 * Phase-5 wiring regression (issue #2925): the existing location subsystem
 * feeding wearables, day summaries, and briefings — conservatively.
 *
 * Pins the contract the umbrella issue (#2043) requires:
 *   - wearable location fill is missing-only and never overwrites a
 *     source-provided value;
 *   - conflicting / below-threshold overlaps stay untagged;
 *   - absent, disabled, or unrequested location changes NOTHING (the
 *     stored transcript body and gathered day summary are byte-identical);
 *   - day summaries and briefings expose place names only behind the
 *     explicit includeLocation request flag plus both location gates;
 *   - labels only — coordinates never reach any phase-5 output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { StorageManager } from "../storage.js";
import { WorkspaceOpsCoordinator, type WorkspaceOpsDeps } from "../orchestration/workspace-ops.js";
import type { PluginConfig } from "../types.js";
import type {
  WearableConversation,
  WearableSourceConnector,
  WearableSourceSettings,
  WearablesConfig,
} from "../wearables/types.js";
import { defaultWearableSourceSettings, defaultWearablesConfig } from "../wearables/config.js";
import { parseDayTranscript } from "../wearables/day-store.js";
import { syncWearableSource, type WearableSyncDeps } from "../wearables/pipeline.js";
import { parseLocationConfig } from "./config.js";
import { saveLocationSyncState } from "./store.js";
import type { LocationConfig, LocationSegment } from "./types.js";
import { briefingLocationSection } from "./tagging.js";

const NOW = new Date("2026-06-11T03:00:00.000Z");

function locationConfig(overrides: Record<string, unknown> = {}): LocationConfig {
  return parseLocationConfig({
    enabled: true,
    timezone: "UTC",
    sources: [{ id: "reitti" }],
    tagging: { enabled: true },
    ...overrides,
  });
}

function segment(
  startUtc: string,
  endUtc: string,
  label: string,
  kind: LocationSegment["place"]["kind"] = "poi",
): LocationSegment {
  return {
    startUtc,
    endUtc,
    place: {
      id: `reitti:place:${label.toLowerCase().replace(/\s+/g, "-")}`,
      label,
      kind,
      latitude: 60.1699,
      longitude: 24.9384,
    },
    confidence: 0.9,
  };
}

async function seedLocationDays(memoryDir: string, days: Record<string, LocationSegment[]>) {
  await saveLocationSyncState(memoryDir, {
    version: 1,
    sources: {
      reitti: {
        days: Object.fromEntries(
          Object.entries(days).map(([date, segments]) => [
            date,
            { observationCount: segments.length, segments },
          ]),
        ),
      },
    },
  });
}
function wearableSettings(): WearableSourceSettings {
  return { ...defaultWearableSourceSettings(), enabled: true };
}

function wearablesConfig(timezone = "UTC"): WearablesConfig {
  return {
    ...defaultWearablesConfig(),
    enabled: true,
    timezone,
    digestEnabled: false,
    offTheRecordEnabled: false,
  };
}

function conversation(
  id: string,
  startIso: string,
  endIso: string,
  overrides: Partial<WearableConversation> = {},
): WearableConversation {
  return {
    id,
    source: "testsource",
    title: `Conversation ${id}`,
    startIso,
    endIso,
    segments: [{ speakerKey: "user", speakerName: "user", isWearer: true, text: "Synthetic wearable text." }],
    ...overrides,
  };
}

function fakeConnector(byDate: Record<string, WearableConversation[]>): WearableSourceConnector {
  return {
    id: "testsource",
    displayName: "Test Source",
    async verifyAuth() {
      return { ok: true };
    },
    async fetchConversations(opts: { date: string }) {
      return { conversations: byDate[opts.date] ?? [], nextCursor: null };
    },
  };
}

function makeSyncDeps(
  memoryDir: string,
  now: Date,
  locationConfigValue?: LocationConfig,
): { deps: WearableSyncDeps; written: Array<{ source: string; date: string; serialized: string }> } {
  const written: Array<{ source: string; date: string; serialized: string }> = [];
  const deps: WearableSyncDeps = {
    memoryDir,
    async readDayContentHash() {
      return null;
    },
    writeDayTranscript(source, date, serialized) {
      written.push({ source, date, serialized });
      return Promise.resolve();
    },
    memoryGen: null,
    now: () => now,
    ...(locationConfigValue !== undefined ? { locationConfig: locationConfigValue } : {}),
  };
  return { deps, written };
}

function bodyOf(serialized: string): string {
  const parsed = parseDayTranscript(serialized);
  assert.ok(parsed, "day transcript parses");
  return parsed.body;
}

// ── Wearable fill ───────────────────────────────────────────────────────────

test("wearable sync fills only missing conversation locations from a dominant overlap", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-phase5-fill-"));
  try {
    await seedLocationDays(memoryDir, {
      "2026-06-11": [segment("2026-06-11T14:30:00.000Z", "2026-06-11T16:00:00.000Z", "Coffee shop")],
    });
    const { deps, written } = makeSyncDeps(memoryDir, NOW, locationConfig());
    const connector = fakeConnector({
      "2026-06-11": [
        conversation("c-missing", "2026-06-11T15:00:00.000Z", "2026-06-11T15:30:00.000Z"),
        conversation("c-source", "2026-06-11T15:00:00.000Z", "2026-06-11T15:30:00.000Z", {
          location: "Office rooftop",
        }),
      ],
    });

    await syncWearableSource(connector, wearableSettings(), wearablesConfig(), { days: 1 }, deps);

    assert.equal(written.length, 1, "day transcript written");
    const body = bodyOf(written[0].serialized);
    assert.ok(body.includes("*Location: Coffee shop*"), "missing location filled from the dominant match");
    const sourceSection = body.slice(body.indexOf("Conversation c-source"));
    assert.ok(sourceSection.includes("*Location: Office rooftop*"), "source-provided location kept");
    assert.ok(!sourceSection.includes("Coffee shop"), "source-provided value not overwritten");
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("conflicting and below-threshold overlaps leave wearable locations unfilled", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-phase5-threshold-"));
  try {
    await seedLocationDays(memoryDir, {
      // Two equal-overlap places → ambiguous (conflict).
      "2026-06-11": [
        segment("2026-06-11T15:00:00.000Z", "2026-06-11T15:15:00.000Z", "Diner"),
        segment("2026-06-11T15:15:00.000Z", "2026-06-11T15:30:00.000Z", "Gym"),
      ],
      // A 2-minute overlap only → below the 300s floor.
      "2026-06-12": [segment("2026-06-12T15:28:00.000Z", "2026-06-12T16:30:00.000Z", "Library")],
    });
    const { deps, written } = makeSyncDeps(memoryDir, new Date("2026-06-12T03:00:00.000Z"), locationConfig());
    const connector = fakeConnector({
      "2026-06-11": [conversation("c-ambiguous", "2026-06-11T15:00:00.000Z", "2026-06-11T15:30:00.000Z")],
      "2026-06-12": [conversation("c-short", "2026-06-12T15:00:00.000Z", "2026-06-12T15:30:00.000Z")],
    });

    await syncWearableSource(connector, wearableSettings(), wearablesConfig(), { days: 2 }, deps);

    assert.equal(written.length, 2, "both days written");
    const bodies = written.map((entry) => bodyOf(entry.serialized));
    assert.ok(
      !bodies.some((body) => body.includes("*Location:")),
      `no location line written: ${bodies.join("\n---\n")}`,
    );
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("wearable sync output is byte-identical without location config or with tagging disabled", async () => {
  const run = async (locationConfigValue?: LocationConfig) => {
    const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-phase5-zerodiff-"));
    try {
      if (locationConfigValue) {
        await seedLocationDays(memoryDir, {
          "2026-06-11": [segment("2026-06-11T14:30:00.000Z", "2026-06-11T16:00:00.000Z", "Coffee shop")],
        });
      }
      const { deps, written } = makeSyncDeps(memoryDir, NOW, locationConfigValue);
      const connector = fakeConnector({
        "2026-06-11": [conversation("c1", "2026-06-11T15:00:00.000Z", "2026-06-11T15:30:00.000Z")],
      });
      await syncWearableSource(connector, wearableSettings(), wearablesConfig(), { days: 1 }, deps);
      assert.equal(written.length, 1);
      return bodyOf(written[0].serialized);
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
    }
  };

  const baseline = await run(undefined);
  const disabled = await run(locationConfig({ tagging: { enabled: false } }));
  assert.equal(disabled, baseline, "tagging disabled → identical transcript body");
  assert.ok(!baseline.includes("*Location:"), "no location line by default");
});

test("wearable fill resolves the day bucket across a midnight boundary in the location timezone", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-phase5-midnight-"));
  try {
    // America/New_York: conversation 2026-06-30T03:30Z–04:30Z is
    // 23:30–00:30 local, spanning the June-29 / June-30 midnight. The only
    // qualifying segment (00:00–01:00 local) lives on the June-30 bucket —
    // the conversation's END-anchored day, not its start day. The fill must
    // consult both day keys, not just the start day.
    const nyConfig = locationConfig({ timezone: "America/New_York" });
    await seedLocationDays(memoryDir, {
      "2026-06-30": [segment("2026-06-30T04:00:00.000Z", "2026-06-30T05:00:00.000Z", "Late diner")],
    });
    const { deps, written } = makeSyncDeps(memoryDir, new Date("2026-07-01T03:00:00.000Z"), nyConfig);
    const connector = fakeConnector({
      "2026-06-30": [conversation("c-span", "2026-06-30T03:30:00.000Z", "2026-06-30T04:30:00.000Z")],
    });

    await syncWearableSource(
      connector,
      wearableSettings(),
      wearablesConfig("America/New_York"),
      { date: "2026-06-30" },
      deps,
    );

    assert.equal(written.length, 1);
    const body = bodyOf(written[0].serialized);
    assert.ok(body.includes("*Location: Late diner*"), `cross-midnight segment matched: ${body}`);
  } finally {
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

// ── Day summary opt-in ──────────────────────────────────────────────────────

function opsCoordinator(storage: StorageManager, configOverrides: Partial<PluginConfig>) {
  return new WorkspaceOpsCoordinator({
    config: {
      defaultNamespace: "default",
      daySummaryTimezone: "UTC",
      ...configOverrides,
    } as unknown as PluginConfig,
    storageRouter: {
      storageFor: async () => storage,
    },
  } as unknown as WorkspaceOpsDeps);
}

test("gatherTodayFacts appends location context only when requested and gated", async () => {
  const gather = async (options: { includeLocation?: boolean; location?: LocationConfig }) => {
    const root = mkdtempSync(path.join(tmpdir(), "remnic-phase5-summary-"));
    try {
      const storage = new StorageManager(root);
      await storage.writeMemory("fact", "Shipped the location wiring.", { source: "test" });
      if (options.location) {
        const day = new Date().toISOString().slice(0, 10);
        await seedLocationDays(root, {
          [day]: [segment(`${day}T09:00:00.000Z`, `${day}T17:00:00.000Z`, "Office", "work")],
        });
      }
      const coordinator = opsCoordinator(storage, options.location ? { location: options.location } : {});
      return await coordinator.gatherTodayFacts(undefined, {
        now: new Date(),
        timeZone: "UTC",
        ...(options.includeLocation !== undefined ? { includeLocation: options.includeLocation } : {}),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // Each gather run writes a fresh fact id/timestamp header; normalize it
  // away so byte-comparisons isolate the location delta.
  const normalized = (gathered: string) => gathered.replace(/^\[fact-[^\]]*\] \([^)]*\)/gm, "[fact]");

  const enabled = locationConfig();
  const baseline = await gather({});
  const withStateNoFlag = await gather({ location: enabled });
  assert.equal(normalized(withStateNoFlag), normalized(baseline), "no request flag → byte-identical gathered summary");

  const withFlagNoState = await gather({ includeLocation: true });
  assert.equal(normalized(withFlagNoState), normalized(baseline), "flag without location state → byte-identical");

  const withFlag = await gather({ includeLocation: true, location: enabled });
  assert.ok(withFlag.includes("## Location context"), "opt-in adds the location section");
  assert.ok(withFlag.includes("- Office: 8h 00m"), "labels and durations only");

  const flagButTaggingOff = await gather({
    includeLocation: true,
    location: locationConfig({ tagging: { enabled: false } }),
  });
  assert.equal(normalized(flagButTaggingOff), normalized(baseline), "flag with tagging disabled → byte-identical");
});

// ── Briefing opt-in ─────────────────────────────────────────────────────────

test("briefingLocationSection is opt-in, start-day anchored, and labels-only", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remnic-phase5-briefing-"));
  try {
    const day = new Date().toISOString().slice(0, 10);
    await seedLocationDays(root, {
      [day]: [
        segment(`${day}T08:00:00.000Z`, `${day}T18:00:00.000Z`, "HQ", "work"),
        segment(`${day}T18:00:00.000Z`, `${day}T19:00:00.000Z`, "Commuter rail", "transit"),
      ],
    });

    const gatedOff = await briefingLocationSection(
      root,
      new Date().toISOString(),
      locationConfig({ tagging: { enabled: false } }),
    );
    assert.equal(gatedOff, null, "tagging disabled → no section");

    const section = await briefingLocationSection(root, new Date().toISOString(), locationConfig());
    assert.ok(section, "gated on → section rendered");
    assert.ok(section.includes("## Location context"));
    assert.ok(section.includes("- HQ: 10h 00m"), "work place rendered with duration");
    assert.ok(!section.includes("Commuter rail"), "transit-only place excluded");

    const none = await briefingLocationSection(
      root,
      new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
      locationConfig(),
    );
    assert.equal(none, null, "window start on a day without segments → no section");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Privacy ─────────────────────────────────────────────────────────────────

test("phase-5 outputs never contain coordinates or raw location records", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "remnic-phase5-privacy-"));
  try {
    const day = new Date().toISOString().slice(0, 10);
    // Segment places carry coordinates (as if retainCoordinates had been on
    // at ingestion) — every phase-5 surface must still render labels only.
    await seedLocationDays(root, {
      [day]: [segment(`${day}T08:00:00.000Z`, `${day}T18:00:00.000Z`, "HQ", "work")],
    });

    const section = await briefingLocationSection(root, new Date().toISOString(), locationConfig());
    assert.ok(section);
    assert.ok(!/\d+\.\d{3,}/.test(section), `no coordinate-like numbers: ${section}`);
    assert.ok(!section.includes("startUtc") && !section.includes("observationCount"), "no raw record fields");

    const storage = new StorageManager(root);
    await storage.writeMemory("fact", "Privacy probe fact.", { source: "test" });
    const coordinator = opsCoordinator(storage, { location: locationConfig() });
    const gathered = await coordinator.gatherTodayFacts(undefined, {
      now: new Date(),
      timeZone: "UTC",
      includeLocation: true,
    });
    assert.ok(!gathered.includes("60.1699") && !gathered.includes("24.9384"), "no coordinates in day-summary input");
    assert.ok(!gathered.includes("latitude") && !gathered.includes("longitude"), "no coordinate field names");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
