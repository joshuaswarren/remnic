/**
 * `remnic journal` command (issues #1984, #1987).
 *
 * show | edit-path | seed [--date] [--force]. The mode branch is
 * centralized in runJournalCommand: `timeline.journal.source` decides where
 * journal text lives. Vault mode is READ-ONLY — show prints the vault
 * section with a provenance header, edit-path prints the vault note path,
 * seed refuses (the vault note template owns scaffolding; #1985 ownership
 * rule). Journal extraction (extractionMode "review") is a library pass in
 * @remnic/core (activity/journal-extract.ts) wired by maintenance surfaces;
 * this command surface stays read-only.
 */
import fs from "node:fs";
import {
  journalPath,
  parseConfig,
  readJournalForDate,
  resolveRemnicConfigRecord,
  seedJournal,
  todayJournalDate,
  type PluginConfig,
} from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

export interface JournalCommandIo {
  out(line: string): void;
  err(line: string): void;
}

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

function journalHelp(): string {
  return `Usage: remnic journal <show|edit-path|seed> [--date YYYY-MM-DD] [--force]

  show       Print the journal for the date (default: today). Vault mode
             prints a provenance header naming the vault note first.
  edit-path  Print the journal file path (vault mode: the vault note path).
  seed       Write the file only if it is absent (memoryDir mode only).
`;
}

export async function runJournalCommand(
  config: PluginConfig,
  rest: string[],
  io: JournalCommandIo,
): Promise<number> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.out(journalHelp().trimEnd());
    return 0;
  }
  const action = rest[0];
  const date = takeFlag(rest, "--date") ?? todayJournalDate();
  const force = rest.includes("--force");
  const journalConfig = config.activity.timeline.journal;
  const vaultMode = journalConfig.source === "vault";

  if (action === "edit-path") {
    if (vaultMode) {
      const read = readJournalForDate({
        vault: config.activity.timeline.vault,
        date,
        timezone: config.activity.timezone,
      });
      io.out(read.filePath);
      return 0;
    }
    io.out(journalPath(config.memoryDir, date));
    return 0;
  }

  if (action === "show") {
    if (vaultMode) {
      const read = readJournalForDate({
        vault: config.activity.timeline.vault,
        date,
        timezone: config.activity.timezone,
      });
      if (!read.ok) {
        io.err(`journal: cannot read the vault note (${read.reason}): ${read.filePath}`);
        return 1;
      }
      if (!read.exists) {
        io.out(`exists:false (${read.reason})`);
        return 0;
      }
      // Provenance header naming the file (issue #1987): review UIs and
      // humans can trace the text back to the exact vault note.
      io.out(`# journal source: ${read.filePath} :: ${read.heading}`);
      io.out(read.text);
      return 0;
    }
    const filePath = journalPath(config.memoryDir, date);
    if (!fs.existsSync(filePath)) {
      io.err(`journal: no file at ${filePath}. Run remnic journal seed --date ${date}.`);
      return 1;
    }
    io.out(fs.readFileSync(filePath, "utf8").trimEnd());
    return 0;
  }

  if (action === "seed") {
    if (vaultMode) {
      io.err(
        'journal: seed is not available when activity.timeline.journal.source is "vault" — ' +
          "the vault daily note owns the journal section and Remnic never writes to it. " +
          "Create the note/section in your vault (or your vault note template) instead.",
      );
      return 1;
    }
    if (!journalConfig.enabled) {
      io.err("journal: timeline.journal.enabled is false — enable the journal before seeding.");
      return 1;
    }
    const result = seedJournal({ memoryDir: config.memoryDir, date, force });
    io.out(result.wrote ? `wrote ${result.path}` : `unchanged ${result.path}`);
    return 0;
  }

  io.err(`journal: unknown action "${action}".`);
  io.err(journalHelp().trimEnd());
  return 1;
}

export async function runJournalBinaryCommand(rest: string[]): Promise<void> {
  let config: PluginConfig;
  try {
    // Config failures get a constant message: parseConfig error strings can
    // embed config values (CodeQL js/clear-text-logging), so they must never
    // reach console output.
    const configPath = resolveConfigPath();
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    config = parseConfig(resolveRemnicConfigRecord(raw));
  } catch {
    console.error(
      "journal: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const code = await runJournalCommand(config, rest, {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
