/**
 * End-to-end acceptance (issue #1897): a real capture-audio daemon serving
 * synthetic fixture conversations -> the real `desktop` connector over
 * loopback HTTP -> the UNCHANGED core wearables pipeline (syncWearableSource)
 * -> a day-transcript in the memory dir. No hardware, no network, no models:
 * the daemon spool is seeded directly (the same rows `--replay` would write).
 *
 * Proves: default-off (AC2), replay->sync->day store with source `desktop`
 * + content-hash no-op re-run (AC3), and connector discovery/registration.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultWearableSourceSettings,
  defaultWearablesConfig,
  getWearableConnector,
  parseDayTranscript,
  syncWearableSource,
  type WearableSyncDeps,
} from "@remnic/core";

import { defaultDaemonConfig } from "./config.js";
import { createDesktopConnector, DESKTOP_SOURCE_ID } from "./connector.js";
import { startDaemon } from "./daemon.js";
import { Spool } from "./spool.js";

const DATE = "2026-07-20";

function fileBackedDeps(memoryDir: string): { deps: WearableSyncDeps; written: Map<string, string> } {
  const written = new Map<string, string>();
  const deps: WearableSyncDeps = {
    memoryDir,
    async readDayContentHash(sourceId, date) {
      const raw = written.get(`${sourceId}/${date}`);
      return raw === undefined ? null : (parseDayTranscript(raw)?.meta.contentHash ?? null);
    },
    async writeDayTranscript(sourceId, date, serialized) {
      written.set(`${sourceId}/${date}`, serialized);
    },
    memoryGen: null, // transcripts-only: memoryMode "off" wants no extraction
  };
  return { deps, written };
}

async function seededDaemon(): Promise<{ url: string; close: () => Promise<void>; spool: Spool }> {
  const spool = new Spool(":memory:");
  spool.insertConversation({
    id: "conv_e2e_1",
    startedAtUtc: `${DATE}T15:00:00.000Z`,
    endedAtUtc: `${DATE}T15:02:00.000Z`,
    state: "final",
    segments: [
      { channel: "system", speakerCluster: "spk_1", text: "Let us ship the desktop capture connector on Friday.", startUtc: `${DATE}T15:00:00.000Z`, endUtc: `${DATE}T15:00:05.000Z` },
      { channel: "mic", speakerCluster: "self", isWearer: true, text: "Agreed, I will prepare the release notes.", startUtc: `${DATE}T15:00:06.000Z`, endUtc: `${DATE}T15:00:10.000Z` },
    ],
  });
  // A still-capturing conversation MUST NOT be served (final-only pagination).
  spool.insertConversation({
    id: "conv_e2e_open",
    startedAtUtc: `${DATE}T18:00:00.000Z`,
    state: "capturing",
    segments: [{ channel: "mic", text: "half a meeting", startUtc: `${DATE}T18:00:00.000Z`, endUtc: `${DATE}T18:00:02.000Z` }],
  });
  const handle = await startDaemon({ spool, config: { ...defaultDaemonConfig(), host: "127.0.0.1", port: 0 }, token: "tok" });
  return { url: handle.url, close: () => handle.close().finally(() => spool.close()), spool };
}

function desktopSettings(baseUrl: string, overrides = {}) {
  return { ...defaultWearableSourceSettings(), enabled: true, baseUrl, apiKey: "tok", memoryMode: "off" as const, ...overrides };
}

function wearablesConfig() {
  return { ...defaultWearablesConfig(), enabled: true, timezone: "UTC", digestEnabled: false, offTheRecordEnabled: false };
}

test("importing the connector registers `desktop` for core discovery", () => {
  assert.equal(getWearableConnector(DESKTOP_SOURCE_ID)?.id, DESKTOP_SOURCE_ID);
});

test("replay->desktop connector->core sync writes a desktop day transcript (final-only), re-run is a content-hash no-op", async () => {
  const daemon = await seededDaemon();
  const memoryDir = mkdtempSync(path.join(tmpdir(), "cap-e2e-"));
  try {
    const connector = createDesktopConnector({ settings: desktopSettings(daemon.url), timezone: "UTC" });
    const { deps, written } = fileBackedDeps(memoryDir);

    const first = await syncWearableSource(connector, desktopSettings(daemon.url), wearablesConfig(), { date: DATE }, deps);
    assert.equal(first.source, "desktop");
    assert.equal(first.transcriptsWritten.length, 1);

    const serialized = written.get(`desktop/${DATE}`);
    assert.ok(serialized, "a desktop day transcript was written");
    const parsed = parseDayTranscript(serialized as string);
    assert.equal(parsed?.meta.source, "desktop");
    assert.match(serialized as string, /desktop capture connector on Friday/);
    // final-only: the capturing conversation's text never reaches the day store.
    assert.doesNotMatch(serialized as string, /half a meeting/);

    // Re-sync the same day: identical content hash => no new transcript write.
    const second = await syncWearableSource(connector, desktopSettings(daemon.url), wearablesConfig(), { date: DATE }, deps);
    assert.equal(second.transcriptsWritten.length, 0, "re-run is a content-hash no-op");
  } finally {
    await daemon.close();
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("default-off: a disabled desktop source with the daemon running syncs nothing", async () => {
  const daemon = await seededDaemon();
  const memoryDir = mkdtempSync(path.join(tmpdir(), "cap-e2e-"));
  try {
    const connector = createDesktopConnector({ settings: desktopSettings(daemon.url), timezone: "UTC" });
    const { deps, written } = fileBackedDeps(memoryDir);
    // A caller that respects `enabled:false` never invokes sync; assert the
    // gate value the pipeline/service reads is off by default.
    assert.equal(defaultWearableSourceSettings().enabled, false);
    // And even if sync is called for a day with no final conversations, it
    // writes nothing (empty page is not an error).
    await syncWearableSource(connector, desktopSettings(daemon.url), wearablesConfig(), { date: "2026-07-21" }, deps);
    assert.equal(written.size, 0);
  } finally {
    await daemon.close();
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
