import { launchProcessSync } from "@remnic/core/runtime/child-process";

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export interface NameStatusEntry {
  /**
   * `git diff --name-status` status code: `A` (added), `M` (modified),
   * `D` (deleted), `R100` (renamed, 100% similarity), `C75` (copied, 75%),
   * etc. Renames carry the NEW path in `path` and the OLD path in
   * `oldPath`.
   */
  readonly status: string;
  /** Repo-relative forward-slash path of the file in the NEW tree. */
  readonly path: string;
  /** For renames/copies (`R*`/`C*`), the source path. Otherwise `undefined`. */
  readonly oldPath?: string;
}

export interface DiffHunk {
  /** File path (repo-relative, forward slashes). */
  readonly path: string;
  /**
   * Half-open `[startLine, endLine)` line range in the NEW (post-change)
   * version of the file. `startLine` is 1-based; `endLine` is exclusive.
   * A single-line change has `endLine === startLine + 1`.
   */
  readonly newRange: { readonly startLine: number; readonly endLine: number };
}

export interface LogFilesEntry {
  /** Full commit SHA (40 hex chars). */
  readonly sha: string;
  /** Files changed in this commit (repo-relative, forward slashes, deduped). */
  readonly files: readonly string[];
}

/**
 * Tagged failure — `code` is the load-bearing signal for programmatic
 * detection (rule 34). Never carries `error.message` (which may contain
 * absolute paths — rule 11).
 */
export interface GitFailure {
  readonly ok: false;
  readonly code: "git_unavailable" | "unreachable_head" | "git_error";
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Injectable git-invocation surface. Each method runs a specific git
 * subcommand with argv arrays (never string interpolation — rule 10) and
 * returns parsed output or a tagged failure. Tests inject a mock to avoid
 * spawning a real git process against synthetic fixture repos.
 *
 * The default implementation uses `launchProcessSync` with a 2-second
 * timeout (matching `git-context.ts`'s `DEFAULT_GIT_TIMEOUT_MS`).
 */
export interface CodingGitInvoker {
  /**
   * `git rev-parse HEAD` — the current HEAD SHA. Returns `null` when HEAD
   * does not exist (empty repo / no commits yet).
   */
  revParseHead(cwd: string): { ok: true; head: string | null } | GitFailure;

  /**
   * `git rev-parse --verify <ref>^{commit}` — check whether a prior head
   * is still reachable. Used to detect rebase/force-push scenarios
   * (issue #1553 pitfall 34: `unreachable_head`).
   */
  isReachable(
    cwd: string,
    ref: string,
  ): { ok: true; reachable: boolean } | GitFailure;

  /**
   * `git diff --name-status <range>` — the changed files between two
   * commits (or between a commit and HEAD). Returns one entry per file.
   */
  diffNameStatus(
    cwd: string,
    range: string,
  ): { ok: true; entries: readonly NameStatusEntry[] } | GitFailure;

  /**
   * Working-tree diff hunks with zero context lines. Captures BOTH staged
   * and unstaged changes (compared against HEAD) so `detect_changes` maps
   * every uncommitted edit to a symbol span. Each hunk carries its
   * new-version line range.
   */
  diffHunks(
    cwd: string,
    paths: readonly string[],
  ): { ok: true; hunks: readonly DiffHunk[] } | GitFailure;

  /**
   * `git log --name-only --format=%H -n <limit>` — commit SHAs + their
   * changed files over a bounded window. Used by co-change mining.
   */
  logFiles(
    cwd: string,
    limit: number,
  ): { ok: true; entries: readonly LogFilesEntry[] } | GitFailure;

  /**
   * `git ls-files` — the repo's tracked files as repo-relative forward-slash
   * paths. Used by the codegraph runtime to source `candidatePaths` for a
   * full reindex (issue #1554: the executor treats an omitted candidate list
   * as non-authoritative and no-ops, so the runtime must supply one).
   * Returns an empty path list for a repo with no tracked files; a git
   * failure degrades to `{ ok: false, code: "git_unavailable" | "git_error" }`.
   */
  listTrackedFiles(
    cwd: string,
  ): { ok: true; paths: readonly string[] } | GitFailure;
}

// ──────────────────────────────────────────────────────────────────────────
// Default implementation — real git via launchProcessSync
// ──────────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 2_000;

/**
 * Run `git <args>` synchronously with a bounded timeout. Never throws —
 * spawn failures (git not on PATH, timeout) surface as
 * `{ ok: false, code: "git_unavailable" }` so callers can degrade.
 */
function runGit(
  cwd: string,
  args: readonly string[],
): { ok: true; stdout: string; exitCode: number } | GitFailure {
  const result = launchProcessSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    shell: false,
  });
  if (result.error) {
    return { ok: false, code: "git_unavailable" };
  }
  return {
    ok: true,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    exitCode: typeof result.status === "number" ? result.status : 1,
  };
}

