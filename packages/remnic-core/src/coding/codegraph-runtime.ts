/**
 * Runtime bridge between the access surfaces (MCP/HTTP/CLI) and the optional
 * @remnic/coding-graph package (issue #1554).
 *
 * WHY THIS MODULE EXISTS
 *
 * The 14 codegraph parity tools (`codegraph_index`, `search_graph`, ...) must
 * not bundle @remnic/coding-graph into @remnic/core -- it is an optional peer
 * dependency that hosts opt into. Every code path that needs a GraphStore
 * calls {@link getCodegraphStore} here; this module owns:
 *
 *   - the loader boundary (one place that dynamically imports the optional
 *     package; CLAUDE.md rule 57 / AGENTS.md rule 44 documented exception --
 *     the optional peer genuinely does not exist on every install);
 *   - per-project GraphStore caching (one open SQLite handle per
 *     `(principal, projectId)` pair, lifecycle-tracked so a host process can
 *     close them on shutdown);
 *   - DB path resolution -- the on-disk location of each project's graph DB,
 *     derived from `codingKnowledge.codegraphDbDir` or memoryDir.
 *
 * No orchestrator imports (rule 11 -- no shared mutable state). No access to
 * the access-service facade: this module is the borrowed dependency, called
 * by the surface handler via a context seam.
 */
import path from "node:path";
import { expandTildePath } from "../utils/path.js";

import type { PluginConfig, CodingKnowledgeConfig, CodingContext } from "../types.js";
import { isCodingGraphInstalled } from "./optional-coding-graph.js";

// Lazy-loaded optional package -- see file header. The dynamic import below
// is the documented exception to the static-import rule: @remnic/coding-graph
// is an optional peer dependency that is genuinely absent on base installs,
// so a static import would either fail the base install or be bundled into
// @remnic/core's dist. The specifier is composed from string literals to
// keep this a runtime-only reference.
const CODEGRAPH_SPECIFIER = "@remnic/" + "coding-graph";

/**
 * Minimal structural shape of the @remnic/coding-graph public surface this
 * runtime needs. Kept hand-written (not imported) so core compiles on the
 * base install where the optional peer is absent.
 */
interface CodegraphModule {
  GraphStore: {
    open(options: { dbPath: string; repoRoot?: string }): Promise<CodegraphStore>;
  };
}

/**
 * The narrow GraphStore surface the codegraph tools call into. Methods here
 * mirror the public class exported by @remnic/coding-graph; the runtime
 * never invents new ones.
 */
export interface CodegraphStore {
  schemaVersion(): number;
  schemaStats(): CodegraphSchemaStatsResult;
  searchGraph(query: unknown): CodegraphSearchResult;
  traverse(query: unknown): CodegraphTraverseResult;
  snippetFor(query: unknown): Promise<CodegraphSnippetResult>;
  deadCode(): CodegraphDeadCodeResult;
  close(): Promise<void>;
}

export type CodegraphSchemaStatsResult =
  | { ok: true; fileCount: number; nodeCount: number; edgeCount: number; symbolKinds: Record<string, number> }
  | { ok: false; code: string };

export type CodegraphSearchResult =
  | { ok: true; hits: unknown[] }
  | { ok: false; code: string };

export type CodegraphTraverseResult =
  | { ok: true; hits: unknown[] }
  | { ok: false; code: string };

export type CodegraphSnippetResult =
  | { ok: true; snippet: string; startLine: number; endLine: number }
  | { ok: false; code: string };

export type CodegraphDeadCodeResult =
  | { ok: true; hits: unknown[] }
  | { ok: false; code: string };

// ──────────────────────────────────────────────────────────────────────────
// Gate predicate — rule 39: ONE predicate, identical on every surface
// ──────────────────────────────────────────────────────────────────────────

/**
 * Config-only visibility gate. Returns true iff the master
 * `codingKnowledge.enabled` switch AND the `codegraphTools` feature switch
 * are both on. The tools/list visibility check, the HTTP route guard, and
 * the CLI command guard all read this predicate (or its runtime-tightened
 * sibling {@link codegraphRuntimeAvailable}) -- never the raw config flags.
 *
 * When this returns false the MCP `tools/list` is byte-identical to
 * pre-feature (rule 39).
 */
export function codegraphSurfaceVisible(config: PluginConfig): boolean {
  const ck = config.codingKnowledge;
  // Guard: some code paths (test stubs, partially-constructed configs) may
  // not have codingKnowledge populated. Fail closed — tools hidden.
  if (ck === undefined || ck === null) return false;
  return ck.enabled === true && ck.codegraphTools === true;
}

/**
 * Runtime-availability predicate -- tightens the config gate with the
 * loader probe. Call sites that are about to OPEN a GraphStore must use
 * this (config alone is insufficient; the package may be missing).
 *
 * Cached: the loader probe's outcome is memoized by optional-coding-graph.ts
 * (see its file header -- success and absent outcomes are sticky). This
 * function never throws.
 */
