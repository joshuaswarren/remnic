/**
 * Session delta — pure repo differ + thin state persistence
 * (issue #1548 Track A PR 4).
 *
 * Tells a returning agent "since you last worked here: N commits, these
 * files." The differ is a pure function over a {@link GitLogSlice}; the
 * caller supplies the slice (from a real git invoker or a test fixture).
 *
 * Design rules honoured:
 *  - rule 11 — no module-level mutable state; the state file is read and
 *    written through passed-in functions, never cached in module scope.
 *  - rule 25 — the new last-seen-head is persisted AFTER the delta is
 *    computed from the old one; the caller never destroys the old marker
 *    before the new state is useful.
 *  - rule 27 — `slice(-n)` caps guard against `n === 0` (which would
 *    return the whole array instead of an empty slice).
 *  - rule 34 — every non-trivial outcome is a tagged union; a missing
 *    prior head, an unreachable head (force-push/rebase), or a git failure
 *    is surfaced with a distinct code, never as an empty delta.
 *  - rule 48 — least-privileged defaults: caps are conservative.
 *  - rule 51 — invalid inputs are rejected loudly by the persistence
 *    helpers, never silently coerced.
 *  - rule 54 — state writes are temp-file-then-rename so a crashed write
 *    never leaves a truncated JSON file at the canonical path.
 *
 * Storage: `<memoryDir>/state/coding-knowledge/<sanitized-namespace>.json`
 * (precedent: `calibration.ts`). The namespace is already sanitized by the
 * coding-namespace router, but `sanitizeFragment` is reused defensively so a
 * future caller cannot place a state file outside the directory.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { sanitizeFragment } from "./coding-namespace.js";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

/** A single commit in the delta slice. */
export interface GitCommit {
  /** Full or abbreviated SHA — callers decide precision. */
  sha: string;
  /** First-line commit subject. */
  subject: string;
}

/**
 * The repo's current state since the last-seen head. Callers populate this
 * from a real git invoker (see {@link SessionDeltaGitInvoker}); tests inject
 * a fixture directly.
 */
export interface GitLogSlice {
  /** Commits in `lastSeen..currentHead`, oldest-first. Empty when unchanged. */
  commits: GitCommit[];
  /** Files touched across those commits, de-duplicated and sorted. */
  touchedFiles: string[];
  /** The repo's current HEAD SHA. */
  currentHead: string;
}

/** Persisted marker: the HEAD we last computed a delta against, and when. */
export interface LastSeenState {
  /** HEAD SHA at the time of the last delta. */
  head: string;
  /** ISO timestamp of the last delta computation. */
  at: string;
}

/** A successful delta computation. */
export interface SessionDelta {
  /** Commits since last seen, capped to {@link MAX_DELTA_COMMITS}. */
  commits: GitCommit[];
  /** Touched files since last seen, capped to {@link MAX_DELTA_FILES}. */
  touchedFiles: string[];
  /**
   * Uncapped total commit count. The {@link commits} slice is capped for
   * transport; this total reports the true delta size so summaries and
   * metrics never under-report on large repos (issue #1630 fix 1).
   */
  totalCommits: number;
  /**
   * Uncapped total touched-file count. The {@link touchedFiles} slice is
   * capped for transport; this total reports the true delta size (issue
   * #1630 fix 1).
   */
  totalTouchedFiles: number;
  /** A single human-readable summary line for briefing injection. */
  summaryLine: string;
}

/**
 * Tagged result. Every non-trivial path returns a distinct shape so callers
 * (briefing, xray, doctor) can distinguish "first run" from "no changes"
 * from "delta unavailable" — never an empty delta masquerading as "nothing
 * happened" (rule 34).
 */
export type SessionDeltaResult =
  /** A non-empty delta was computed. */
  | { ok: true; kind: "changed"; delta: SessionDelta; nextState: LastSeenState }
  /** Prior head equals current head — no changes to report. */
  | { ok: true; kind: "unchanged"; nextState: LastSeenState }
  /** No prior state — first session for this namespace. */
  | { ok: true; kind: "first_run"; nextState: LastSeenState }
  /** The prior head is unreachable (force-push/rebase). Delta unavailable. */
  | { ok: false; code: "unreachable_head"; detail: string; nextState: LastSeenState }
  /** The git invoker failed (timeout, missing binary, non-zero exit). */
  | { ok: false; code: "git_failed"; detail: string };

