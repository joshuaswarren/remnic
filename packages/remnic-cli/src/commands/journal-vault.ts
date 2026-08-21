/**
 * `remnic journal-vault show --file <path> --section <heading>` (#1987 CLI slice).
 *
 * Read-only. Prints the stripped vault-journal section or `exists:false`.
 * Duplicate headings exit non-zero and list line numbers.
 */
import fs from "node:fs";
import { readVaultJournal } from "@remnic/core";
import { resolveFlag } from "../cli-args.js";

export interface JournalVaultIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const defaultIo: JournalVaultIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

export function journalVaultHelp(): string {
  return `Usage: remnic journal-vault show --file <path> --section <heading>

  show  Print the stripped journal section. Missing file or heading prints exists:false.
`;
}

export function runJournalVaultCommand(rest: string[], io: JournalVaultIo = defaultIo): number {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.stdout(journalVaultHelp().trimEnd());
    return 0;
  }
  if (rest[0] !== "show") {
    io.stderr(`journal-vault: unknown action "${rest[0]}".`);
    io.stderr(journalVaultHelp().trimEnd());
    return 1;
  }

  const filePath = resolveFlag(rest, "--file");
  const section = resolveFlag(rest, "--section");
  if (filePath === undefined || section === undefined) {
    io.stderr("journal-vault: show requires --file <path> and --section <heading>");
    return 1;
  }

  let fileText: string | null = null;
  try {
    fileText = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      io.stderr(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const result = readVaultJournal({ fileText, journalSection: section });
  if (!result.ok) {
    io.stderr(`journal-vault: duplicate heading at lines ${result.lines.join(", ")}`);
    return 1;
  }
  if (!result.exists) {
    io.stdout("exists:false");
    return 0;
  }
  io.stdout(result.text);
  return 0;
}

export async function runJournalVaultBinaryCommand(rest: string[]): Promise<void> {
  const code = runJournalVaultCommand(rest);
  if (code !== 0) process.exitCode = code;
}
