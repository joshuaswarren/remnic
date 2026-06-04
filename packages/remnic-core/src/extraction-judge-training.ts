/**
 * Extraction Judge Training Data Shim (issue #562, PR 4).
 *
 * Opt-in collector for `(candidate_text, verdict_kind, reason,
 * ground_truth_label?)` tuples. Rows are appended to JSONL files under
 * `~/.remnic/judge-training/<YYYY-MM-DD>.jsonl` so operators can ship the
 * data into a future GRPO training pipeline without exfiltrating live
 * memory content through the regular observation ledger.
 *
 * Gating:
 *   - Off by default. Must be explicitly enabled via
 *     `collectJudgeTrainingPairs: true` in plugin config.
 *   - The ground-truth label is always optional — labels are added out-of-
 *     band once reviewers disambiguate the candidate's fate.
 *
 * Privacy: the row carries only what the judge already sees — the
 * candidate text and its metadata. It does NOT carry session keys,
 * principal IDs, or any user identifiers. The file lives in the user's
 * home directory rather than the shared memory directory so it is never
 * committed, sync'd, or bundled into exports.
 */

import path from "node:path";
import { homedir } from "node:os";
import { appendFile, chmod, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { log } from "./logger.js";
import type { JudgeVerdictKind } from "./extraction-judge.js";

/**
 * Persisted training row. Intentionally minimal: just the signal needed
 * to train a judge replacement policy. Schema version is tagged so future
 * readers can migrate older rows.
 */
export interface JudgeTrainingPair {
  version: 1;
  ts: string; // ISO-8601
  candidateText: string;
  candidateCategory: string;
  candidateConfidence?: number;
  verdictKind: JudgeVerdictKind;
  reason: string;
  /**
   * Number of prior deferrals when the verdict was resolved. `0` for the
   * first resolution; only set when known (defer pathway).
   */
  priorDeferrals?: number;
  /**
   * Optional human-applied ground-truth label. Added after the fact by a
   * reviewer / labelling script; not present on fresh rows.
   */
  groundTruthLabel?: JudgeVerdictKind;
}

export interface JudgeTrainingOptions {
  enabled: boolean;
  /**
   * Override for the output directory. Defaults to
   * `~/.remnic/judge-training`. Tests pass a temp path here.
   */
  directory?: string;
}

/**
 * Expand a leading `~` / `~/` / `$HOME/` / `${HOME}/` to the process home
 * directory. Node's `fs` APIs do not expand `~` themselves (CLAUDE.md
 * gotcha 17), so every user-facing path input must be funnelled through
 * this helper before it reaches the filesystem.
 */
function expandTilde(p: string): string {
  const home = homedir();
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return home + p.slice(1);
  }
  if (p === "$HOME" || p.startsWith("$HOME/") || p.startsWith("$HOME\\")) {
    return home + p.slice(5);
  }
  if (p === "${HOME}" || p.startsWith("${HOME}/") || p.startsWith("${HOME}\\")) {
    return home + p.slice(7);
  }
  return p;
}

export function resolveTrainingDir(options: JudgeTrainingOptions): string {
  if (options.directory && options.directory.length > 0) {
    // Expand `~` / `$HOME` in the override so operators can write the
    // config as the user sees it (CLAUDE.md gotcha 17).
    return expandTilde(options.directory);
  }
  return path.join(homedir(), ".remnic", "judge-training");
}

function dateStamp(iso: string): string {
  // `YYYY-MM-DD` from an ISO-8601 string. Falls back to today on a parse
  // failure rather than throwing — the caller already wrote a row and the
  // timestamp is best-effort.
  const ms = Date.parse(iso);
  const d = Number.isFinite(ms) ? new Date(ms) : new Date();
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = d.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function trainingFilePathFor(directory: string, iso: string): string {
  return path.join(directory, `${dateStamp(iso)}.jsonl`);
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Append a single training row. Fails open — write errors are logged at
 * debug level and swallowed, same policy as the telemetry emitter.
 * No-op when `options.enabled` is false.
 */
export async function recordJudgeTrainingPair(row: JudgeTrainingPair, options: JudgeTrainingOptions): Promise<void> {
  if (!options.enabled) return;
  const dir = resolveTrainingDir(options);
  const filePath = trainingFilePathFor(dir, row.ts);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(filePath, `${JSON.stringify(row)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await chmod(filePath, 0o600);
  } catch (err) {
    log.debug(
      `extraction-judge-training: append failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Read all training rows from the configured directory. Returns an empty
 * array when the directory is missing. Malformed lines are skipped and
 * counted in the returned `malformed` tally.
 */
export async function readJudgeTrainingPairs(
  options: Pick<JudgeTrainingOptions, "directory">
): Promise<{ rows: JudgeTrainingPair[]; malformed: number }> {
  const dir = resolveTrainingDir({ enabled: true, ...options });
  try {
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink()) {
      throw new Error("Judge training directory must not be a symlink");
    }
    if (!dirStat.isDirectory()) {
      throw new Error("Judge training path must be a directory");
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rows: [], malformed: 0 };
    throw err;
  }

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rows: [], malformed: 0 };
    throw err;
  }

  const rows: JudgeTrainingPair[] = [];
  let malformed = 0;
  const resolvedDir = await realpath(dir);
  // Sort so reads are deterministic across platforms.
  entries.sort();
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = path.join(dir, name);
    let fileStat: Awaited<ReturnType<typeof lstat>>;
    try {
      fileStat = await lstat(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;

    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw err;
    }
    if (!isPathInsideDirectory(resolvedFilePath, resolvedDir)) continue;

    const raw = await readFile(resolvedFilePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformed += 1;
        continue;
      }
      if (!isValidTrainingPair(parsed)) {
        malformed += 1;
        continue;
      }
      rows.push(parsed);
    }
  }
  return { rows, malformed };
}

/**
 * Structural validator matching the persisted schema. Forward-compat: an
 * unknown `verdictKind` string is treated as malformed (strict training
 * signal — we do not want to admit unlabelled gibberish into a trainer).
 */
export function isValidTrainingPair(value: unknown): value is JudgeTrainingPair {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const p = value as Record<string, unknown>;
  if (p.version !== 1) return false;
  if (typeof p.ts !== "string") return false;
  if (typeof p.candidateText !== "string") return false;
  if (typeof p.candidateCategory !== "string") return false;
  if (p.verdictKind !== "accept" && p.verdictKind !== "reject" && p.verdictKind !== "defer") {
    return false;
  }
  if (typeof p.reason !== "string") return false;
  if (p.candidateConfidence !== undefined && typeof p.candidateConfidence !== "number") {
    return false;
  }
  if (p.priorDeferrals !== undefined && typeof p.priorDeferrals !== "number") {
    return false;
  }
  if (
    p.groundTruthLabel !== undefined &&
    p.groundTruthLabel !== "accept" &&
    p.groundTruthLabel !== "reject" &&
    p.groundTruthLabel !== "defer"
  ) {
    return false;
  }
  return true;
}
