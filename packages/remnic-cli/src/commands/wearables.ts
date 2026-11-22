/**
 * `remnic wearables` binary command — extracted from index.ts in #2047 so
 * the entrypoint keeps shrinking under its structural ceiling (same move as
 * the meetings extraction). Behaviour is identical to the inline
 * `case "wearables"` it replaces: parsing, validation, and rendering live in
 * @remnic/core's shared runner; connector packages stay optional à-la-carte
 * installs loaded inside core via computed-specifier dynamic imports.
 */

import fs from "node:fs";
import {
  Orchestrator,
  parseConfig,
  resolveRemnicConfigRecord,
  runWearablesCliCommand,
} from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

export async function runWearablesBinaryCommand(rest: string[]): Promise<void> {
  const wearablesArgs =
    rest.length === 0 || rest[0] === "--help" || rest[0] === "-h"
      ? ["help"]
      : rest;
  let wearablesOrchestrator: Orchestrator | undefined;
  try {
    let wearablesService: ReturnType<Orchestrator["getWearablesService"]>;
    try {
      const configPath = resolveConfigPath();
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      const config = parseConfig(resolveRemnicConfigRecord(raw));
      wearablesOrchestrator = new Orchestrator(config);
      await wearablesOrchestrator.initialize();
      await wearablesOrchestrator.deferredReady;
      wearablesService = wearablesOrchestrator.getWearablesService();
    } catch {
      console.error(
        "wearables: failed to load the Remnic config or start the memory engine — run `remnic doctor` and check the config file for errors",
      );
      process.exitCode = 1;
      return;
    }
    const code = await runWearablesCliCommand(wearablesService, wearablesArgs, {
      stdout: process.stdout,
      stderr: process.stderr,
    });
    if (wearablesArgs[0] === "sync" && code === 0 && wearablesOrchestrator.config.meetings.enabled) {
      await (await wearablesOrchestrator.getMeetingsService()).flushBuilds();
    }
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (wearablesOrchestrator) {
      const maybeShutdown = (
        wearablesOrchestrator as unknown as { shutdown?: () => Promise<void> }
      ).shutdown;
      if (typeof maybeShutdown === "function") {
        try {
          await maybeShutdown.call(wearablesOrchestrator);
        } catch {
          // Best effort — shutdown errors must not mask command results.
        }
      }
    }
  }
}
