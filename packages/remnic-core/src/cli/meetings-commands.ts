/**
 * Meetings command group (issue #1900) — extracted from cli.ts so the surface
 * file stays under its structural ceiling. Mirrors the
 * registerResearchStatusCommands / registerCreationLedgerCommands seam: a single
 * registrar wires the `meetings` command (list / show / build) on the parent
 * `engram` command.
 *
 * Every subcommand forwards to the shared runner in meetings/cli.ts so this host
 * CLI and the standalone `remnic` CLI never fork behavior or formatting.
 * Behaviour is identical to the inline registration it replaces — the
 * cli-command-surface contract tests guard against silent drift.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { runMeetingsCliCommand } from "../meetings/cli.js";

export function registerMeetingsCommands(cmd: CliCommand, orchestrator: Orchestrator): void {
  const meetingsCmd = cmd
    .command("meetings")
    .description(
      "Retrospective meetings: list records, show one, build (detect + fuse + store) a day",
    );
  const forwardMeetings = async (argv: string[]): Promise<void> => {
    const service = await orchestrator.getMeetingsService();
    const code = await runMeetingsCliCommand(
      { store: service.store, builder: service.builder, config: service.config },
      argv,
      { stdout: process.stdout, stderr: process.stderr },
    );
    if (code !== 0) process.exitCode = code;
  };

  meetingsCmd
    .command("list")
    .description("List meeting records (all days, or one day)")
    .option("--date <date>", "Day to list (YYYY-MM-DD)")
    .option("--json", "JSON output")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      await forwardMeetings([
        "list",
        ...(typeof options.date === "string" && options.date.length > 0
          ? ["--date", options.date]
          : []),
        ...(options.json === true ? ["--json"] : []),
      ]);
    });

  meetingsCmd
    .command("show <meeting-id>")
    .description("Print a stored meeting record")
    .action(async (...args: unknown[]) => {
      await forwardMeetings(["show", String(args[0] ?? "")]);
    });

  meetingsCmd
    .command("build")
    .description("Detect + fuse + store the day's meetings")
    .option("--date <date>", "Day to build (YYYY-MM-DD)")
    .option("--json", "JSON output")
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      await forwardMeetings([
        "build",
        ...(typeof options.date === "string" ? ["--date", options.date] : []),
        ...(options.json === true ? ["--json"] : []),
      ]);
    });
}