export function defaultCodingGitInvoker(): CodingGitInvoker {
  return {
    revParseHead(cwd: string) {
      const r = runGit(cwd, ["rev-parse", "HEAD"]);
      if (!r.ok) return r;
      const trimmed = r.stdout.trim();
      if (r.exitCode === 0 && trimmed.length > 0) {
        return { ok: true, head: trimmed };
      }
      // Non-zero exit: could be an UNBORN repo (no commits yet, HEAD is a
      // symbolic ref to a non-existent branch) OR a directory that is not
      // a git worktree at all. Distinguish them so a misconfigured workspace
      // surfaces as a git failure instead of silently looking like an empty
      // repo (chatgpt-codex-connector: 'Return a git failure for non-
      // repository HEAD lookups').
      const wt = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
      if (wt.ok && wt.exitCode === 0 && wt.stdout.trim() === "true") {
        return { ok: true, head: null };
      }
      return { ok: false, code: "git_error" };
    },

    isReachable(cwd: string, ref: string) {
      const r = runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!r.ok) return r;
      return { ok: true, reachable: r.exitCode === 0 };
    },

    diffNameStatus(cwd: string, range: string) {
      const r = runGit(cwd, ["diff", "--name-status", range]);
      if (!r.ok) return r;
      if (r.exitCode !== 0) {
        return { ok: false, code: "git_error" };
      }
      return { ok: true, entries: parseNameStatus(r.stdout) };
    },

    diffHunks(cwd: string, paths: readonly string[]) {
      // `git diff HEAD` compares the working tree (staged + unstaged)
      // against the last commit, so BOTH staged and unstaged edits are
      // captured (chatgpt-codex-connector: 'Include staged hunks in
      // diffHunks'). Plain `git diff` would miss staged-only changes.
      // --unified=0 → zero context lines so hunks are tight.
      // --no-color → no ANSI escape codes in output.
      // -- separator before paths to disambiguate refs from paths.
      const pathArgs: string[] = [];
      if (paths.length > 0) {
        pathArgs.push("--");
        for (const p of paths) pathArgs.push(p);
      }
      const r = runGit(cwd, ["diff", "HEAD", "--unified=0", "--no-color", ...pathArgs]);
      if (!r.ok) return r;
      if (r.exitCode !== 0) {
        // HEAD may not exist (unborn repo, no commits yet). Fall back to
        // unstaged-only diff — an acceptable degradation for a repo that
        // has never been indexed (there are no committed symbols anyway).
        const fallback = runGit(cwd, ["diff", "--unified=0", "--no-color", ...pathArgs]);
        if (!fallback.ok) return fallback;
        if (fallback.exitCode !== 0) {
          return { ok: false, code: "git_error" };
        }
        return { ok: true, hunks: parseHunks(fallback.stdout) };
      }
      return { ok: true, hunks: parseHunks(r.stdout) };
    },

    logFiles(cwd: string, limit: number) {
      const r = runGit(cwd, [
        "log",
        `--format=%H`,
        "--name-only",
        `-n`,
        String(limit),
      ]);
      if (!r.ok) return r;
      if (r.exitCode !== 0) {
        return { ok: false, code: "git_error" };
      }
      return { ok: true, entries: parseLogFiles(r.stdout) };
    },

    listTrackedFiles(cwd: string) {
      // `git ls-files` lists the repo's tracked files (cached in the index)
      // as repo-relative forward-slash paths — exactly the candidatePaths
      // format executeReindex expects. --others is NOT used: only tracked
      // files belong in an authoritative full-reindex candidate set.
      const r = runGit(cwd, ["ls-files"]);
      if (!r.ok) return r;
      if (r.exitCode !== 0) {
        return { ok: false, code: "git_error" };
      }
      const paths = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      return { ok: true, paths };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Output parsers — pure functions (unit-testable without git)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Parse `git diff --name-status` output. Each line is `<status>\t<path>`
 * for add/modify/delete, or `<status>\t<old>\t<new>` for rename/copy.
 *
 * Empty lines are skipped (trailing newline). Lines that do not parse
 * are skipped rather than crashing the whole diff (rule 44 — a single
 * bad line should not make the index go stale silently; but a partial
 * parse is better than a total failure because the executor will fall
 * back to hash-scan if the file count looks wrong).
 */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = [];
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const status = line.slice(0, tabIdx);
    const rest = line.slice(tabIdx + 1);
    const secondTab = rest.indexOf("\t");
    if (
      (status.startsWith("R") || status.startsWith("C")) &&
      secondTab >= 0
    ) {
      const oldPath = rest.slice(0, secondTab);
      const newPath = rest.slice(secondTab + 1);
      if (oldPath.length > 0 && newPath.length > 0) {
        out.push({ status, path: newPath, oldPath });
      }
    } else {
      if (rest.length > 0) {
        out.push({ status, path: rest });
      }
    }
  }
  return out;
}