export async function codegraphRuntimeAvailable(config: PluginConfig): Promise<boolean> {
  return codegraphSurfaceVisible(config) && (await isCodingGraphInstalled());
}

// ──────────────────────────────────────────────────────────────────────────
// DB path resolution -- rule 11 (no path assembly at call sites)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Resolve a per-project graph DB path. The layout is:
 *
 *   <codegraphDbDir>/<principalSafe>/<projectIdSafe>.sqlite     (explicit root)
 *   <memoryDir>/codegraph/<principalSafe>/<projectIdSafe>.sqlite (default)
 *
 * Both `principalSafe` and `projectIdSafe` are sanitized to a stable,
 * filesystem-safe token so a hostile project id (e.g. `../../etc/passwd`)
 * cannot escape the codegraph root. The function never touches the
 * filesystem -- callers create the parent directory before opening the DB.
 */
export function resolveCodegraphDbPath(params: {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  readonly principal: string;
  readonly projectId: string;
}): string {
  const { config, memoryDir, principal, projectId } = params;
  const rawDir = config.codingKnowledge.codegraphDbDir.trim();
  const root =
    rawDir.length > 0
      ? expandTildePath(rawDir)
      : path.join(memoryDir, "codegraph");
  const principalSafe = sanitizePathSegment(principal);
  const projectSafe = sanitizePathSegment(projectId);
  return path.join(root, principalSafe, `${projectSafe}.sqlite`);
}

/**
 * Reject anything that is not a flat, filesystem-safe token. `_` is the
 * canonical fallback so an empty/whitespace principal still lands in a
 * stable per-process directory rather than the root.
 */
function sanitizePathSegment(input: string): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length === 0) return "_";
  // Permit letters, digits, dash, underscore, dot, colon -- the stable
  // characters that appear in projectId (`origin:<hex>`, `root:<hex>`)
  // and principal (`alice`, `team-foo`). Everything else collapses to `_`.
  const sanitized = trimmed.replace(/[^A-Za-z0-9._:-]+/g, "_");
  // Strip leading dots so the segment cannot be `.` / `..` and refuse any
  // path separator that survived (defense-in-depth).
  return sanitized.replace(/^\.+/, "").replace(/[/\\]+/g, "_") || "_";
}

// ──────────────────────────────────────────────────────────────────────────
// Per-project store cache
// ──────────────────────────────────────────────────────────────────────────

interface CachedStore {
  readonly store: CodegraphStore;
  readonly repoRoot: string | undefined;
  /** Monotonic so closeAll() drains in FIFO order. */
  readonly openedAt: number;
}

const storeCache = new Map<string, CachedStore>();
let cachedModule: CodegraphModule | null | undefined;
let moduleLoadPromise: Promise<CodegraphModule | null> | null = null;

function storeCacheKey(principal: string, projectId: string): string {
  return `${principal}::${projectId}`;
}

/**
 * Dynamically import the optional package ONCE per process. Subsequent
 * callers await the same promise. Missing/incompatible installs collapse
 * to `null` (graceful degradation -- surfaces translate to a clean hint).
 */
async function loadCodegraphModule(): Promise<CodegraphModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  if (moduleLoadPromise === null) {
    moduleLoadPromise = (async () => {
      try {
        const mod = (await import(CODEGRAPH_SPECIFIER)) as Partial<CodegraphModule>;
        if (mod && typeof mod === "object" && mod.GraphStore && typeof mod.GraphStore.open === "function") {
          cachedModule = mod as CodegraphModule;
          return cachedModule;
        }
        cachedModule = null;
        return null;
      } catch {
        cachedModule = null;
        return null;
      }
    })();
  }
  return moduleLoadPromise;
}

/**
 * Resolve a per-project store. The cache returns the SAME handle for the
 * same `(principal, projectId)` pair; the repoRoot that wins is the FIRST
 * opener's -- subsequent openers with a different repoRoot are rejected
 * (rule 42 -- a session cannot rebind another session's graph to a
 * different repo mid-flight).
 *
 * The `codingKnowledge` gate is RE-CHECKED here (defense-in-depth) even
 * though the surface handler already gated; a direct caller that bypasses
 * the handler still cannot open a store on a disabled config.
 */
