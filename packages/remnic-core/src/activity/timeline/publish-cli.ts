/**
 * Shared `timeline publish` implementation (issue #1985).
 *
 * Both CLI trees dispatch this one function: the host command group in
 * `cli/timeline-publish-commands.ts` and the standalone binary's shared
 * runner in `timeline/query.ts`. A documented command that exists on only
 * one tree is a defect — the shipped `@remnic/cli` binary must publish too.
 */
import { existsSync, readFileSync } from "node:fs";

import type { PluginConfig } from "../../types.js";
import { activityDateInTimezone, isValidActivityDate } from "../digest.js";
import { journalPath } from "../journal.js";
import { publishVaultNote, type VaultSectionPublish } from "../vault-publisher.js";

export interface TimelinePublishIo {
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
}

export interface TimelinePublishOptions {
  date?: unknown;
  week?: unknown;
  what?: unknown;
  dryRun?: unknown;
}

const AVAILABLE_KINDS = ["timeline"] as const;
const KNOWN_KINDS = ["timeline", "standup", "weekly", "locations"] as const;
const UNLANDED_REASONS: Record<string, string> = {
  standup: "the standup renderer lands with timeline phase 3",
  weekly: "the weekly review renderer lands with timeline phase 4",
  locations: "the location day renderer is not wired to publishing yet",
};

export function runTimelinePublishCli(
  config: PluginConfig,
  options: TimelinePublishOptions,
  io: TimelinePublishIo,
): number {
  const vault = config.activity?.timeline?.vault;

  if (options.week !== undefined) {
    io.stderr.write("--week is not available yet: the weekly review renderer lands with timeline phase 4.\n");
    return 1;
  }
  if (!vault || vault.enabled !== true) {
    io.stderr.write(
      "Vault publishing is disabled: set activity.timeline.vault.enabled=true and configure vaultPath first.\n",
    );
    return 1;
  }

  // An explicitly empty --date is invalid, not absent (issue #2917): ""
  // can never be a day, and silently falling back to today would publish
  // the wrong note. Only a missing --date means "today".
  if (options.date !== undefined && (typeof options.date !== "string" || options.date.length === 0)) {
    io.stderr.write(`Invalid --date ${JSON.stringify(options.date ?? "")}; expected YYYY-MM-DD.\n`);
    return 1;
  }
  // Timeline artifacts are grouped on the configured activity timezone's
  // calendar day, so "today" must be derived there — the host-local day
  // drifts by one near either timezone's midnight.
  const date =
    typeof options.date === "string" && options.date.length > 0
      ? options.date
      : activityDateInTimezone(new Date(), config.activity?.timezone ?? "UTC");
  if (!isValidActivityDate(date)) {
    io.stderr.write(`Invalid --date "${date}"; expected YYYY-MM-DD.\n`);
    return 1;
  }

  const requested = parseKinds(typeof options.what === "string" && options.what.length > 0 ? options.what : "timeline");
  if (typeof requested !== "string") {
    io.stderr.write(requested.error);
    return 1;
  }
  const kinds = requested.split(",");
  const sections: VaultSectionPublish[] = [];
  let notePathTemplate = vault.dailyNotePath;

  for (const kind of kinds) {
    if ((AVAILABLE_KINDS as readonly string[]).indexOf(kind) === -1) {
      io.stderr.write(`--what ${kind} is not available yet: ${UNLANDED_REASONS[kind] ?? "unknown kind"}.\n`);
      return 1;
    }
    const target = vault.publish[kind as "timeline"];
    if (target.enabled !== true) {
      io.stderr.write(`--what ${kind} is disabled: enable activity.timeline.vault.publish.${kind}.enabled.\n`);
      return 1;
    }
    // Honor the target's configured note file; config parsing already
    // rejects target="weekly" with an empty weeklyNotePath.
    notePathTemplate = target.target === "weekly" ? vault.weeklyNotePath : vault.dailyNotePath;
    const source = journalPath(config.memoryDir, date);
    if (!existsSync(source)) {
      io.stderr.write(
        `No timeline artifact for ${date}: run the journal recap generation first (${kind} target reads the persisted day recap).\n`,
      );
      return 1;
    }
    sections.push({ name: target.section, content: readFileSync(source, "utf8").trimEnd() });
  }

  const status = publishVaultNote({
    vaultPath: vault.vaultPath,
    notePathTemplate,
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
    const label = row.outcome === "updated" && options.dryRun === true ? "would update" : row.outcome;
    io.stdout.write(`${label}  ${row.path}${row.reason ? `  (${row.reason})` : ""}\n`);
  }
  io.stdout.write(
    `updated=${status.counts.updated} unchanged=${status.counts.unchanged} skipped=${status.counts.skipped} error=${status.counts.error}\n`,
  );
  return status.hasError ? 1 : 0;
}

/**
 * `--what` is normalized to a comma-joined kind list. An empty normalized
 * list (`--what ','`) is rejected here rather than reaching the publisher,
 * which throws a RangeError on a zero-length section list.
 */
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
  if (kinds.length === 0) {
    return { error: `--what must name at least one artifact; valid kinds are ${KNOWN_KINDS.join(", ")}.\n` };
  }
  return kinds.join(",");
}
