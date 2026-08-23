/**
 * `remnic journal` binary command (issue #1984 PR1).
 *
 * show | edit-path | seed [--date] [--force]. File I/O lives in
 * `@remnic/core` seedJournal — this file only parses flags and prints.
 */
import fs from "node:fs";
import {
  journalPath,
  parseConfig,
  resolveRemnicConfigRecord,
  seedJournal,
  todayJournalDate,
} from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}

function journalHelp(): string {
  return `Usage: remnic journal <show|edit-path|seed> [--date YYYY-MM-DD] [--force]

  show       Print the journal file for the date (default: today).
  edit-path  Print the journal file path.
  seed       Write the file only if it is absent. --force overwrites.
`;
}

function loadMemoryDir(): string {
  const configPath = resolveConfigPath();
  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  return parseConfig(resolveRemnicConfigRecord(raw)).memoryDir;
}

export async function runJournalBinaryCommand(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    console.log(journalHelp());
    return;
  }
  let memoryDir: string;
  try {
    // Config failures get a constant message: parseConfig error strings can
    // embed config values (CodeQL js/clear-text-logging), so they must never
    // reach console output.
    memoryDir = loadMemoryDir();
  } catch {
    console.error(
      "journal: failed to load the Remnic config — run `remnic doctor` and check the config file for errors",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const action = rest[0];
    const date = takeFlag(rest, "--date") ?? todayJournalDate();
    const force = rest.includes("--force");
    const filePath = journalPath(memoryDir, date);
    if (action === "edit-path") {
      console.log(filePath);
      return;
    }
    if (action === "show") {
      if (!fs.existsSync(filePath)) {
        console.error(`journal: no file at ${filePath}. Run remnic journal seed --date ${date}.`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(fs.readFileSync(filePath, "utf8"));
      return;
    }
    if (action === "seed") {
      const result = seedJournal({ memoryDir, date, force });
      console.log(result.wrote ? `wrote ${result.path}` : `unchanged ${result.path}`);
      return;
    }
    console.error(`journal: unknown action "${action}".`);
    console.error(journalHelp());
    process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