/**
 * Parse `git diff --unified=0` output into per-file hunks. Each hunk
 * header is `@@ -a,b +c,d @@ <optional section>`. With `--unified=0`
 * the OLD range `(a,b)` is not useful for blast-radius (we want the
 * NEW range). We extract `+c,d` → `{ startLine: c, endLine: c + d }`.
 *
 * The file path comes from `diff --git a/path b/path` or
 * `+++ b/path` lines. We track the current file as we walk.
 */
export function parseHunks(stdout: string): DiffHunk[] {
  const out: DiffHunk[] = [];
  let currentPath: string | null = null;
  const lines = stdout.split("\n");
  for (const line of lines) {
    // `+++ b/path` — the new-version path (post-rename). Prefer this
    // over `diff --git` because it correctly handles renames.
    if (line.startsWith("+++ ")) {
      if (line.startsWith("+++ /dev/null")) {
        // The new side of this file is empty → it was DELETED. Clear
        // currentPath so a following `@@` hunk is not mis-attributed to
        // the previous file (chatgpt-codex-connector: 'Clear hunk path
        // for deleted files').
        currentPath = null;
        continue;
      }
      const raw = line.slice(4);
      currentPath = raw.startsWith("b/") ? raw.slice(2) : raw;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!match) continue;
      // match[1] is guaranteed by the first capture group; match[2] is
      // optional (omitted when the hunk is a single line). Guard both
      // with a fallback to avoid unchecked non-null assertions.
      const startStr = match[1] ?? "";
      if (startStr.length === 0) continue;
      const startLine = parseInt(startStr, 10);
      const countStr = match[2] ?? "";
      const count = countStr.length > 0 ? parseInt(countStr, 10) : 1;
      if (!currentPath) continue;
      // A deletion-only hunk emits a zero new-count (e.g. `@@ -2 +1,0 @@`).
      // An empty [startLine, startLine) range can never overlap a symbol
      // span, so pure deletions inside a function/class were missed.
      // Treat zero-count as covering the adjacent new line (chatgpt-
      // codex-connector: 'Map deletion-only hunks to a non-empty range').
      out.push({
        path: currentPath,
        newRange: {
          startLine,
          endLine: startLine + Math.max(count, 1),
        },
      });
    }
  }
  return out;
}

export function parseLogFiles(stdout: string): LogFilesEntry[] {
  const out: LogFilesEntry[] = [];
  let currentSha: string | null = null;
  let currentFiles: string[] = [];
  const seenInCommit = new Set<string>();
  const flush = (): void => {
    if (currentSha !== null) {
      out.push({ sha: currentSha, files: currentFiles });
    }
    currentSha = null;
    currentFiles = [];
    seenInCommit.clear();
  };
  for (const line of stdout.split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) {
      flush();
      currentSha = line;
    } else if (line.length > 0 && currentSha !== null) {
      if (!seenInCommit.has(line)) {
        seenInCommit.add(line);
        currentFiles.push(line);
      }
    }
    // blank lines are ignored — they do not terminate a commit; the
    // next SHA does.
  }
  flush();
  return out;
}

