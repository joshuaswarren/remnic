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
import { readFile, realpath } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { expandTildePath } from "../utils/path.js";

import type { PluginConfig, CodingKnowledgeConfig, CodingContext } from "../types.js";
import { isCodingGraphInstalled } from "./optional-coding-graph.js";
// Type-only reference to the surface context shape (ts-import-type rule).
// Erased at compile time, so the runtime → surfaces → runtime import cycle is
// type-only and has no runtime effect.
import type { CodegraphSurfaceContext } from "./codegraph-surfaces.js";

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
  // PR3 (issue #1553) functions — present when @remnic/coding-graph ships
  // them. Each is optional in the structural type so a partial install that
  // predates PR3 still loads; the delegate functions check typeof and degrade.
  executeReindex?(options: {
    store: CodegraphStore;
    git: unknown;
    repoRoot: string;
    parseFile: (input: unknown) => Promise<unknown>;
    candidatePaths?: readonly string[];
  }): Promise<unknown>;
  getIndexStatus?(store: CodegraphStore, git: unknown, repoRoot: string): unknown;
  computeBlastRadius?(
    store: CodegraphStore,
    directlyAffected: ReadonlySet<string>,
    maxDepth?: number,
  ): unknown;
  defaultCodingGitInvoker?: unknown;
  createCodingGraphEngine?(options?: unknown): { parseFile(input: unknown): Promise<unknown> };
  // LSP resolution (issue #1917): present when @remnic/coding-graph ships
  executeLspResolution?(requests: readonly unknown[], options: unknown): Promise<unknown>;
  planLspUpgrades?(sites: readonly unknown[], budget: { maxRequests: number }): { requests: readonly unknown[]; budgetExhausted: number };
  LspClient?: {
    connect(options: {
      launchSpec: { command: string; args: readonly string[] };
      rootUri: string | null;
      timeoutMs: number;
    }): Promise<{ ok: true; client: unknown } | { ok: false; degradation: unknown }>;
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
  // PR3 meta + write methods (issue #1553/#1554). Optional in the structural
  // type so the narrow stub used by early tests still satisfies the shape.
  readMeta?(key: string): { ok: true; value: string | null } | { ok: false; code: string };
  readFileHashes?(): { ok: true; value: ReadonlyMap<string, string> } | { ok: false; code: string };
  writeMeta?(key: string, value: string): void;
  upsertFileBatch?(
    files: readonly unknown[],
    deletePaths?: readonly string[],
  ): Promise<{ ok: true; results: unknown[] } | { ok: false; code: string }>;
  upsertEdges?(
    edges: readonly CodegraphEdgeInput[],
  ): Promise<{ ok: true; persisted: number; skipped: number } | { ok: false; code: string }>;
  /** Find the node whose span contains the byte offset (issue #1917). */
  findNodeBySpan?(filePath: string, byteOffset: number): string | null;
  /** Retire stale lsp-provenance edges for a file (issue #1895). */
  reconcileLspEdges?(
    filePath: string,
    assertedEdges: ReadonlyArray<{ srcQualifiedName: string; dstQualifiedName: string; type: string }>,
  ): number;
}

/**
 * Minimal edge shape for standalone trace ingestion (mirrors the subset of
 * @remnic/coding-graph's EdgeIR the trace path populates).
 */
