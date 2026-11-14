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
// Public types
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
// Default git invoker — spawns real `git` via the shared child-process helper
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_GIT_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_EXIT_CODE = 124;
const GIT_SPAWN_ERROR_EXIT_CODE = 127;

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
      stdio: ["ignore", "pipe", "ignore"],
    });
    const { promise, resolve, reject } = Promise.withResolvers<GitInvokeResult>();
    let stdout = "";
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
    child.once("error", () => finish({ stdout: "", exitCode: GIT_SPAWN_ERROR_EXIT_CODE }));
    child.once("close", (exitCode: number | null) => {
      finish({ stdout, exitCode: typeof exitCode === "number" ? exitCode : 1 });
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
// Stable hashing
// ──────────────────────────────────────────────────────────────────────────

/**
 * Non-cryptographic stable hash. Used only to derive a deterministic
 * `projectId` from either the origin URL or the root path. The hash does not
 * need to be collision-resistant against adversarial input — it is purely a
 * namespace discriminator.
 *
 * Uses FNV-1a 32-bit so we don't pull in `node:crypto` for a simple bucket
 * key. Output is lowercase hex, zero-padded to 8 characters.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ──────────────────────────────────────────────────────────────────────────
// Origin URL normalization
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

  // Strip trailing `.git` case-insensitively — the whole result is
  // lowercased at the end, so `.GIT` / `.Git` must be treated the same as
  // `.git`. Previously the `.endsWith(".git")` check let `.GIT` leak
  // through and appear in the output.
  if (/\.git$/i.test(url)) url = url.slice(0, -4);

  // Windows drive-letter local path (e.g. `C:/repos/app`): detect here
  // so the scp matcher below can accept single-character SSH host aliases
  // (`h:foo/bar` from `.ssh/config`). A drive letter is exactly one ASCII
  // letter followed by `:/` or `:\`; SSH aliases never have a slash
  // immediately after the colon.
  if (/^[A-Za-z]:[\\/]/.test(url)) {
    return url.toLowerCase();
  }

  // Protocol-prefixed: ssh://, https://, http://, git://, file://
  // Must be tried FIRST so that scp-style detection below doesn't
  // incorrectly swallow an ssh:// URL that happens to contain `:port/`.
  //
  // Matches:
  //   1: host — bracketed IPv6 `[2001:db8::1]`, plain host with no `:` / `/`,
  //      OR empty (for `file:///path` which has no host component).
  //   2: port (optional) — preserved in the output so two repos on the same
  //      host under different ports get distinct project namespaces.
  //      Losing the port risked false-coalescing separate repos on custom
  //      SSH mesh setups.
  //   3: path (optional)
  const protoMatch =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(\[[^\]]+\]|[^/:]*)(?::(\d+))?(\/.*)?$/i.exec(url);
  if (protoMatch) {
    let host = protoMatch[1] ?? "";
    // Detect IPv6 via the bracketed input form BEFORE stripping brackets,
    // so that when we later re-attach a port we can preserve the
    // `[host]:port` boundary. Without the brackets, `host:2222` is
    // ambiguous with a longer bare IPv6 address like `2001:db8::1:2222`.
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
    // For protocols without a host component (file:///path), fall back to
    // a stable prefix so distinct local paths don't collapse to "/path".
    const prefix = hostPort.length > 0 ? hostPort : "localhost";
    return `${prefix}/${repoPath}`.toLowerCase();
  }

  // scp-like syntax: [user@]host:path. Protocol-prefixed URLs (`scheme://`)
  // are handled above, so the scp branch below guards against them: a
  // matched `host` of `scheme` followed by a path starting with `//` is
  // a protocol URL that fell through and must NOT be parsed here.
  // `user@` is optional — git also accepts userless scp forms like
  // `host:org/repo`. Valid scp paths may start with digits (e.g.
  // `git@host:123/repo.git`), so no numeric guard is needed: port-bearing
  // URLs have the `://` prefix and match the protocol branch above before
  // reaching here.
  //
  // Windows drive letters were filtered above, so single-character SSH
  // host aliases (`h:foo/bar`) are accepted here.
  //
  // Bracketed IPv6 (`[2001:db8::1]`) is supported: the host alternative
  // matches the bracketed literal up to `]` without splitting on internal
  // `:`. Brackets are stripped in the normalised form so the scp and
  // `ssh://` forms of the same IPv6 remote produce identical projectIds.
  const scpMatch =
    /^(?:([^@\s/]+)@)?(\[[^\]]+\]|[^:@\s/]+):(.+)$/.exec(url);
  if (scpMatch) {
    let host = scpMatch[2] ?? "";
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    const repoPath = scpMatch[3] ?? "";
    // Reject protocol-like leftovers (e.g. `file:///path` where the scp
    // regex greedily matched `file` as host and `///path` as path).
    if (repoPath.startsWith("//")) {
      return url.toLowerCase();
    }
    return `${host}/${repoPath.replace(/^\/+/, "")}`.toLowerCase();
  }

  // Fallback: use raw lowercased
  return url.toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────
// Resolver
// ──────────────────────────────────────────────────────────────────────────

export interface ResolveGitContextOptions {
  /** Inject a git invoker (tests). Defaults to spawning real `git`. */
  invoker?: GitInvoker;
  abortSignal?: AbortSignal;
  /** Absolute epoch deadline shared with the extraction lifecycle. */
  deadlineMs?: number;
  /** Injectable clock for deadline tests. */
  now?: () => number;
  /**
   * Share results across calls. Each miss costs up to five `git` spawns on the
   * event loop, so per-request callers (recall, memory_store) pass one.
   */
  cache?: GitContextCache;
}

/** Short-lived, bounded memo of git resolution per cwd (COS-666). */
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
    // Negative-only caches never hold a branch, so a session snapshot taken
    // from them cannot carry a stale one.
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
  // A cache hit must not mask cancellation or an exhausted deadline.
  throwIfInterrupted(options);
  const hit = cache.get(cwd);
  if (hit?.value === null) return null;
  // The branch picks the write/recall namespace and git alone decides it, so a
  // hit is served only while HEAD is byte-identical to what git answered for.
  if (hit?.value && hit.head !== undefined && (await readHeadFile(hit.value.rootPath)) === hit.head) {
    return { ...hit.value };
  }
  // Timeouts and spawn failures are not answers about the repo, so a lookup
  // that hit one (even partially) is never cached.
  let inconclusive = false;
  // HEAD is snapshotted once git names the root and BEFORE the branch probe: a
  // checkout racing the probe then leaves the entry older than HEAD, so the
  // next hit mismatches and re-resolves (never a stale branch pinned to a new HEAD).
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
  if (value === null || head !== undefined) cache.set(cwd, value, head);
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
  // Wrap the whole body so the documented "Never throws" contract is
  // enforced. Possible throw sites include:
  //   - `expandTildePath` → `resolveHomeDir()` → `os.homedir()` when HOME
  //     is unset (e.g. minimal containers)
  //   - a custom `options.invoker` that raises instead of returning a
  //     non-zero exitCode
  //   - any future helper added to this chain
  // All of those map to "not in a repo" / `null`.
  try {
    // Validate input: must be a non-empty string.
    if (typeof cwd !== "string" || cwd.length === 0) return null;

    // Expand `~` per CLAUDE.md #17, then require absolute path.
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

    // 1. Locate the repo root.
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

    // 3. Origin URL — optional. Used to derive a stable `projectId`.
    const originResult = await invoke(rootPath, ["remote", "get-url", "origin"]);
    let projectId: string;
    if (originResult.exitCode === 0) {
      const normalized = normalizeOriginUrl(originResult.stdout);
      projectId = normalized ? `origin:${stableHash(normalized)}` : `root:${stableHash(rootPath)}`;
    } else {
      projectId = `root:${stableHash(rootPath)}`;
    }

    // 4. Default branch — best effort.
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

/** Process-wide cache for per-request callers (recall scope). */
export const sharedGitContextCache = new GitContextCache();

/**
 * Session-attach callers snapshot the branch once per session, so they must
 * read a repo fresh; they only skip repeat probes of non-repo directories.
 */
export const sharedNonRepoGitContextCache = new GitContextCache({ cacheRepos: false });
