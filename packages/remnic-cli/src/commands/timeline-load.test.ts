/**
 * Production timeline card loader regressions (PR #2871 P1s):
 * an unbounded `timeline search` must load every stored historical day,
 * and a bounded window must load only its explicit span.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ActivityStore, parseConfig } from "@remnic/core";
import type { ActivitySnapshot, PluginConfig } from "@remnic/core";

import { loadProductionTimelineCards } from "./timeline.js";

const NOW = () => new Date("2026-08-23T12:00:00.000Z");

function configFor(memoryDir: string, timelineEnabled = true): PluginConfig {
  return parseConfig({
    memoryDir,
    activity: { timezone: "UTC", timeline: { enabled: timelineEnabled } },
  });
}

function snap(capturedAtUtc: string, contentHash: string): ActivitySnapshot {
  return {
    machine: "ws-a",
    capturedAtUtc,
    app: "editor",
    windowTitle: "main.ts",
    text: "deterministic fixture text",
    textSource: "ax",
    contentHash,
  };
}

function dayKeys(cards: readonly { dayKey: string }[]): string[] {
  return [...new Set(cards.map((card) => card.dayKey))].sort();
}

test("unbounded search loads every stored historical day, not only today", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timeline-load-"));
  try {
    const store = ActivityStore.open(memoryDir);
    store.insertSnapshot(snap("2026-08-23T10:00:00.000Z", "h-today"));
    store.insertSnapshot(snap("2026-08-20T10:00:00.000Z", "h-3d"));
    store.insertSnapshot(snap("2026-07-10T10:00:00.000Z", "h-old"));
    store.close();
    const cards = await loadProductionTimelineCards(configFor(memoryDir), {}, NOW);
    assert.ok(Array.isArray(cards));
    assert.deepEqual(dayKeys(cards as { dayKey: string }[]), ["2026-07-10", "2026-08-20", "2026-08-23"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a bounded window loads only its explicit span", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timeline-load-"));
  try {
    const store = ActivityStore.open(memoryDir);
    store.insertSnapshot(snap("2026-08-23T10:00:00.000Z", "h-today"));
    store.insertSnapshot(snap("2026-08-20T10:00:00.000Z", "h-3d"));
    store.close();
    const cards = await loadProductionTimelineCards(
      configFor(memoryDir),
      { from: "2026-08-20T00:00:00.000Z", to: "2026-08-21T00:00:00.000Z" },
      NOW,
    );
    assert.ok(Array.isArray(cards));
    assert.deepEqual(dayKeys(cards as { dayKey: string }[]), ["2026-08-20"]);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("a disabled timeline and an empty store both load without error", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-timeline-load-"));
  try {
    const disabled = await loadProductionTimelineCards(configFor(memoryDir, false), {}, NOW);
    assert.equal(disabled, null);
    const empty = await loadProductionTimelineCards(configFor(memoryDir), {}, NOW);
    assert.ok(Array.isArray(empty));
    assert.deepEqual(empty, []);
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
