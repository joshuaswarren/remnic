/**
 * `remnic meetings` binary command (issue #1900) — extracted from index.ts so
 * the entrypoint stays under its structural ceiling. Parsing, validation,
 * rendering, and `meetings.enabled` gating live in @remnic/core's shared runner
 * so this CLI and the OpenClaw host CLI never fork. Behaviour is identical to
 * the inline `case "meetings"` it replaces.
 */

import fs from "node:fs";
import {
  Orchestrator,
  parseConfig,
  resolveRemnicConfigRecord,
  runMeetingsCliCommand,
  type MeetingsService,
} from "@remnic/core";
import { resolveConfigPath } from "../index.js";

export async function runMeetingsBinaryCommand(rest: string[]): Promise<void> {
  const meetingsArgs =
    rest.length === 0 || rest[0] === "--help" || rest[0] === "-h"
      ? ["help"]
      : rest;
  let meetingsOrchestrator: Orchestrator | undefined;
  try {
    // Config/bootstrap failures get a constant message: parseConfig error
    // strings can embed config values (CodeQL js/clear-text-logging), so
    // they must never reach console output.
    let meetingsService: MeetingsService;
    try {
      const configPath = resolveConfigPath();
      const raw = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, "utf8"))
        : {};
      const config = parseConfig(resolveRemnicConfigRecord(raw));
      meetingsOrchestrator = new Orchestrator(config);
      await meetingsOrchestrator.initialize();
      await meetingsOrchestrator.deferredReady;
      meetingsService = await meetingsOrchestrator.getMeetingsService();
    } catch {
      console.error(
        "meetings: failed to load the Remnic config or start the memory engine — run `remnic doctor` and check the config file for errors",
      );
      process.exitCode = 1;
      return;
    }
    const code = await runMeetingsCliCommand(
      { store: meetingsService.store, builder: meetingsService.builder, config: meetingsService.config },
      meetingsArgs,
      { stdout: process.stdout, stderr: process.stderr },
    );
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    if (meetingsOrchestrator) {
      const maybeShutdown = (
        meetingsOrchestrator as unknown as { shutdown?: () => Promise<void> }
      ).shutdown;
      if (typeof maybeShutdown === "function") {
        try {
          await maybeShutdown.call(meetingsOrchestrator);
        } catch {
          // Best effort — shutdown errors must not mask command results.
        }
      }
    }
  }
}
