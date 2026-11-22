/**
 * GitContextResolver — pure module for detecting the git project + branch
 * a session is operating in.
 *
 * Introduced by issue #569 (coding-agent project/branch-scoped namespaces).
 *
 * This module is deliberately pure:
 *   - no orchestrator references
 *   - no config side-effects
 *   - no namespace wiring
 *
 * Downstream slices (PR 2+ of #569) wire `resolveGitContext` into the
 * `NamespaceResolver` / `Orchestrator` so that memories are scoped to a
 * detected project / branch without leaking across repos.
 *
 * CLAUDE.md rule 17 (expand `~`): the `rootPath` returned here is always an
 * absolute, tilde-expanded path. Callers must not re-expand.
 *
 * CLAUDE.md rule 51 (reject invalid input): `cwd` must be an absolute path
 * and must exist. `resolveGitContext` returns `null` — rather than throwing —
 * when the directory is not inside a git worktree, because being outside a
 * repo is a normal runtime state (e.g. agent opened in a scratch dir).
 */
import { lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { abortError } from "../abort-error.js";
import { launchProcess, launchProcessSync } from "../runtime/child-process.js";
import { expandTildePath } from "../utils/path.js";

// Re-export so existing callers / tests that imported `expandTildePath` from
// this module keep working. CLAUDE.md #17 requires consistent `~` expansion
// across every user-facing path input; the canonical implementation now
// lives in `utils/path.ts`.
export { expandTildePath };

// ──────────────────────────────────────────────────────────────────────────

export interface GitContext {
  /**
   * Stable identifier for the project. Derived from `git remote get-url origin`
   * when an origin remote is configured, otherwise from the repo root path.
   *
   * Formatted as `origin:<hex>` or `root:<hex>` so that the source is visible
   * to operators (see `remnic doctor`, issue #569 acceptance criteria).
   */
  projectId: string;
  /**
   * Current branch, e.g. `main`, `feat/foo`. `null` only in detached-HEAD
   * state (e.g. rebase in progress). Callers should treat `null` as "no
   * branch-scope overlay applies" without erroring.
   */
  branch: string | null;
  /**
   * Absolute path to the repository root (the directory containing `.git`).
   * Tilde-expanded per CLAUDE.md #17.
   */
  rootPath: string;
  /**
   * Best-effort default branch (usually `main` or `master`). Derived from the
   * `refs/remotes/origin/HEAD` symbolic ref. `null` when not available (e.g.
   * fresh clone without a default branch symref, or no origin remote).
   */
  defaultBranch: string | null;
}

export interface GitInvokeOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface GitInvokeResult {
  stdout: string;
  exitCode: number;
  /** Captured when the invoker can supply it; used to tell a confirmed
   * "not a git repository" answer from operational failures (e.g. exit 128
   * for dubious ownership) that must stay inconclusive. */
  stderr?: string;
}

/**
 * Run `git <args>` with `cwd` as the working directory. Implementations
 * should return non-zero exit codes rather than throwing for command failure.
 */
export interface GitInvoker {
  (
    cwd: string,
    args: string[],
    options?: GitInvokeOptions,
  ): GitInvokeResult | Promise<GitInvokeResult>;
}

export interface SyncGitInvoker {
  (cwd: string, args: string[]): GitInvokeResult;
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_GIT_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_EXIT_CODE = 124;
const GIT_SPAWN_ERROR_EXIT_CODE = 127;
const NOT_A_GIT_REPOSITORY = /not a git repository|outside repository|this operation must be run in a work tree/i;

export function defaultGitInvokerSync(): SyncGitInvoker {
  return (cwd: string, args: string[]) => {
    const result = launchProcessSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      shell: false,
    });
    if (result.error) return { stdout: "", exitCode: GIT_SPAWN_ERROR_EXIT_CODE };
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: result.stderr ?? "",
      exitCode: typeof result.status === "number" ? result.status : 1,
    };
  };
}

