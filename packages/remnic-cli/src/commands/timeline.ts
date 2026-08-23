/**
 * `remnic timeline` binary command (issue #1983 PR1) — extracted from index.ts
 * so the entrypoint stays under its structural ceiling. Range/search/publish
 * all live in @remnic/core's shared runner, so the binary dispatches the same
 * implementation as the host CLI tree. Production range/search call
 * regenerateTimelineDay; tests inject in-memory cards.
 */
import fs from "node:fs";
import {
  ActivityStore,
  activityDateInTimezone,
  localDatesForUtcRange,
  parseConfig,
  regenerateTimelineDay,
  resolveRemnicConfigRecord,
  runTimelineCliCommand,
} from "@remnic/core";
import type { PluginConfig, TimelineCard } from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

async function loadProductionTimelineCards(
  config: PluginConfig,
  window: { from?: string; to?: string },
): Promise<TimelineCard[] | null> {
  const timeline = config.activity.timeline;
  if (!timeline.enabled) return null;
  const timezone = config.activity.timezone;
  const fromMs = window.from === undefined ? Date.now() : Date.parse(window.from);
  const toMs = window.to === undefined ? fromMs + 1 : Date.parse(window.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const dates =
    window.from === undefined && window.to === undefined
      ? [activityDateInTimezone(new Date(), timezone)]
      : localDatesForUtcRange(fromMs, Number.isFinite(toMs) && toMs > fromMs ? toMs : fromMs + 1, timezone);
  const store = ActivityStore.open(config.memoryDir);
  try {
    const cards: TimelineCard[] = [];
    for (const date of dates) {
      const result = await regenerateTimelineDay({
        date,
        timezone,
        memoryDir: config.memoryDir,
        store,
        timelineEnabled: true,
        analysis: timeline.analysis,
        pluginConfig: config,
      });
      cards.push(...result.cards);
    }
    return cards;
  } finally {
    store.close();
  }
}

export async function runTimelineBinaryCommand(rest: string[]): Promise<void> {
  const timelineArgs =
    rest.length === 0 || rest[0] === "--help" || rest[0] === "-h"
      ? ["help"]
      : rest;
  try {
    let qa = { enabled: false, maxRangeDays: 31 };
    let timelineEnabled = false;
    let config: PluginConfig | undefined;
    try {
      const configPath = resolveConfigPath();
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      config = parseConfig(resolveRemnicConfigRecord(raw));
      timelineEnabled = config.activity.timeline.enabled;
      qa = config.activity.timeline.qa;
    } catch {
      console.error(
        "timeline: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
      );
      process.exitCode = 1;
      return;
    }
    const code = await runTimelineCliCommand(
      {
        cards: null,
        qa,
        timelineEnabled,
        config,
        loadCards: (window) => loadProductionTimelineCards(config, window),
      },
      timelineArgs,
      { stdout: process.stdout, stderr: process.stderr },
    );
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