// ──────────────────────────────────────────────────────────────────────────
// Caps (rule 27 / rule 48)
// ──────────────────────────────────────────────────────────────────────────

/** Maximum commits retained in a delta. Older commits beyond the cap are dropped. */
export const MAX_DELTA_COMMITS = 20;

/** Maximum touched files retained in a delta. */
export const MAX_DELTA_FILES = 50;

// ──────────────────────────────────────────────────────────────────────────
// Pure differ
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compute a session delta from a prior state and the current repo slice.
 *
 * Returns one of:
 *  - `first_run` — no prior state; the caller should persist `nextState`
 *    but render NO delta section (a first session must not claim "0 changes").
 *  - `unchanged` — prior head equals current head; suppress the section.
 *  - `changed` — a real delta with capped commits/files + a summary line.
 *
 * This function is pure: it reads neither disk nor git. The caller supplies
 * `current` already resolved. The only side-effect-bearing step is the
 * caller's subsequent `writeLastSeenState(nextState)` call.
 */
export function computeSessionDelta(
  lastSeen: LastSeenState | null,
  current: GitLogSlice,
): SessionDeltaResult {
  const now = new Date().toISOString();
  const nextState: LastSeenState = { head: current.currentHead, at: now };

  // First session — no prior marker. Initialize state but render nothing.
  // A first session claiming "0 changes" is a contract lie (rule 34).
  if (lastSeen === null) {
    return { ok: true, kind: "first_run", nextState };
  }

  // Unchanged — prior head still current. Suppress, do not render "no changes".
  if (lastSeen.head === current.currentHead) {
    return { ok: true, kind: "unchanged", nextState };
  }

  // If the slice reports zero commits despite a head change, the prior head
  // is unreachable (force-push/rebase erased it). Tagged failure, never a crash.
  if (current.commits.length === 0) {
    return {
      ok: false,
      code: "unreachable_head",
      detail: `prior head ${lastSeen.head} is not an ancestor of current ${current.currentHead}`,
      nextState,
    };
  }

  const commits = capCommits(current.commits, MAX_DELTA_COMMITS);
  const touchedFiles = capFiles(current.touchedFiles, MAX_DELTA_FILES);

  return {
    ok: true,
    kind: "changed",
    delta: {
      commits,
      touchedFiles,
      // Uncapped totals — the slices above are capped for transport, but
      // the summary/metrics must report the true delta size so callers
      // never under-report on large repos (issue #1630 fix 1).
      totalCommits: current.commits.length,
      totalTouchedFiles: current.touchedFiles.length,
      summaryLine: buildSummaryLine(current.commits.length, current.touchedFiles.length, lastSeen.at),
    },
    nextState,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Caps — rule 27: guard slice(-n) against n === 0
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cap a commits array to the most-recent `max` entries.
 *
 * `Array.prototype.slice(-n)` with `n === 0` returns the WHOLE array (not
 * an empty slice), so an explicit guard is mandatory (rule 27). We keep the
 * most-recent commits (tail), which is what a returning agent cares about.
 */
export function capCommits(commits: GitCommit[], max: number): GitCommit[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  if (commits.length <= max) return commits;
  return commits.slice(-max);
}

/**
 * Cap a touched-files list to `max` entries, preserving sort order.
 * Same rule-27 guard as {@link capCommits}.
 */
export function capFiles(files: string[], max: number): string[] {
  if (!Number.isFinite(max) || max <= 0) return [];
  if (files.length <= max) return files;
  return files.slice(0, max);
}

// ──────────────────────────────────────────────────────────────────────────
// Summary line
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the single briefing-summary line. Deterministic and locale-stable
 * so a briefing snapshot is byte-identical across runs for the same input.
 */
export function buildSummaryLine(commitCount: number, fileCount: number, sinceIso: string): string {
  const since = formatSinceDate(sinceIso);
  const commitWord = commitCount === 1 ? "commit" : "commits";
  const fileWord = fileCount === 1 ? "file" : "files";
  return `Since ${since}: ${commitCount} ${commitWord}, ${fileCount} ${fileWord} touched.`;
}

/**
 * Format the "since" timestamp as a stable, locale-independent label.
 * Returns the raw ISO date (YYYY-MM-DD) so the briefing snapshot never
 * depends on the runtime locale or timezone.
 */
function formatSinceDate(iso: string): string {
  // Defensive: if the stored timestamp is malformed, fall back to the raw
  // string rather than crashing the delta render (rule 34 — never crash on
  // persisted state corruption).
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match ? match[1]! : iso;
}

// ──────────────────────────────────────────────────────────────────────────
// State persistence
// ──────────────────────────────────────────────────────────────────────────

/** Subdirectory under `<memoryDir>/state/` holding coding-knowledge markers. */
export const CODING_KNOWLEDGE_STATE_DIR = path.join("state", "coding-knowledge");

/**
 * Compute the canonical state-file path for a namespace.
 *
 * The namespace is already router-sanitized, but `sanitizeFragment` is
 * applied defensively so a caller passing an unsanitized value cannot place
 * a file outside the directory (rule 51 — defensive at the boundary).
 */
export function sessionDeltaStatePath(memoryDir: string, namespace: string): string {
  const safe = sanitizeFragment(namespace) || "default";
  return path.join(memoryDir, CODING_KNOWLEDGE_STATE_DIR, `${safe}.json`);
}

/**
 * Read the persisted last-seen-head marker. Returns `null` when the file is
 * absent, empty, or malformed — never throws (rule 34 — corrupted state
 * degrades to a first-run, not a crash).
 */
export async function readLastSeenState(statePath: string): Promise<LastSeenState | null> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const head = typeof obj.head === "string" ? obj.head : null;
    const at = typeof obj.at === "string" ? obj.at : null;
    if (!head || !at) return null;
    return { head, at };
  } catch {
    // Absent or unreadable — treat as first run.
    return null;
  }
}

