/**
 * Timeline command group (issue #1985) — `remnic timeline publish` writes
 * the day's timeline artifact into the user's markdown vault through the
 * managed-region publisher. Standup, weekly, and locations targets are
 * rejected here with a named reason until their phases land; the publisher
 * mechanism itself is live for the targets that have data on main.
 */

import { existsSync, readFileSync } from "node:fs";

import type { Orchestrator } from "../orchestrator.js";
import type { CliCommand } from "../cli.js";
import { journalPath } from "../activity/journal.js";
import { publishVaultNote } from "../activity/vault-publisher.js";
import type { VaultSectionPublish } from "../activity/vault-publisher.js";
import { isValidActivityDate } from "../activity/digest.js";

const AVAILABLE_KINDS = ["timeline"] as const;
const KNOWN_KINDS = ["timeline", "standup", "weekly", "locations"] as const;
const UNLANDED_REASONS: Record<string, string> = {
  standup: "the standup renderer lands with timeline phase 3",
  weekly: "the weekly review renderer lands with timeline phase 4",
  locations: "the location day renderer is not wired to publishing yet",
};

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
    .action(async (...args: unknown[]) => {
      const options = (args[0] ?? {}) as Record<string, unknown>;
      const code = await runTimelinePublish(orchestrator, options);
      if (code !== 0) process.exitCode = code;
    });
}

async function runTimelinePublish(
  orchestrator: Orchestrator,
  options: Record<string, unknown>,
): Promise<number> {
  const config = orchestrator.config;
  const vault = config.activity?.timeline?.vault;

  if (options.week !== undefined) {
    process.stderr.write("--week is not available yet: the weekly review renderer lands with timeline phase 4.\n");
    return 1;
  }
  if (!vault || vault.enabled !== true) {
    process.stderr.write(
      "Vault publishing is disabled: set activity.timeline.vault.enabled=true and configure vaultPath first.\n",
    );
    return 1;
  }

  const date = typeof options.date === "string" && options.date.length > 0 ? options.date : localToday();
  if (!isValidActivityDate(date)) {
    process.stderr.write(`Invalid --date "${date}"; expected YYYY-MM-DD.\n`);
    return 1;
  }

  const requested = parseKinds(typeof options.what === "string" && options.what.length > 0 ? options.what : "timeline");
  if (typeof requested !== "string") {
    process.stderr.write(requested.error);
    return 1;
  }
  const kinds = requested === "" ? [] : requested.split(",");
  const sections: VaultSectionPublish[] = [];

  for (const kind of kinds) {
    if ((AVAILABLE_KINDS as readonly string[]).indexOf(kind) === -1) {
      process.stderr.write(`--what ${kind} is not available yet: ${UNLANDED_REASONS[kind] ?? "unknown kind"}.\n`);
      return 1;
    }
    const target = vault.publish[kind as "timeline"];
    if (target.enabled !== true) {
      process.stderr.write(`--what ${kind} is disabled: enable activity.timeline.vault.publish.${kind}.enabled.\n`);
      return 1;
    }
    const source = journalPath(config.memoryDir, date);
    if (!existsSync(source)) {
      process.stderr.write(`No timeline artifact for ${date}: run the journal recap generation first (${kind} target reads the persisted day recap).\n`);
      return 1;
    }
    sections.push({ name: target.section, content: readFileSync(source, "utf8").trimEnd() });
  }

  const status = publishVaultNote({
    vaultPath: vault.vaultPath,
    notePathTemplate: vault.dailyNotePath,
    date,
    sections,
    strategy: vault.sectionStrategy,
    insertUnderHeading: vault.insertUnderHeading.length > 0 ? vault.insertUnderHeading : undefined,
    createMissingNotes: vault.createMissingNotes,
    noteTemplate: vault.noteTemplate.length > 0 ? vault.noteTemplate : undefined,
    propertiesMode: vault.properties.mode,
    propertiesPrefix: vault.properties.prefix,
    dryRun: options.dryRun === true,
  });

  for (const row of status.results) {
    const label =
      row.outcome === "updated" && options.dryRun === true ? "would update" : row.outcome;
    process.stdout.write(`${label}  ${row.path}${row.reason ? `  (${row.reason})` : ""}\n`);
  }
  process.stdout.write(
    `updated=${status.counts.updated} unchanged=${status.counts.unchanged} skipped=${status.counts.skipped} error=${status.counts.error}\n`,
  );
  return status.hasError ? 1 : 0;
}

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseKinds(raw: string): string | { error: string } {
  const kinds = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  for (const kind of kinds) {
    if ((KNOWN_KINDS as readonly string[]).indexOf(kind) === -1) {
      return { error: `Unknown --what kind "${kind}"; valid kinds are ${KNOWN_KINDS.join(", ")}.\n` };
    }
  }
  if (new Set(kinds).size !== kinds.length) {
    return { error: "--what must not repeat a kind.\n" };
  }
  return kinds.join(",");
}
