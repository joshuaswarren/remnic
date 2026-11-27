/**
 * `remnic journal` command (issues #1984, #1987).
 *
 * show | edit-path | seed | extract [--date] [--force]. The mode branch is
 * centralized in runJournalCommand: `timeline.journal.source` decides where
 * journal text lives. `timeline.journal.enabled` is the master gate — when
 * false every action refuses before any journal byte (vault note or
 * memoryDir day file) is read. An omitted `--date` means "today" in the
 * configured `activity.timezone`, not in the host's local zone.
 *
 * Vault notes stay READ-ONLY: show prints the vault section with a
 * provenance header, edit-path prints the vault note path, seed refuses
 * (the vault note template owns scaffolding; #1985 ownership rule).
 * extract runs the #1987 review-only pass from @remnic/core
 * (activity/journal-extract.ts): candidates land `pending_review` only,
 * never auto-approved, and unchanged days hash-skip.
 *
 * Extract writes through a resolved StorageManager from the CLI/orchestrator
 * (secure store, tombstones, namespace router). Constructing
 * `new StorageManager(memoryDir)` here is not permitted.
 */
import fs from "node:fs";
import {
  ExtractionEngine,
  Orchestrator,
  StorageManager,
  activityDateInTimezone,
  commitJournalHash,
  createJournalMemoryWriter,
  hashJournalText,
  journalPath,
  journalUnchanged,
  parseConfig,
  readJournalForDate,
  readTimelineState,
  resolveRemnicConfigRecord,
  runJournalReviewExtraction,
  seedJournal,
  withJournalDateLock,
  type JournalExtractionDeps,
  type PluginConfig,
} from "@remnic/core";
import type { BufferTurn } from "@remnic/core/types.js";
import { resolveConfigPath } from "../config-path.js";

export interface JournalCommandIo {
  out(line: string): void;
  err(line: string): void;
}

/** Injectable seam: note reads, extraction-pass deps, and the clock. */
export interface JournalCommandDeps {
  readJournal: typeof readJournalForDate;
  extractionDeps(): Promise<JournalExtractionDeps>;
  now(): Date;
}

function defaultDeps(config: PluginConfig, storage?: StorageManager): JournalCommandDeps {
  return {
    readJournal: readJournalForDate,
    async extractionDeps() {
      if (!storage) {
        throw new Error(
          "journal extract requires a resolved StorageManager from the orchestrator; constructing StorageManager(memoryDir) is not permitted",
        );
      }
      await storage.ensureDirectories();
      const engine = new ExtractionEngine(config, undefined, undefined, config.gatewayConfig);
      return {
        extract: (turns: BufferTurn[]) => engine.extract(turns),
        writer: createJournalMemoryWriter(storage),
      };
    },
    now: () => new Date(),
  };
}

export function createJournalCommandDeps(config: PluginConfig, storage: StorageManager): JournalCommandDeps {
  return defaultDeps(config, storage);
}

function takeFlag(rest: string[], name: string): string | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("-")) throw new Error(`${name} requires a value`);
  return value;
}


function journalHelp(): string {
  return `Usage: remnic journal <show|edit-path|seed|extract> [--date YYYY-MM-DD] [--force]

  show       Print the journal for the date (default: today in
             activity.timezone). Vault mode prints a provenance header
             naming the vault note first.
  edit-path  Print the journal file path (vault mode: the vault note path).
  seed       Write the file only if it is absent (memoryDir mode only).
  extract    Run the review-only extraction pass (requires
             activity.timeline.journal.extractionMode "review").
             Candidates land pending_review only — never auto-approved;
             an unchanged day is hash-skipped.
`;
}

export async function runJournalCommand(
  config: PluginConfig,
  rest: string[],
  io: JournalCommandIo,
  deps: JournalCommandDeps = defaultDeps(config),
): Promise<number> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    io.out(journalHelp().trimEnd());
    return 0;
  }
  const action = rest[0];
  const journalConfig = config.activity.timeline.journal;
  if (!journalConfig.enabled) {
    io.err("journal: timeline.journal.enabled is false — enable the journal first.");
    return 1;
  }
  const date = takeFlag(rest, "--date") ?? activityDateInTimezone(deps.now(), config.activity.timezone);
  const force = rest.includes("--force");
  const vaultMode = journalConfig.source === "vault";

  if (action === "edit-path") {
    if (vaultMode) {
      const read = deps.readJournal({
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
      const read = deps.readJournal({
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
    const result = seedJournal({ memoryDir: config.memoryDir, date, force });
    io.out(result.wrote ? `wrote ${result.path}` : `unchanged ${result.path}`);
    return 0;
  }

  if (action === "extract") {
    if (journalConfig.extractionMode !== "review") {
      io.err(
        'journal: extract requires activity.timeline.journal.extractionMode "review" ' +
          `(currently "${journalConfig.extractionMode}") — extraction is opt-in and review-only by design.`,
      );
      return 1;
    }
    let text: string;
    if (vaultMode) {
      const read = deps.readJournal({
        vault: config.activity.timeline.vault,
        date,
        timezone: config.activity.timezone,
      });
      if (!read.ok) {
        io.err(`journal: cannot read the vault note (${read.reason}): ${read.filePath}`);
        return 1;
      }
      if (!read.exists) {
        io.out(`no journal ${date} (${read.reason})`);
        return 0;
      }
      text = read.text;
    } else {
      const filePath = journalPath(config.memoryDir, date);
      if (!fs.existsSync(filePath)) {
        io.out(`no journal ${date} (missing_file)`);
        return 0;
      }
      text = fs.readFileSync(filePath, "utf8");
    }

    return withJournalDateLock(config.memoryDir, date, async () => {
      const state = readTimelineState(config.memoryDir);
      if (journalUnchanged(state, date, text)) {
        io.out(`unchanged ${date} (hash-skip)`);
        return 0;
      }

      const result = await runJournalReviewExtraction({
        date,
        journalText: text,
        source: vaultMode ? "vault" : "memoryDir",
        journalConfig,
        deps: await deps.extractionDeps(),
      });
      if (!result.completed) {
        io.err(`journal: extraction did not complete for ${date} — the day retries on the next run.`);
        return 1;
      }
      await commitJournalHash(config.memoryDir, date, hashJournalText(text));
      io.out(`pending_review: ${result.pendingReview}`);
      io.out(`rejected_by_judge: ${result.rejectedByJudge}`);
      io.out(`skipped: ${result.skipped}`);
      for (const warning of result.warnings) {
        io.err(`journal: ${warning}`);
      }
      return 0;
    });
  }

  io.err(`journal: unknown action "${action}".`);
  io.err(journalHelp().trimEnd());
  return 1;
}

export async function runJournalBinaryCommand(rest: string[]): Promise<void> {
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    console.log(journalHelp().trimEnd());
    return;
  }
  let config: PluginConfig;
  try {
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
  const action = rest[0];
  let orchestrator: Orchestrator | undefined;
  try {
    let deps: JournalCommandDeps | undefined;
    if (action === "extract") {
      orchestrator = new Orchestrator(config);
      await orchestrator.initialize();
      await orchestrator.deferredReady;
      const storage = await orchestrator.getStorageForNamespace(config.defaultNamespace);
      deps = createJournalCommandDeps(config, storage);
    }
    const code = await runJournalCommand(
      config,
      rest,
      {
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      },
      deps ?? defaultDeps(config),
    );
    if (code !== 0) process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await orchestrator?.destroy();
  }
}