/**
 * Persist the last-seen-head marker using temp-file-then-rename (rule 54)
 * so a crashed write never leaves a truncated file at the canonical path.
 *
 * The caller invokes this AFTER computing the delta from the prior state
 * (rule 25 — do not destroy the old marker before the new state is useful).
 */
export async function writeLastSeenState(
  statePath: string,
  state: LastSeenState,
): Promise<void> {
  if (!state.head || !state.at) {
    throw new Error(
      `writeLastSeenState: invalid state (head=${JSON.stringify(state.head)}, at=${JSON.stringify(state.at)})`,
    );
  }
  const dir = path.dirname(statePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, statePath);
}

// ──────────────────────────────────────────────────────────────────────────
// Git invoker — the contract the surface handler satisfies to populate a
// GitLogSlice from a real repo. Mirrors coding/git-context.ts discipline:
// 2s timeout per call, never throws, exitCode returned to the caller.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Injectable git-invocation surface for session-delta. Only the two commands
 * the differ needs are exposed. Implementations MUST NOT throw for non-zero
 * exit codes — they return `{ exitCode, stdout }` so the handler can decide
 * how to recover (rule 34).
 */
export interface SessionDeltaGitInvoker {
  /**
   * Run `git <args>` with `cwd` as the working directory.
   * Implementations enforce a per-call timeout (2s precedent in
   * `coding/git-context.ts`) and return non-zero exit codes instead of
   * throwing.
   */
  (cwd: string, args: string[]): { stdout: string; exitCode: number };
}

/**
 * Result of resolving the current repo slice. Tagged so the handler can
 * surface a distinct degradation code (rule 34).
 */
export type ResolveSliceResult =
  | { ok: true; slice: GitLogSlice }
  | { ok: false; code: "git_failed" | "no_head"; detail: string };

/** Default per-call timeout when no invoker override is supplied. */
export const SESSION_DELTA_GIT_TIMEOUT_MS = 2_000;

/**
 * Resolve the current HEAD and the commit/file slice since `sinceHead`.
 *
 * Uses two git calls:
 *   1. `rev-parse HEAD` — current head.
 *   2. `log --name-only --pretty=format:... sinceHead..HEAD` — commits + files.
 *
 * Never throws; failures map to `{ ok: false, code }` and the handler
 * surfaces them as `git_failed` or `unreachable_head`.
 */
