/**
 * Timeline command group (issue #1985) — `remnic timeline publish` writes
 * the day's timeline artifact into the user's markdown vault through the
 * managed-region publisher. The command BODY lives in
 * `activity/timeline/publish-cli.ts` so the standalone `@remnic/cli` binary
 * dispatches the same implementation through the shared timeline runner.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { runTimelinePublishCli } from "../activity/timeline/publish-cli.js";

export function registerTimelineCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const timelineCmd = cmd
    .command("timeline")
    .description("Timeline artifacts: publish the day's recap into a markdown vault (issue #1985)");

  timelineCmd
    .command("publish")
    .description("Publish timeline artifacts into the vault daily note via managed regions")
    .option("--date <date>", "Local day to publish (YYYY-MM-DD; defaults to today)")
    .option("--week <week>", "ISO week to publish (YYYY-Www)")
    .option("--what <kinds>", "Comma-separated artifacts to publish (default: timeline)")
    .option("--dry-run", "Report per-file outcomes without writing")
    .action((...args: unknown[]) => {
      // Commander passes declared positional args before the options
      // object; `publish` declares none, so a stray positional would
      // displace the options object and silently publish with defaults
      // (issue #2917). Reject any string arg outright.
      if (args.some((arg) => typeof arg === "string")) {
        process.stderr.write("timeline publish takes no positional arguments.\n");
        process.exitCode = 1;
        return;
      }
      const options = (args[0] ?? {}) as Record<string, unknown>;
      const code = runTimelinePublishCli(orchestrator.config, options, {
        stdout: process.stdout,
        stderr: process.stderr,
      });
      if (code !== 0) process.exitCode = code;
    });
}