export function defaultGitInvoker(): GitInvoker {
  return (cwd, args, options = {}) => {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : abortError("git context resolution aborted");
    }

    const child = launchProcess("git", args, {
      cwd,
      encoding: "utf-8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { promise, resolve, reject } = Promise.withResolvers<GitInvokeResult>();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.abortSignal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: GitInvokeResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
      fail(
        options.abortSignal?.reason instanceof Error
          ? options.abortSignal.reason
          : abortError("git context resolution aborted"),
      );
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string | Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", () => finish({ stdout: "", exitCode: GIT_SPAWN_ERROR_EXIT_CODE }));
    child.once("close", (exitCode: number | null) => {
      finish({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const timeoutMs = Math.max(
      1,
      Math.min(DEFAULT_GIT_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS),
    );
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ stdout: "", exitCode: GIT_TIMEOUT_EXIT_CODE });
    }, timeoutMs);
    if (options.abortSignal?.aborted) onAbort();
    return promise;
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

/**
 * Normalize a git remote URL so that equivalent SSH / HTTPS forms of the
 * same repo produce the same `projectId`. Handles:
 *   - `git@github.com:foo/bar.git`  → `github.com/foo/bar`
 *   - `https://github.com/foo/bar`  → `github.com/foo/bar`
 *   - `https://github.com/foo/bar.git` → `github.com/foo/bar`
 *   - `ssh://git@github.com/foo/bar` → `github.com/foo/bar`
 *   - `ssh://git@github.com:2222/foo/bar` → `github.com/foo/bar` (port stripped)
 *
 * Case-insensitive (remote hostnames and most repo paths on major forges are
 * case-insensitive in practice).
 */
export function normalizeOriginUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (!url) return "";

  if (/\.git$/i.test(url)) url = url.slice(0, -4);

  if (/^[A-Za-z]:[\\/]/.test(url)) {
    return url.toLowerCase();
  }

  //
  const protoMatch =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]*)(?::(\d+))?(\/.*)?$/i.exec(url);
  if (protoMatch) {
    let host = protoMatch[1] ?? "";
    const wasBracketed =
      host.startsWith("[") && host.endsWith("]");
    if (wasBracketed) host = host.slice(1, -1);
    const port = protoMatch[2];
    const repoPath = (protoMatch[3] ?? "").replace(/^\/+/, "");
    const hostPort = port
      ? wasBracketed
        ? `[${host}]:${port}`
        : `${host}:${port}`
      : host;
    const prefix = hostPort.length > 0 ? hostPort : "localhost";
    return `${prefix}/${repoPath}`.toLowerCase();
  }

  //
  //
  const scpMatch =
    /^(?:([^@\s/]+)@)?(\[[^\]]+\]|[^:@\s/]+):(.+)$/.exec(url);
  if (scpMatch) {
    let host = scpMatch[2] ?? "";
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    const repoPath = scpMatch[3] ?? "";
    if (repoPath.startsWith("//")) {
      return url.toLowerCase();
    }
    return `${host}/${repoPath.replace(/^\/+/, "")}`.toLowerCase();
  }

  return url.toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────

export interface ResolveGitContextOptions {
  invoker?: GitInvoker;
  abortSignal?: AbortSignal;
  /** Absolute epoch deadline shared with the extraction lifecycle. */
  deadlineMs?: number;
  now?: () => number;
  cache?: GitContextCache;
}