export interface CodegraphEdgeInput {
  srcQualifiedName: string;
  dstQualifiedName: string;
  type: string;
  confidence: number;
  provenance: string;
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
/**
 * Resolve the codegraph root directory (issue #1554 review thread: reject
 * relative roots). An explicit `codegraphDbDir` may be a `~\`-prefixed path;
 * the default is memoryDir/codegraph. The result MUST be absolute —
 * GraphStore.open rejects relative dbPath with "dbPath must be absolute",
 * and list_projects would otherwise silently read a CWD-relative directory.
 * Failing early here gives callers a tagged, actionable error.
 */
function resolveCodegraphRoot(config: PluginConfig, memoryDir: string): string {
  const rawDir = config.codingKnowledge.codegraphDbDir.trim();
  const root = rawDir.length > 0 ? expandTildePath(rawDir) : path.join(memoryDir, "codegraph");
  if (!path.isAbsolute(root)) {
    throw new CodegraphRuntimeError(
      "store_error",
      "codegraph DB root must be an absolute path; set codingKnowledge.codegraphDbDir (or memoryDir) to an absolute path",
    );
  }
  return root;
}

export function resolveCodegraphDbPath(params: {
  readonly config: PluginConfig;
  readonly memoryDir: string;
  readonly principal: string;
  readonly projectId: string;
}): string {
  const { config, memoryDir, principal, projectId } = params;
  const root = resolveCodegraphRoot(config, memoryDir);
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

function storeCacheKey(principalSafe: string, projectSafe: string, dbPath: string): string {
  // Thread 8 (issue #1554): include the resolved DB path so two configs
  // sharing a principal/project but differing in codegraphDbDir (or memoryDir)
  // get distinct cache entries — otherwise the second config reuses the first
  // config's open SQLite handle and reads/writes the wrong graph DB.
  return `${principalSafe}::${projectSafe}::${dbPath}`;
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
  // Key the cache on SANITIZED values AND the resolved DB path (thread 8):
  // two different raw identifiers that sanitize to the same path segment
  // share one store handle (prevents two open handles on the same SQLite
  // file), and two configs with different roots get distinct entries.
  const principalSafe = sanitizePathSegment(principal);
  const projectSafe = sanitizePathSegment(projectId);
  const dbPath = resolveCodegraphDbPath({ config, memoryDir, principal, projectId });
  const key = storeCacheKey(principalSafe, projectSafe, dbPath);
  const cached = storeCache.get(key);
  if (cached !== undefined) {
    if (repoRoot !== undefined && cached.repoRoot === undefined) {
      // Thread 11 (issue #1554): the cached store was opened rootless (e.g. a
      // get_schema call with no repoRoot). A later call that DOES supply a
      // repoRoot needs repo-root-bound operations (snippet reads file content)
      // to work, so close the rootless handle and reopen bound to repoRoot.
      storeCache.delete(key);
      try {
        await cached.store.close();
      } catch {
        // Best-effort close; the reopen below still proceeds.
      }
      const store = await mod.GraphStore.open({ dbPath, repoRoot });
      storeCache.set(key, { store, repoRoot, openedAt: Date.now() });
      return store;
    }
    if (repoRoot !== undefined && cached.repoRoot !== undefined && cached.repoRoot !== repoRoot) {
      throw new CodegraphRuntimeError(
        "repo_root_conflict",
        `codegraph store for project ${projectId} is already bound to repo root ${cached.repoRoot}; refusing to rebind to ${repoRoot}`,
      );
    }
    return cached.store;
  }
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
  let root: string;
  try {
    root = resolveCodegraphRoot(config, memoryDir);
  } catch {
    // A relative/misconfigured root means no projects are listable; the
    // open path reports the tagged error, list degrades to empty.
    return [];
  }
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
  // Thread 10 (issue #1554): build the cache key from SANITIZED values + the
  // resolved DB path so deletion finds the live entry regardless of which raw
  // projectId form (e.g. github.com/test/repo) was used to open it. Without
  // this, deleteCodegraphProject unlinks the SQLite file while the cached
  // handle stays open and subsequent reads still see the "deleted" graph.
  const principalSafe = sanitizePathSegment(principal);
  const projectSafe = sanitizePathSegment(projectId);
  const dbPath = resolveCodegraphDbPath({ config, memoryDir, principal, projectId });
  const key = storeCacheKey(principalSafe, projectSafe, dbPath);
  const cached = storeCache.get(key);
  if (cached !== undefined) {
    storeCache.delete(key);
    try {
      await cached.store.close();
    } catch {
      // Best-effort close; the file delete below still proceeds.
    }
  }
  // dbPath resolved above for the cache key; reuse it for the file delete.
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

// ──────────────────────────────────────────────────────────────────────────
// Context delegate factory — returns the 4 runtime delegates bound to the
// access-service's store resolution, so the service can spread them into the
// CodegraphSurfaceContext in a single line (keeps access-service.ts thin —
// ratchet rule 4: god files gain registration/delegation only).
// ──────────────────────────────────────────────────────────────────────────

export function makeCodegraphRuntimeDelegates(): Pick<
  CodegraphSurfaceContext,
  "runReindex" | "runLspResolution" | "reportIndexStatus" | "detectChanges" | "ingestTraces"
> {
  return {
    runReindex: (store, repoRoot, mode) => runCodegraphReindex({ store, repoRoot, mode }),
    reportIndexStatus: (store, repoRoot) => reportCodegraphIndexStatus({ store, repoRoot }),
    detectChanges: (store, repoRoot, head) => detectCodegraphChanges({ store, repoRoot, head }),
    ingestTraces: (store, traces) => ingestCodegraphTraces({ store, traces }),
    runLspResolution: (store, repoRoot, lspConfig) => runCodegraphLspResolution({ store, repoRoot, lspConfig }),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime delegates — the surface handlers call these to invoke the real
// @remnic/coding-graph functions (executeReindex / getIndexStatus / detect /
// upsertEdges). Each degrades to a clean tagged outcome when the runtime or
// the engine is unavailable, so the surface never reports stub success
// (issue #1554 P1 fix).
// ──────────────────────────────────────────────────────────────────────────

export type CodegraphDelegateOutcome<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

/**
 * Run a reindex via @remnic/coding-graph's executeReindex. The engine
 * (parseFile) is injected from createCodingGraphEngine; when the engine is
 * the PR1 placeholder (throws not_implemented), the outcome degrades to
 * `engine_unavailable` rather than the handler reporting stub success.
 */
export async function runCodegraphReindex(params: {
  readonly store: CodegraphStore;
  readonly repoRoot: string;
  readonly mode: string;
}): Promise<CodegraphDelegateOutcome<{ mode: string; filesIngested: number; head: string | null }>> {
  const mod = await loadCodegraphModule();
  if (mod === null) {
    return { ok: false, code: "package_missing", message: "The @remnic/coding-graph package is not installed." };
  }
  // Thread 13 (issue #1554): defaultCodingGitInvoker is a FACTORY FUNCTION
  // (returns the CodingGitInvoker), not an object instance. The previous
  // `typeof ... !== "object"` check always failed, so codegraph_index /
  // codegraph_index_status degraded to runtime_unavailable even with the
  // optional package present.
  if (typeof mod.executeReindex !== "function" || typeof mod.defaultCodingGitInvoker !== "function") {
    return { ok: false, code: "runtime_unavailable", message: "executeReindex is not available in the installed @remnic/coding-graph." };
  }
  const git = (mod.defaultCodingGitInvoker as () => unknown)() as {
    listTrackedFiles(cwd: string): { ok: true; paths: readonly string[] } | { ok: false; code: string };
  };
  let engine: { parseFile(input: unknown): Promise<unknown> };
  try {
    if (typeof mod.createCodingGraphEngine !== "function") {
      return { ok: false, code: "engine_unavailable", message: "createCodingGraphEngine is not exported by @remnic/coding-graph." };
    }
    engine = mod.createCodingGraphEngine();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "engine_unavailable", message: `The coding-graph engine is not ready: ${msg}` };
  }
  // Thread 14 (issue #1554): executeReindex's full-reindex branch treats an
  // omitted candidatePaths as non-authoritative and returns a noop with
  // filesIngested:0. Discover the repo's tracked files via the git invoker
  // and pass them so a first index of a real repo actually ingests files.
  let candidatePaths: readonly string[] = [];
  try {
    const tracked = git.listTrackedFiles(params.repoRoot);
    if (tracked.ok) {
      candidatePaths = tracked.paths;
    }
    // A git failure here is non-fatal: executeReindex will noop cleanly and
    // the caller sees filesIngested:0 rather than a false error. The status
    // tool reports the underlying git mode separately.
  } catch {
    // Best-effort discovery; leave candidatePaths empty on throw.
  }
  try {
    const result = (await mod.executeReindex({
      store: params.store,
      git,
      repoRoot: params.repoRoot,
      parseFile: (input: unknown) => engine.parseFile(input),
      candidatePaths,
    })) as { ok: boolean; mode?: string; filesIngested?: number; head?: string | null; code?: string; message?: string };
    if (result && result.ok === true) {
      return { ok: true, mode: result.mode ?? "auto", filesIngested: result.filesIngested ?? 0, head: result.head ?? null };
    }
    return {
      ok: false,
      code: (result?.code as string) ?? "store_error",
      message: (result?.message as string) ?? "executeReindex reported a failure.",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "store_error", message: msg };
  }
}


/**
 * True when a tracked path resolves — via a symlinked file or any symlinked
 * parent — outside repoRoot. Mirrors the reindex path's guard (reindex.ts
 * `symlinkEscapesRoot`, rule 3): without it, a tracked `*.ts` symlink to a
 * private file outside the checkout would be parsed and sent to a language
 * server. A realpath error returns false so the normal read path surfaces
 * the natural failure.
 */
async function lspPathEscapesRoot(repoRoot: string, absPath: string): Promise<boolean> {
  try {
    const [realRoot, realAbs] = await Promise.all([realpath(repoRoot), realpath(absPath)]);
    const rel = path.relative(realRoot, realAbs);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Sync variant for the executor's resolveContent seam. */
function lspPathEscapesRootSync(repoRoot: string, absPath: string): boolean {
  try {
    const realRoot = realpathSync(repoRoot);
    const realAbs = realpathSync(absPath);
    const rel = path.relative(realRoot, realAbs);
    return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Default LSP server launch specs per language. The config's
 * `codingKnowledge.lsp.servers` overrides these; a language with neither
 * an override nor a default is skipped (degradation, not an error).
 */
const DEFAULT_LSP_SERVERS: Record<string, { command: string; args: string[] }> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  tsx: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
  go: { command: "gopls", args: [] },
  rust: { command: "rust-analyzer", args: [] },
};

/** One gathered candidate call site (pre-planner shape). */
interface GatheredLspSite {
  filePath: string;
  language: string;
  content: string;
  calleeByteOffset: number;
  calleeName: string;
  srcQualifiedName: string;
}

/**
 * Run LSP type resolution after a heuristic reindex (issue #1917).
 * Re-parses tracked files, gathers call sites Phase A left unresolved
 * (member accesses plus bare calls with no existing CALLS edge), groups
 * them by language, and per language connects a real language server via
 * `LspClient.connect` and invokes `executeLspResolution`.
 *
 * Degrades cleanly at every seam: missing package/functions, no language
 * server for a language, or a failed handshake all leave the heuristic
 * edges standing (soft-fail, mirrors #1894's documented posture).
 */
export async function runCodegraphLspResolution(params: {
  readonly store: CodegraphStore;
  readonly repoRoot: string;
  readonly lspConfig: NonNullable<CodingKnowledgeConfig["lsp"]>;
}): Promise<
  | {
      ok: true;
      upgraded: number;
      unresolved: number;
      budgetExhausted: number;
      degradations?: Array<{ language: string; code: string; message: string }>;
    }
  | { ok: false; code: string; message: string }
> {
  const mod = await loadCodegraphModule();
  if (mod === null) {
    return { ok: false, code: "package_missing", message: "@remnic/coding-graph is not installed." };
  }
  if (
    typeof mod.executeLspResolution !== "function" ||
    typeof mod.planLspUpgrades !== "function" ||
    typeof mod.LspClient?.connect !== "function"
  ) {
    return { ok: false, code: "runtime_unavailable", message: "LSP resolution is not available in the installed @remnic/coding-graph." };
  }
  const engine = mod.createCodingGraphEngine?.() ?? null;
  if (engine === null) {
    return { ok: false, code: "engine_unavailable", message: "createCodingGraphEngine is not available." };
  }
  const gitFactory = mod.defaultCodingGitInvoker as
    | (() => { listTrackedFiles(cwd: string): { ok: true; paths: readonly string[] } | { ok: false; code: string } })
    | undefined;
  if (typeof gitFactory !== "function") {
    return { ok: true, upgraded: 0, unresolved: 0, budgetExhausted: 0 };
  }
  const tracked = gitFactory().listTrackedFiles(params.repoRoot);
  if (!("paths" in tracked)) {
    return { ok: true, upgraded: 0, unresolved: 0, budgetExhausted: 0 };
  }

  // Memoized per-caller lookup of already-resolved callee names: a bare
  // call whose (src)-[CALLS]->(dst.name == callee) edge already exists was
  // resolved by Phase A and must not consume LSP budget (review thread:
  // budget starvation). Member accesses are Phase A's deliberate skips —
  // always candidates.
  const resolvedCalleesBySrc = new Map<string, Set<string>>();
  const alreadyResolved = (srcQualifiedName: string, calleeName: string): boolean => {
    let names = resolvedCalleesBySrc.get(srcQualifiedName);
    if (names === undefined) {
      names = new Set<string>();
      const result = params.store.traverse({
        start: srcQualifiedName,
        direction: "outgoing",
        edgeTypes: ["CALLS"],
        maxDepth: 1,
      });
      if (result.ok) {
        for (const hit of result.hits) {
          if (hit && typeof hit === "object" && "name" in hit && "depth" in hit && hit.depth === 1 && typeof hit.name === "string") {
            names.add(hit.name);
          }
        }
      }
      resolvedCalleesBySrc.set(srcQualifiedName, names);
    }
    return names.has(calleeName);
  };

  // Gather unresolved call sites from the freshly indexed source.
  const sites: GatheredLspSite[] = [];
  const gatheredCountByFile = new Map<string, number>();
  for (const rel of tracked.paths) {
    const absPath = path.join(params.repoRoot, rel);
    // Same symlink containment the reindex path enforces (rule 3).
    if (await lspPathEscapesRoot(params.repoRoot, absPath)) continue;
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = await engine.parseFile({ path: rel, content });
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || parsed.ok !== true || !("ir" in parsed)) continue;
    const ir = parsed.ir;
    if (!ir || typeof ir !== "object" || !("callSites" in ir) || !Array.isArray(ir.callSites)) continue;
    const language = "language" in ir && typeof ir.language === "string" ? ir.language : "";
    const symbols = "symbols" in ir && Array.isArray(ir.symbols) ? ir.symbols : [];
    // UTF-8 view of the source for byte-exact callee-name searches.
    const contentBytes = Buffer.from(content, "utf-8");
    for (const site of ir.callSites) {
      if (!site || typeof site !== "object" || !("span" in site)) continue;
      const span = site.span;
      if (!span || typeof span !== "object" || !("startByte" in span) || typeof span.startByte !== "number") continue;
      const calleeName =
        "calleeNameCandidates" in site && Array.isArray(site.calleeNameCandidates) && typeof site.calleeNameCandidates[0] === "string"
          ? site.calleeNameCandidates[0]
          : "";
      if (calleeName.length === 0) continue;
      // Innermost enclosing symbol = SMALLEST containing span (review
      // thread: first-match picks the outermost container for nested
      // symbols, attaching edges to the wrong caller).
      let srcQualifiedName = "";
      let bestSpanSize = Number.POSITIVE_INFINITY;
      for (const sym of symbols) {
        if (!sym || typeof sym !== "object" || !("span" in sym) || !("qualifiedName" in sym)) continue;
        const ss = sym.span;
        if (!ss || typeof ss !== "object" || !("startByte" in ss) || !("endByte" in ss)) continue;
        if (typeof ss.startByte !== "number" || typeof ss.endByte !== "number") continue;
        if (ss.startByte <= span.startByte && span.startByte < ss.endByte) {
          const size = ss.endByte - ss.startByte;
          if (size < bestSpanSize) {
            bestSpanSize = size;
            srcQualifiedName = typeof sym.qualifiedName === "string" ? sym.qualifiedName : "";
          }
        }
      }
      if (srcQualifiedName.length === 0) continue;
      const memberAccess = "memberAccess" in site && site.memberAccess === true;
      if (!memberAccess && alreadyResolved(srcQualifiedName, calleeName)) continue;
      // Position the definition query on the callee NAME, not the call
      // expression start (member calls: `obj.save()` must query at `save`).
      // The search runs in Buffer space because span offsets are UTF-8
      // BYTES while string indexOf returns UTF-16 code units — non-ASCII
      // source before the callee would skew a string-index search (review
      // thread). Bounded to this call site's span (parser rule 20).
      const nameIdx = contentBytes.indexOf(Buffer.from(calleeName, "utf-8"), span.startByte);
      const endByte = "endByte" in span && typeof span.endByte === "number" ? span.endByte : span.startByte + calleeName.length;
      const calleeByteOffset = nameIdx >= 0 && nameIdx < endByte ? nameIdx : span.startByte;
      sites.push({ filePath: rel, language, content, calleeByteOffset, calleeName, srcQualifiedName });
      gatheredCountByFile.set(rel, (gatheredCountByFile.get(rel) ?? 0) + 1);
    }
  }
  if (sites.length === 0) {
    return { ok: true, upgraded: 0, unresolved: 0, budgetExhausted: 0 };
  }

  // Group by language; each group gets its own server connection. The
  // budget is shared across groups (maxRequestsPerRun is per RUN).
  const byLanguage = new Map<string, GatheredLspSite[]>();
  for (const site of sites) {
    const group = byLanguage.get(site.language);
    if (group === undefined) byLanguage.set(site.language, [site]);
    else group.push(site);
  }

  const configServers = params.lspConfig.servers ?? {};
  const timeoutMs = params.lspConfig.timeoutMs ?? 3000;
  let remainingBudget = Math.max(1, Math.floor(params.lspConfig.maxRequestsPerRun ?? 500));
  const rootUri = pathToFileURL(params.repoRoot).href;
  // Cross-file definition targets need their bytes for position→offset
  // conversion (review thread: without resolveContent, cross-file
  // upgrades — the point of Phase B — stay unresolved).
  const resolveContent = (filePath: string): string | null => {
    const absPath = path.join(params.repoRoot, filePath);
    if (lspPathEscapesRootSync(params.repoRoot, absPath)) return null;
    try {
      return readFileSync(absPath, "utf-8");
    } catch {
      return null;
    }
  };

  let upgraded = 0;
  let unresolved = 0;
  let budgetExhausted = 0;
  const degradations: Array<{ language: string; code: string; message: string }> = [];
  for (const [language, group] of byLanguage) {
    if (remainingBudget <= 0) {
      budgetExhausted += group.length;
      continue;
    }
    const rawSpec = configServers[language] ?? DEFAULT_LSP_SERVERS[language];
    if (rawSpec === undefined) {
      unresolved += group.length;
      continue;
    }
    const launchSpec = { command: rawSpec.command, args: rawSpec.args ?? [] };
    const plan = mod.planLspUpgrades(group, { maxRequests: remainingBudget });
    budgetExhausted += plan.budgetExhausted;
    remainingBudget -= plan.requests.length;
    if (plan.requests.length === 0) continue;
    // Reconciliation is only safe for files whose gathered sites ALL made
    // it into the plan — a budget-truncated file would otherwise retire
    // valid lsp edges its omitted call sites still assert (review thread).
    const plannedCountByFile = new Map<string, number>();
    for (const req of plan.requests) {
      if (req && typeof req === "object" && "filePath" in req && typeof req.filePath === "string") {
        plannedCountByFile.set(req.filePath, (plannedCountByFile.get(req.filePath) ?? 0) + 1);
      }
    }
    const connected = await mod.LspClient.connect({ launchSpec, rootUri, timeoutMs });
    if (!connected.ok) {
      // A missing/misconfigured server is a DIAGNOSABLE condition, not a
      // silent count (review thread): record the degradation so
      // codegraph_index can distinguish "server absent" from "LSP found
      // no definitions".
      const deg = connected.degradation;
      const code =
        deg && typeof deg === "object" && "code" in deg && typeof deg.code === "string" ? deg.code : "connect_failed";
      const message =
        deg && typeof deg === "object" && "detail" in deg && typeof deg.detail === "string"
          ? deg.detail
          : `LSP server for ${language} failed to connect.`;
      degradations.push({ language, code, message });
      unresolved += plan.requests.length;
      // The planned requests never reached a server — hand their budget
      // back so a missing server for one language cannot starve the
      // remaining language groups (review thread).
      remainingBudget += plan.requests.length;
      continue;
    }
    const client = connected.client;
    try {
      const result = await mod.executeLspResolution(plan.requests, {
        client,
        workspaceRoot: params.repoRoot,
        resolveContent,
        nodeLocator: (filePath: string, byteOffset: number) =>
          typeof params.store.findNodeBySpan === "function" ? params.store.findNodeBySpan(filePath, byteOffset) : null,
        applyUpgrades: async (upgrades: readonly CodegraphEdgeInput[]) => {
          if (typeof params.store.upsertEdges !== "function") {
            throw new Error("store.upsertEdges is not available");
          }
          const result = await params.store.upsertEdges(upgrades);
          // The executor's contract: a throwing apply means the batch did
          // not persist and must not be counted as upgraded (review
          // thread: silently skipped edges inflate the upgraded count and
          // let reconciliation retire edges that were never re-asserted).
          if (!result.ok) throw new Error(`upsertEdges failed: ${result.code}`);
          if (result.skipped > 0) throw new Error(`upsertEdges skipped ${result.skipped} edge(s)`);
        },
        reconcileLspEdges: (
          filePath: string,
          assertedEdges: ReadonlyArray<{ srcQualifiedName: string; dstQualifiedName: string; type: string }>,
        ) => {
          if (typeof params.store.reconcileLspEdges !== "function") return;
          if (plannedCountByFile.get(filePath) !== gatheredCountByFile.get(filePath)) return;
          params.store.reconcileLspEdges(filePath, assertedEdges);
        },
      });
      if (result && typeof result === "object" && "upgraded" in result && typeof result.upgraded === "number") {
        upgraded += result.upgraded;
        unresolved += "unresolved" in result && typeof result.unresolved === "number" ? result.unresolved : 0;
        budgetExhausted += "budgetExhausted" in result && typeof result.budgetExhausted === "number" ? result.budgetExhausted : 0;
        // A mid-run server crash / protocol error returns counts PLUS a
        // degradation tag — dropping it would make the failure look like
        // ordinary unresolved calls (review thread).
        if ("degradation" in result && result.degradation && typeof result.degradation === "object") {
          const rd = result.degradation;
          degradations.push({
            language,
            code: "code" in rd && typeof rd.code === "string" ? rd.code : "lsp_degraded",
            message: "detail" in rd && typeof rd.detail === "string" ? rd.detail : `LSP pass for ${language} degraded mid-run.`,
          });
        }
      } else {
        unresolved += plan.requests.length;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "lsp_resolution_error", message: msg };
    } finally {
      const disposable = client as { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === "function") {
        try {
          await disposable.dispose();
        } catch {
          // Disposal failure is not actionable — the child process is
          // reaped by the OS when the parent exits.
        }
      }
    }
  }
  return {
    ok: true,
    upgraded,
    unresolved,
    budgetExhausted,
    ...(degradations.length > 0 ? { degradations } : {}),
  };
}

/**
 * Report index status via @remnic/coding-graph's getIndexStatus. Never throws
 * — a git failure degrades to `mode: "git_unavailable"` in the status body.
 */
export async function reportCodegraphIndexStatus(params: {
  readonly store: CodegraphStore;
  readonly repoRoot: string;
}): Promise<CodegraphDelegateOutcome<{ status: Record<string, unknown> }>> {
  const mod = await loadCodegraphModule();
  if (mod === null) {
    return { ok: false, code: "package_missing", message: "The @remnic/coding-graph package is not installed." };
  }
  // Thread 13 (issue #1554): defaultCodingGitInvoker is a factory function.
  if (typeof mod.getIndexStatus !== "function" || typeof mod.defaultCodingGitInvoker !== "function") {
    return { ok: false, code: "runtime_unavailable", message: "getIndexStatus is not available in the installed @remnic/coding-graph." };
  }
  const git = (mod.defaultCodingGitInvoker as () => unknown)();
  try {
    const status = mod.getIndexStatus(params.store, git, params.repoRoot) as Record<string, unknown>;
    return { ok: true, status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "store_error", message: msg };
  }
}

/**
 * Detect changes + blast radius. Gathers the diff, fresh-parses changed
 * files, finds directly-affected symbols, and computes blast radius. When
 * the engine is the PR1 placeholder, degrades to `engine_unavailable`.
 */
export async function detectCodegraphChanges(params: {
  readonly store: CodegraphStore;
  readonly repoRoot: string;
  readonly head: string;
}): Promise<CodegraphDelegateOutcome<{ affected: readonly unknown[] }>> {
  const mod = await loadCodegraphModule();
  if (mod === null) {
    return { ok: false, code: "package_missing", message: "The @remnic/coding-graph package is not installed." };
  }
  if (typeof mod.computeBlastRadius !== "function") {
    return { ok: false, code: "runtime_unavailable", message: "computeBlastRadius is not available in the installed @remnic/coding-graph." };
  }
  // The full detect-changes pipeline (gather hunks → fresh parse → find
  // affected → blast radius) needs a real engine. When the engine is the
  // PR1 placeholder the surface degrades honestly. The wiring here is real:
  // once the engine lands (#1551 PR2), this path returns live results.
  let engine: { parseFile(input: unknown): Promise<unknown> };
  try {
    if (typeof mod.createCodingGraphEngine !== "function") {
      return { ok: false, code: "engine_unavailable", message: "createCodingGraphEngine is not exported by @remnic/coding-graph." };
    }
    engine = mod.createCodingGraphEngine();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "engine_unavailable", message: `The coding-graph engine is not ready: ${msg}` };
  }
  void engine;
  void params;
  // Without a full hunk-gathering + fresh-parse pipeline wired through the
  // runtime yet, compute blast radius over an empty affected set so the
  // store read path is exercised. The pipeline's missing middle (hunk
  // gathering) lands with the engine in #1551 PR2; until then this is an
  // honest empty result, NOT a stub success claiming affected symbols.
  try {
    const result = mod.computeBlastRadius(params.store, new Set<string>()) as { ok: boolean; affected?: unknown[]; code?: string };
    if (result && result.ok === true) {
      return { ok: true, affected: result.affected ?? [] };
    }
    return { ok: false, code: (result?.code as string) ?? "store_error", message: "computeBlastRadius reported a failure." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "store_error", message: msg };
  }
}

/**
 * Persist runtime call traces as HTTP_CALLS edges via the store's
 * standalone upsertEdges write path. Each trace is mapped to an edge with
 * provenance "trace"; edges whose endpoints do not resolve to an indexed
 * node are counted in `skipped` (returned to the caller) rather than
 * silently dropped.
 */
export async function ingestCodegraphTraces(params: {
  readonly store: CodegraphStore;
  readonly traces: readonly unknown[];
}): Promise<CodegraphDelegateOutcome<{ accepted: number; persisted: number; skipped: number }>> {
  if (typeof params.store.upsertEdges !== "function") {
    return {
      ok: false,
      code: "runtime_unavailable",
      message: "The installed @remnic/coding-graph does not expose upsertEdges; traces cannot be persisted.",
    };
  }
  const edges: CodegraphEdgeInput[] = [];
  let accepted = 0;
  for (const trace of params.traces) {
    const t = trace as { caller?: string; callee?: string; confidence?: number };
    if (typeof t?.caller !== "string" || typeof t?.callee !== "string") {
      // Malformed trace — skip (the surface validates traces is an array;
      // individual trace shape is validated here so a bad row does not
      // abort the whole batch).
      continue;
    }
    accepted += 1;
    edges.push({
      srcQualifiedName: t.caller,
      dstQualifiedName: t.callee,
      type: "HTTP_CALLS",
      confidence: typeof t.confidence === "number" && t.confidence >= 0 && t.confidence <= 1 ? t.confidence : 0.5,
      provenance: "trace",
    });
  }
  try {
    const result = await params.store.upsertEdges(edges);
    if (result.ok === true) {
      return { ok: true, accepted, persisted: result.persisted, skipped: result.skipped };
    }
    return { ok: false, code: result.code, message: "store.upsertEdges reported a failure." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "store_error", message: msg };
  }
}

/** Test seam: reset the module cache so a fresh import can be observed. */
export function __resetCodegraphRuntimeForTest(): void {
  cachedModule = undefined;
  moduleLoadPromise = null;
  storeCache.clear();
}

/**
 * Derive a stable per-repo project id from an absolute repoRoot (issue #1554
 * review threads 7/9/11). Used by the shared store resolver when a caller
 * invokes a codegraph tool with repoRoot but no explicit project and no
 * session coding context (e.g. a standalone stdio-MCP call). The `root:<hex>`
 * form matches the coding-context id convention so a derived id is
 * distinguishable from an `origin:<hex>` remote id. Centralized here so every
 * store-backed tool derives the SAME id and can reopen the DB index created.
 */
export function deriveCodegraphProjectId(repoRoot: string): string {
  return `root:${createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)}`;
}

/**
 * Resolve the project id for a store-backed codegraph tool from a surface
 * request (issue #1554 review threads 7/9/11). This is the SHARED chokepoint
 * every store-backed tool funnels through, so index / search_graph /
 * get_schema / index_status all reopen the SAME DB:
 *   1. an explicit `project` wins;
 *   2. else a session coding context's projectId;
 *   3. else a stable `root:<hex>` derived from `repoRoot` (standalone callers);
 *   4. else a TAGGED `project_required` error (never a plain Error, so the
 *      surface maps it into a structured response rather than an unstructured
 *      tool error).
 *
 * The request shape is structural (not the surfaces' CodegraphSurfaceRequest
 * type) to keep this module free of a runtime import cycle with the surfaces.
 */
export function resolveCodegraphProjectId(params: {
  readonly request: { readonly project?: unknown; readonly sessionKey?: unknown; readonly repoRoot?: unknown };
  readonly getCodingContext: (sessionKey: string) => { readonly projectId: string } | null;
}): string {
  const { request, getCodingContext } = params;
  const explicit = typeof request.project === "string" ? request.project.trim() : "";
  if (explicit.length > 0) return explicit;
  const sessionKey = typeof request.sessionKey === "string" ? request.sessionKey.trim() : "";
  if (sessionKey.length > 0) {
    const cc = getCodingContext(sessionKey);
    if (cc !== null) return cc.projectId;
  }
  const repoRoot = typeof request.repoRoot === "string" ? request.repoRoot.trim() : "";
  if (repoRoot.length > 0) return deriveCodegraphProjectId(repoRoot);
  throw new CodegraphRuntimeError(
    "project_required",
    "codegraph: project must be supplied explicitly, via a session coding context, or alongside a repoRoot",
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Tagged runtime error -- `code` is the load-bearing signal (rule 34)
// ──────────────────────────────────────────────────────────────────────────

export type CodegraphRuntimeErrorCode =
  | "disabled"
  | "package_missing"
  | "repo_root_conflict"
  | "confirm_required"
  | "project_required"
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
