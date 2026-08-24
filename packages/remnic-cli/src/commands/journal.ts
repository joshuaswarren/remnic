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
  refreshActivityIndex,
  resolveRemnicConfigRecord,
  runJournalReviewExtraction,
  seedJournal,
  withJournalDateLock,
  type JournalExtractionDeps,
  type PluginConfig,
} from "@remnic/core";
import { resolveConfigPath } from "../config-path.js";

export interface JournalCommandIo {
  out(line: string): void;
  err(line: string): void;
}

/** Injectable seam: note reads, extraction-pass deps, the reindex hook, and the clock. */
export interface JournalCommandDeps {
  readJournal: typeof readJournalForDate;
  /** Built lazily — only the `extract` action pays for storage + engine. */
  extractionDeps(): Promise<JournalExtractionDeps>;
  /**
   * Canonical search-index refresh (issue #2872): fired once after any
   * candidate write (§31) so new journal memories are discoverable. Wired to
   * `refreshActivityIndex(orchestrator.qmd, config.qmdCollection)` in the
   * binary entrypoint — the same forced/strict seam the activity sync uses.
   */
  reindexSearch?(): Promise<void>;
  now(): Date;
}

function defaultDeps(
  config: PluginConfig,
  storage?: StorageManager,
  reindexSearch?: () => Promise<void>,
): JournalCommandDeps {
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
        extract: (turns: Parameters<JournalExtractionDeps["extract"]>[0]) => engine.extract(turns),
        writer: createJournalMemoryWriter(storage),
        ...(reindexSearch === undefined ? {} : { afterWrites: reindexSearch }),
      };
    },
    ...(reindexSearch === undefined ? {} : { reindexSearch }),
    now: () => new Date(),
  };
}

/** Build command deps with an already-resolved StorageManager (secure store, tombstones, namespace). */
export function createJournalCommandDeps(
  config: PluginConfig,
  storage: StorageManager,
  reindexSearch?: () => Promise<void>,
): JournalCommandDeps {
  return defaultDeps(config, storage, reindexSearch);
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
  // Master gate (issue #1987 P2): when disabled, every action refuses
  // before ANY journal read — vault note or memoryDir day file.
  if (!journalConfig.enabled) {
    io.err("journal: timeline.journal.enabled is false — enable the journal first.");
    return 1;
  }
  // Default date derives from the configured activity timezone, not the
  // host's local clock (issue #1987 P2): a host in Europe must not resolve
  // "today" to yesterday for a Pacific user at their local midnight.
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
      surfaceStripWarnings(io, read.warnings);
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

    // Per-date lock covers note read → hash reread → extract/dedup/write →
    // state commit so two processes cannot double-extract the same day
    // (issue #2872: the note is read AFTER the lock is acquired — a waiter
    // queued behind a newer extraction re-reads the current note and
    // hash-skips instead of overwriting the newer run with stale text).
    // Different dates use different lock files and may run concurrently.
    return withJournalDateLock(config.memoryDir, date, async () => {
      let text: string;
      let stripWarnings: readonly string[] = [];
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
        // A missing note/section is a legitimate no-journal day (§22): nothing
        // to extract, no state write, exit 0.
        if (!read.exists) {
          io.out(`no journal ${date} (${read.reason})`);
          return 0;
        }
        text = read.text;
        stripWarnings = read.warnings;
      } else {
        const filePath = journalPath(config.memoryDir, date);
        if (!fs.existsSync(filePath)) {
          io.out(`no journal ${date} (missing_file)`);
          return 0;
        }
        text = fs.readFileSync(filePath, "utf8");
      }
      surfaceStripWarnings(io, stripWarnings);
      const state = readTimelineState(config.memoryDir);
      if (journalUnchanged(state, date, text)) {
        io.out(`unchanged ${date} (hash-skip)`);
        return 0;
      }

      // Review-only pass: candidates land pending_review ONLY. The judge is a
      // maintenance-surface dep; without it every candidate survives to human
      // review — the conservative direction for a one-shot command.
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
      // Completed runs advance the day's hash so the same content never re-runs.
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

/**
 * Strip warnings name config/region names only — never journal content — so
 * printing them to stderr is safe on every surface (issue #2872). They
 * describe what the fail-closed strip removed; the remaining text is clean.
 */
function surfaceStripWarnings(io: JournalCommandIo, warnings: readonly string[]): void {
  for (const warning of warnings) {
    io.err(`journal: ${warning}`);
  }
}

export async function runJournalBinaryCommand(rest: string[]): Promise<void> {
  // Help short-circuits BEFORE config discovery and parse (issue #1987 P2):
  // `remnic journal --help` prints usage and exits 0 even when the config
  // file is malformed — a broken config must never hide the usage text.
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") {
    console.log(journalHelp().trimEnd());
    return;
  }
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
  const action = rest[0];
  let orchestrator: Orchestrator | undefined;
  try {
    let deps: JournalCommandDeps | undefined;
    if (action === "extract") {
      const orch = new Orchestrator(config);
      orchestrator = orch;
      await orch.initialize();
      await orch.deferredReady;
      const storage = await orch.getStorageForNamespace(config.defaultNamespace);
      // Canonical reindex (issue #2872): the same forced/strict refresh the
      // activity sync uses, fired once after any candidate write (§31).
      deps = createJournalCommandDeps(config, storage, () =>
        refreshActivityIndex(orch.qmd, config.qmdCollection),
      );
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