export class GitContextCache {
  private readonly entries = new Map<string, { value: GitContext | null; head?: string; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  private readonly cacheRepos: boolean;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number; cacheRepos?: boolean } = {}) {
    this.cacheRepos = options.cacheRepos ?? true;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** `undefined` = miss; `value: null` = cached "not a repo". */
  get(key: string): { value: GitContext | null; head?: string } | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, value: GitContext | null, head?: string): void {
    if (value !== null && !this.cacheRepos) return;
    this.entries.delete(key);
    this.entries.set(key, { value, head, at: this.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

/**
 * Detect the git project + branch for `cwd`.
 *
 * Returns `null` when `cwd` is invalid, outside a worktree, or git is
 * unavailable. Unexpected command failures also resolve to `null`.
 *
 * Caller cancellation and an exhausted deadline reject so lifecycle callers
 * can stop promptly instead of treating an interrupted probe as "not a repo".
 */
export async function resolveGitContext(
  cwd: string,
  options: ResolveGitContextOptions = {},
): Promise<GitContext | null> {
  const { cache } = options;
  if (!cache) return resolveGitContextUncached(cwd, options);
  throwIfInterrupted(options);
  const hit = cache.get(cwd);
  if (hit?.value === null) return null;
  if (hit?.value && hit.head !== undefined && (await readHeadFile(hit.value.rootPath)) === hit.head) {
    return { ...hit.value };
  }
  let inconclusive = false;
  let head: string | undefined;
  const inner = options.invoker ?? defaultGitInvoker();
  const invoker: GitInvoker = async (probeCwd, args, invokeOptions) => {
    let result: GitInvokeResult;
    try {
      result = await inner(probeCwd, args, invokeOptions);
    } catch (err) {
      inconclusive = true;
      throw err;
    }
    if (result.exitCode === GIT_TIMEOUT_EXIT_CODE || result.exitCode === GIT_SPAWN_ERROR_EXIT_CODE) inconclusive = true;
    if (args[1] === "--show-toplevel" && result.exitCode === 0) head = await readHeadFile(result.stdout.trim());
    return result;
  };
  const value = await resolveGitContextUncached(cwd, { ...options, invoker });
  if (inconclusive || options.abortSignal?.aborted) return value;
  if (value === null || head !== undefined) cache.set(cwd, value && { ...value }, head);
  return value;
}

/**
 * Raw `HEAD` contents without spawning git, or `undefined` when they cannot
 * vouch for the branch: unreadable, a symlinked HEAD (old
 * `core.preferSymlinkRefs`), or reftable's constant `refs/heads/.invalid`
 * placeholder (HEAD never changes on checkout there). Callers then re-resolve.
 */
async function readHeadFile(rootPath: string): Promise<string | undefined> {
  try {
    let gitDir = path.join(rootPath, ".git");
    if ((await stat(gitDir)).isFile()) {
      // Linked worktree: `.git` is a file pointing at the real git dir.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(gitDir, "utf-8"));
      if (!pointer?.[1]) return undefined;
      gitDir = path.resolve(rootPath, pointer[1].trim());
    }
    const headPath = path.join(gitDir, "HEAD");
    if ((await lstat(headPath)).isSymbolicLink()) return undefined;
    const head = await readFile(headPath, "utf-8");
    return head.includes("refs/heads/.invalid") ? undefined : head;
  } catch {
    return undefined;
  }
}

function throwIfInterrupted(options: ResolveGitContextOptions): void {
  if (options.abortSignal?.aborted) {
    throw options.abortSignal.reason instanceof Error
      ? options.abortSignal.reason
      : abortError("git context resolution aborted");
  }
  if (options.deadlineMs !== undefined && (options.now ?? Date.now)() >= options.deadlineMs) {
    throw abortError("git context resolution deadline exceeded");
  }
}

async function resolveGitContextUncached(
  cwd: string,
  options: ResolveGitContextOptions,
): Promise<GitContext | null> {
  try {
    if (typeof cwd !== "string" || cwd.length === 0) return null;

    const expanded = expandTildePath(cwd);
    if (!path.isAbsolute(expanded)) return null;

    const invoker = options.invoker ?? defaultGitInvoker();
    const now = options.now ?? Date.now;
    const invoke = async (probeCwd: string, args: string[]): Promise<GitInvokeResult> => {
      if (options.abortSignal?.aborted) {
        throw options.abortSignal.reason instanceof Error
          ? options.abortSignal.reason
          : abortError("git context resolution aborted");
      }
      const remainingMs =
        options.deadlineMs === undefined ? DEFAULT_GIT_TIMEOUT_MS : options.deadlineMs - now();
      if (remainingMs <= 0) throw abortError("git context resolution deadline exceeded");
      return invoker(probeCwd, args, {
        abortSignal: options.abortSignal,
        timeoutMs: Math.min(DEFAULT_GIT_TIMEOUT_MS, remainingMs),
      });
    };

    const topLevel = await invoke(expanded, ["rev-parse", "--show-toplevel"]);
    if (topLevel.exitCode !== 0) return null;
    const rootPath = topLevel.stdout.trim();
    if (!rootPath) return null;

    // 2. Current branch. `--abbrev-ref HEAD` returns `HEAD` in detached
    //    state, which we normalize to `null`. On a fresh `git init` the
    //    HEAD ref is unborn and `--abbrev-ref HEAD` fails, but
    //    `symbolic-ref HEAD` still returns the target branch. Fall back
    //    so newly-initialized repos get a sensible branch name.
    const branchResult = await invoke(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch: string | null = null;
    if (branchResult.exitCode === 0) {
      const raw = branchResult.stdout.trim();
      branch = raw && raw !== "HEAD" ? raw : null;
    } else {
      const unbornRef = await invoke(rootPath, ["symbolic-ref", "--quiet", "HEAD"]);
      if (unbornRef.exitCode === 0) {
        const raw = unbornRef.stdout.trim();
        const prefix = "refs/heads/";
        if (raw.startsWith(prefix)) {
          const candidate = raw.slice(prefix.length);
          if (candidate) branch = candidate;
        }
      }
    }

    const originResult = await invoke(rootPath, ["remote", "get-url", "origin"]);
    let projectId: string;
    if (originResult.exitCode === 0) {
      const normalized = normalizeOriginUrl(originResult.stdout);
      projectId = normalized ? `origin:${stableHash(normalized)}` : `root:${stableHash(rootPath)}`;
    } else {
      projectId = `root:${stableHash(rootPath)}`;
    }

    const headRef = await invoke(rootPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    let defaultBranch: string | null = null;
    if (headRef.exitCode === 0) {
      const raw = headRef.stdout.trim();
      const prefix = "refs/remotes/origin/";
      if (raw.startsWith(prefix)) {
        const candidate = raw.slice(prefix.length);
        if (candidate) defaultBranch = candidate;
      }
    }

    return {
      projectId,
      branch,
      rootPath,
      defaultBranch,
    };
  } catch {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : abortError("git context resolution aborted");
    }
    if (options.deadlineMs !== undefined && (options.now ?? Date.now)() >= options.deadlineMs) {
      throw abortError("git context resolution deadline exceeded");
    }
    return null;
  }
}

export const sharedGitContextCache = new GitContextCache();

/**
 * Session-attach callers snapshot the branch once per session, so they must
 * read a repo fresh; they only skip repeat probes of non-repo directories.
 */
export const sharedNonRepoGitContextCache = new GitContextCache({ cacheRepos: false });

/**
 * A probe verdict: `context` is the resolved context or `null`, and
 * `conclusive` tells the two nulls apart. `conclusive: true` means git
 * answered (a real repo or a confirmed non-repo); `conclusive: false` means
 * the probe itself failed — spawn error, timeout, or an invoker throw —
 * so the null carries no evidence about the directory.
 */
export interface GitContextProbeResult {
  context: GitContext | null;
  conclusive: boolean;
}

/**
 * `resolveGitContext` with the inconclusive distinction surfaced: the
 * existing cache path already refuses to cache timeout/spawn-failure
 * results, so a cached `null` is conclusive by construction. Callers that
 * clear state on `null` (the plugin's coding-context sync) must only do so
 * on a conclusive verdict.
 */
export async function probeGitContext(
  cwd: string,
  options: ResolveGitContextOptions = {},
): Promise<GitContextProbeResult> {
  let inconclusive = false;
  const inner = options.invoker ?? defaultGitInvoker();
  const invoker: GitInvoker = async (probeCwd, args, invokeOptions) => {
    let result: GitInvokeResult;
    try {
      result = await inner(probeCwd, args, invokeOptions);
    } catch (err) {
      inconclusive = true;
      throw err;
    }
    if (result.exitCode === GIT_TIMEOUT_EXIT_CODE || result.exitCode === GIT_SPAWN_ERROR_EXIT_CODE) {
      inconclusive = true;
    } else if (
      args[0] === "rev-parse" && args.includes("--show-toplevel")
      && result.exitCode !== 0 && result.stderr !== undefined && !NOT_A_GIT_REPOSITORY.test(result.stderr)
    ) {
      // The repo probe's nonzero exit decides "not a repo", but dubious
      // ownership, a corrupt .git or an unreadable cwd exit the same 128 —
      // only git's own "not a repository" answer is conclusive.
      inconclusive = true;
    }
    return result;
  };
  const context = await resolveGitContext(cwd, { ...options, invoker });
  return { context, conclusive: !inconclusive };
}