export function resolveSlice(
  repoRoot: string,
  sinceHead: string | null,
  invoker: SessionDeltaGitInvoker,
): ResolveSliceResult {
  const headResult = invoker(repoRoot, ["rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0) {
    return {
      ok: false,
      code: headResult.stdout.trim().length === 0 ? "no_head" : "git_failed",
      detail: `rev-parse HEAD exited ${headResult.exitCode}`,
    };
  }
  const currentHead = headResult.stdout.trim();
  if (!currentHead) {
    return { ok: false, code: "no_head", detail: "rev-parse HEAD returned empty" };
  }

  // First run — no prior head to diff against. Return an empty slice; the
  // differ turns this into a `first_run` outcome.
  if (!sinceHead) {
    return { ok: true, slice: { commits: [], touchedFiles: [], currentHead } };
  }

  // Unchanged — short-circuit before the log call (saves a git invocation).
  if (sinceHead === currentHead) {
    return { ok: true, slice: { commits: [], touchedFiles: [], currentHead } };
  }

  // Use a unique ASCII separator unlikely to appear in commit subjects or
  // paths. NUL would be ideal but is awkward to pass through argv; unit
  // separator (\x1f) is the next-best thing and is rejected by sanitize if
  // it ever leaks into memory content.
  const SEP = "\x1f";
  // --reverse makes git emit oldest-first, so the commits array reads in
  // chronological order and capCommits' slice(-max) keeps the NEWEST entries
  // (the ones a returning agent cares about). Without --reverse, git log is
  // newest-first and slice(-max) would drop exactly the commits we want.
  const logResult = invoker(repoRoot, [
    "log",
    "--reverse",
    `--pretty=format:%H${SEP}%s`,
    "--name-only",
    `${sinceHead}..${currentHead}`,
  ]);
  if (logResult.exitCode !== 0) {
    // Exit code 128 is git's "bad revision" / "object not found" — the prior
    // head is genuinely unreachable (force-push/rebase erased it). Return an
    // empty slice so the differ labels it `unreachable_head`; the state marker
    // advances so the next call sees the new head as the baseline.
    if (logResult.exitCode === 128) {
      return { ok: true, slice: { commits: [], touchedFiles: [], currentHead } };
    }
    // Other non-zero exit codes (127 = spawn failure / 2s timeout, 129+ =
    // signal, etc.) are TRANSIENT — the old head is probably still valid. Do
    // NOT treat these as unreachable and do NOT let the caller advance the
    // state marker. Return `git_failed` so the surface preserves the old
    // marker and the next session retries.
    return {
      ok: false,
      code: "git_failed",
      detail: 'git log exited ' + logResult.exitCode + ' (transient — state marker preserved)',
    };
  }

  const { commits, touchedFiles } = parseLogOutput(logResult.stdout, SEP);
  return { ok: true, slice: { commits, touchedFiles, currentHead } };
}

/**
 * Parse `git log --pretty=format:%H<SEP>%s --name-only` output into structured
 * commits + a de-duplicated, sorted touched-file list.
 *
 * Exported for unit tests.
 */
export function parseLogOutput(stdout: string, sep: string): {
  commits: GitCommit[];
  touchedFiles: string[];
} {
  const commits: GitCommit[] = [];
  const fileSet = new Set<string>();

  // Git emits each commit as:
  //   <sha><SEP><subject>
  //   <blank line>
  //   <file1>
  //   <file2>
  //   <blank line>
  //   <next commit>...
  //
  // We split on blank-line-separated blocks. A commit block starts with a
  // line containing the separator; file blocks do not.
  const blocks = stdout.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const header = lines[0]!;
    const sepIdx = header.indexOf(sep);
    if (sepIdx >= 0) {
      const sha = header.slice(0, sepIdx);
      const subject = header.slice(sepIdx + sep.length);
      commits.push({ sha, subject });
      for (let i = 1; i < lines.length; i += 1) {
        if (lines[i]!) fileSet.add(lines[i]!);
      }
    } else {
      // A file-only block (continuation) — every non-empty line is a file.
      for (const line of lines) fileSet.add(line);
    }
  }

  const touchedFiles = [...fileSet].sort((a, b) => a.localeCompare(b));
  return { commits, touchedFiles };
}