export async function getCodegraphStore(params: {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  readonly principal: string;
  readonly projectId: string;
  readonly repoRoot?: string;
}): Promise<CodegraphStore> {
  const { config, memoryDir, principal, projectId, repoRoot } = params;
  if (!codegraphSurfaceVisible(config)) {
    throw new CodegraphRuntimeError(
      "disabled",
      "codegraph tools are disabled (codingKnowledge.enabled or codingKnowledge.codegraphTools is false)",
    );
  }
  const mod = await loadCodegraphModule();
  if (mod === null) {
    throw new CodegraphRuntimeError(
      "package_missing",
      "The @remnic/coding-graph package is not installed; install it to use codegraph tools.",
    );
  }
  // Key the cache on SANITIZED values so two different raw identifiers
  // that sanitize to the same path segment share one store handle
  // (prevents two open handles on the same SQLite file).
  const principalSafe = sanitizePathSegment(principal);
  const projectSafe = sanitizePathSegment(projectId);
  const key = storeCacheKey(principalSafe, projectSafe);
  const cached = storeCache.get(key);
  if (cached !== undefined) {
    if (repoRoot !== undefined && cached.repoRoot !== undefined && cached.repoRoot !== repoRoot) {
      throw new CodegraphRuntimeError(
        "repo_root_conflict",
        `codegraph store for project ${projectId} is already bound to repo root ${cached.repoRoot}; refusing to rebind to ${repoRoot}`,
      );
    }
    return cached.store;
  }
  const dbPath = resolveCodegraphDbPath({ config, memoryDir, principal, projectId });
  const store = await mod.GraphStore.open({ dbPath, repoRoot });
  storeCache.set(key, { store, repoRoot, openedAt: Date.now() });
  return store;
}

/**
 * List projects known to this principal by walking the codegraph root for
 * `.sqlite` files. Pure-filesystem; no store opens. Returns project ids in
 * the same sanitized form they were stored under.
 */
export function listCodegraphProjects(params: {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  readonly principal: string;
  readonly listDir: (dir: string) => readonly string[];
}): readonly string[] {
  const { config, memoryDir, principal, listDir } = params;
  if (!codegraphSurfaceVisible(config)) return [];
  const rawDir = config.codingKnowledge.codegraphDbDir.trim();
  const root =
    rawDir.length > 0
      ? expandTildePath(rawDir)
      : path.join(memoryDir, "codegraph");
  const principalSafe = sanitizePathSegment(principal);
  const principalDir = path.join(root, principalSafe);
  let entries: readonly string[];
  try {
    entries = listDir(principalDir);
  } catch {
    return [];
  }
  const projects: string[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".sqlite")) {
      projects.push(entry.slice(0, -".sqlite".length));
    }
  }
  return projects;
}

/**
 * Drop a project's store from the cache (closing its handle) AND delete the
 * on-disk DB file. Idempotent: a missing project is a no-op. The caller
 * MUST pass `confirm: true` -- this is the rule-48 explicit-confirm
 * invariant for destructive operations; never defaulted to proceed.
 */
export async function deleteCodegraphProject(params: {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  readonly principal: string;
  readonly projectId: string;
  readonly confirm: boolean;
  readonly removeFile: (filePath: string) => void;
}): Promise<{ deleted: boolean; projectId: string }> {
  const { config, memoryDir, principal, projectId, confirm, removeFile } = params;
  if (!confirm) {
    throw new CodegraphRuntimeError(
      "confirm_required",
      "codegraph_delete_project requires confirm: true; destructive operations are never defaulted to proceed (rule 48)",
    );
  }
  if (!codegraphSurfaceVisible(config)) {
    throw new CodegraphRuntimeError("disabled", "codegraph tools are disabled");
  }
  const key = storeCacheKey(principal, projectId);
  const cached = storeCache.get(key);
  if (cached !== undefined) {
    storeCache.delete(key);
    try {
      await cached.store.close();
    } catch {
      // Best-effort close; the file delete below still proceeds.
    }
  }
  const dbPath = resolveCodegraphDbPath({ config, memoryDir, principal, projectId });
  let deleted = false;
  try {
    removeFile(dbPath);
    deleted = true;
  } catch (err) {
    // ENOENT means the file was already absent — treat as deleted (idempotent).
    // All other errors (EACCES, EISDIR, ...) surface as deleted=false.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      deleted = true;
    } else {
      deleted = false;
    }
  }
  return { deleted, projectId };
}

/** Drain and close every cached store. Used by the daemon shutdown path. */
export async function closeAllCodegraphStores(): Promise<void> {
  const entries = [...storeCache.values()];
  storeCache.clear();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        await entry.store.close();
      } catch {
        // Best-effort.
      }
    }),
  );
}

/** Test seam: reset the module cache so a fresh import can be observed. */
export function __resetCodegraphRuntimeForTest(): void {
  cachedModule = undefined;
  moduleLoadPromise = null;
  storeCache.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Tagged runtime error -- `code` is the load-bearing signal (rule 34)
// ──────────────────────────────────────────────────────────────────────────

export type CodegraphRuntimeErrorCode =
  | "disabled"
  | "package_missing"
  | "repo_root_conflict"
  | "confirm_required"
  | "project_not_found"
  | "store_error";

export class CodegraphRuntimeError extends Error {
  readonly code: CodegraphRuntimeErrorCode;
  constructor(code: CodegraphRuntimeErrorCode, message: string) {
    super(message);
    this.name = "CodegraphRuntimeError";
    this.code = code;
  }
}

// Re-export the gate predicate's input type for callers that only need the
// config slice (e.g. surface modules that receive CodingKnowledgeConfig).
export type { CodingKnowledgeConfig, CodingContext };
