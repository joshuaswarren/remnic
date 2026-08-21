/**
 * `remnic timeline` binary command (issue #1983 PR1) — extracted from index.ts
 * so the entrypoint stays under its structural ceiling. Range/search/publish
 * all live in @remnic/core's shared runner, so the binary dispatches the same
 * implementation as the host CLI tree. Tests inject in-memory cards; this host
 * path loads config only and passes `cards: null` when no fixture is supplied.
 */
import fs from "node:fs";
import {
  parseConfig,
  resolveRemnicConfigRecord,
  runTimelineCliCommand,
} from "@remnic/core";
import type { PluginConfig } from "@remnic/core";
import { resolveConfigPath } from "../index.js";

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
      { cards: null, qa, timelineEnabled, config },
      timelineArgs,
      { stdout: process.stdout, stderr: process.stderr },
    );
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
