/**
 * @remnic/core — per-directory abstract/overview sidecars (issue #2977).
 *
 * One derived `overview.md` per memory directory (category roots and every
 * directory beneath them, including `namespaces/<ns>/` subtrees), rendered
 * bottom-up from existing memory content:
 *
 *   - the ABSTRACT is a single line (<=256 chars) composed from child titles;
 *   - the OVERVIEW body lists one preview line per child memory and embeds
 *     each child DIRECTORY's abstract, so a parent summarizes its subtree
 *     without embedding full child overviews.
 *
 * Determinism: no LLM, no embeddings. Content is assembled with the same
 * preview machinery the OKF index files use (`normalizeProjectionPreview`).
 *
 * Invalidation: each sidecar stores a content-free fingerprint of its subtree
 * (child name|size|mtime for files, recursive fingerprints for child dirs).
 * Any add/edit/delete anywhere below a directory changes its fingerprint, so
 * `loadDirectorySidecar` can detect staleness with `readdir`+`stat` alone and
 * refresh without reading child memory files first. Eager regeneration runs
 * through {@link runDirectorySidecarMaintenance}; lazy refresh on read covers
 * direct-write paths that bypass scheduled maintenance (Gotcha #43).
 *
 * Isolation: sidecars are derived artifacts, excluded from generic recall via
 * `isGenericRecallExcludedPath` (basename match, the same tradeoff OKF makes
 * for `index.md`/`log.md`) while staying full-text searchable. Files at the
 * sidecar path WITHOUT the marker are user content: never overwritten, never
 * removed.
 *
 * Layer 2: {@link refreshDirectorySidecarsAfterWrite} refreshes only the
 * changed directory and its category ancestors. `enabled: false` is a
 * proven no-op (no reads, no writes).
 *
 * Layer 3 (this slice): {@link applyDirectorySidecarDrillDown} scores
 * fresh sidecars and attaches the winning directory's abstract to hits.
 * `enabled` stays a function argument — not a parseConfig key (`config.ts`
 * and `types.ts` are at their file-size ratchets). Retrieval never writes.
 * xray trajectory, storage write-hook, parseConfig wiring, and LLM
 * summarization remain later layers on #2977.
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { coerceBooleanLike } from "./connectors/coerce.js";
import { writeFileAtomically } from "./maintenance/atomic-file.js";
import { normalizeProjectionPreview } from "./memory-projection-format.js";
import { OKF_RESERVED_BASENAMES } from "./okf/type-mapping.js";
import { RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";

export const DIRECTORY_SIDECAR_BASENAME = "overview.md";
export const DIRECTORY_SIDECAR_MARKER = "<!-- remnic-directory-sidecar -->";
/** Prefix prepended to a hit snippet when a fresh directory abstract attaches. */
export const NEIGHBORHOOD_ABSTRACT_LABEL = "Neighborhood:";

const ABSTRACT_MAX_CHARS = 256;
const OVERVIEW_MAX_CHARS = 4000;
const DEFAULT_QUERY_LIMIT = 5;
const CATEGORY_ROOTS: ReadonlySet<string> = new Set(RECALL_FALLBACK_DIRS);

/** Config fields this slice owns. Mix into `PluginConfig` in a later layer. */
export interface DirectorySidecarSettings {
  /** Populate sidecars on memory writes. Default false. */
  directorySidecarsEnabled: boolean;
}

/** Strict off-default: only an explicit true/"true"/1 opts in. */
export function parseDirectorySidecarsEnabled(raw: unknown): boolean {
  return coerceBooleanLike(raw, "directorySidecarsEnabled") === true;
}

/** Basenames never treated as child memories (ours plus OKF's reserved ones). */
const RESERVED_CHILD_BASENAMES: Readonly<Record<string, true>> = Object.freeze({
  ...OKF_RESERVED_BASENAMES,
  [DIRECTORY_SIDECAR_BASENAME]: true,
});

export interface DirectorySidecar {
  /** Absolute directory the sidecar describes. */
  readonly dir: string;
  /** Single-line L0 abstract (<=256 chars). */
  readonly abstract: string;
  /** Abstract plus the per-child preview body (<=4000 chars). */
  readonly overview: string;
  /** Number of memory `.md` children in this directory. */
  readonly childCount: number;
  /** False when the stored fingerprint no longer matches the subtree. */
  readonly fresh: boolean;
}

export interface DirectorySidecarMatch extends DirectorySidecar {
  readonly score: number;
}

/** Minimal hit shape drill-down mutates. Extra fields pass through. */
export interface DirectorySidecarHit {
  path: string;
  snippet: string;
  score: number;
}

export interface DirectorySidecarReport {
  written: string[];
  removed: string[];
}

interface ParsedSidecar {
  abstract: string;
  overview: string;
  childCount: number;
  fingerprint: string;
}

function listEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Root check that refuses symlinks (fs-boundary rule, PRs #1938/#1999). */
function isRealDirectory(entryPath: string): boolean {
  try {
    const stats = lstatSync(entryPath);
    return !stats.isSymbolicLink() && stats.isDirectory();
  } catch {
    return false;
  }
}

function memoryChildren(dir: string): string[] {
  // Dirent.isFile() is false for symlinks, so a linked memory never enters the corpus.
  return listEntries(dir)
    .filter((entry) => entry.isFile() && !RESERVED_CHILD_BASENAMES[entry.name] && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function directoryChildren(dir: string): string[] {
  // Dirent.isDirectory() is false for symlinks (fs-boundary rule, PRs #1938/#1999).
  return listEntries(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Content-free subtree fingerprint: sha256 over sorted child descriptors.
 * Files contribute `name|size|mtimeMs`; directories contribute their own
 * recursive fingerprint, so any change below a directory invalidates every
 * ancestor. Reads no file contents.
 */
export function directoryFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const name of memoryChildren(dir)) {
    try {
      const stats = statSync(path.join(dir, name));
      hash.update(`f|${name}|${stats.size}|${Math.trunc(stats.mtimeMs)}\n`);
    } catch {
      hash.update(`f|${name}|missing\n`);
    }
  }
  for (const name of directoryChildren(dir)) {
    hash.update(`d|${name}|${directoryFingerprint(path.join(dir, name))}\n`);
  }
  return hash.digest("hex");
}

function readFileOrNull(target: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch {
    return null;
  }
}

function parseSidecar(content: string): ParsedSidecar | null {
  if (!content.startsWith(DIRECTORY_SIDECAR_MARKER)) return null;
  const fingerprint = /^fingerprint: ([0-9a-f]{64})$/m.exec(content)?.[1];
  if (!fingerprint) return null;
  const abstract = /^## Abstract\n([^\n]+)$/m.exec(content)?.[1] ?? "";
  const overviewStart = content.indexOf("## Abstract");
  const overview =
    overviewStart === -1 ? "" : content.slice(overviewStart, overviewStart + OVERVIEW_MAX_CHARS).trim();
  // The `* name — preview` child bullets are the rendered child count.
  const childCount = (content.match(/^\* .+$/gm) ?? []).length;
  return { abstract, overview, childCount, fingerprint };
}

function sidecarPath(dir: string): string {
  return path.join(dir, DIRECTORY_SIDECAR_BASENAME);
}

function renderSidecar(dir: string, fingerprint: string, childAbstracts: Map<string, string>): string | null {
  const children = memoryChildren(dir);
  const childDirs = directoryChildren(dir).filter((name) => childAbstracts.has(path.join(dir, name)));
  if (children.length === 0 && childDirs.length === 0) return null;

  const previews = children.map((name) => {
    try {
      return normalizeProjectionPreview(readFileSync(path.join(dir, name), "utf8"), 120);
    } catch {
      return "";
    }
  });
  const titles = children.map(
    (name, index) => previews[index].split(" ").slice(0, 8).join(" ") || name.replace(/\.md$/, ""),
  );
  const abstract = normalizeProjectionPreview(
    `${path.basename(dir)}/ — ${children.length} memories: ${titles.slice(0, 5).join(" · ")}`,
    ABSTRACT_MAX_CHARS,
  );

  const lines = [
    DIRECTORY_SIDECAR_MARKER,
    `fingerprint: ${fingerprint}`,
    `# ${path.basename(dir)}/ overview`,
    "",
    "## Abstract",
    abstract,
    "",
    "## Children",
  ];
  for (const [index, name] of children.entries()) {
    lines.push(`* ${name} — ${previews[index]}`);
  }
  for (const name of childDirs) {
    lines.push(`### ${name}/`);
    lines.push(childAbstracts.get(path.join(dir, name)) ?? "");
  }
  lines.push("");
  return lines.join("\n");
}

/** Scope roots whose category subtrees carry sidecars: the memory root plus every namespace root. */
function scopeRoots(memoryDir: string): string[] {
  const roots = [memoryDir];
  const namespacesRoot = path.join(memoryDir, "namespaces");
  for (const entry of listEntries(namespacesRoot)) {
    if (entry.isDirectory() && isRealDirectory(path.join(namespacesRoot, entry.name))) {
      roots.push(path.join(namespacesRoot, entry.name));
    }
  }
  return roots;
}

/**
 * Every directory that should carry a sidecar, deepest first (post-order) so
 * parents render after their children and can embed child abstracts.
 */
function collectSidecarDirs(scopeRoot: string): string[] {
  const dirs: string[] = [];
  const walk = (dir: string, isCategoryRoot: boolean): boolean => {
    let carries = memoryChildren(dir).length > 0;
    for (const name of directoryChildren(dir)) {
      carries = walk(path.join(dir, name), false) || carries;
    }
    // A directory that stopped carrying memories must still be visited so its
    // orphaned sidecar can be pruned or rewritten (cache-invalidation completeness).
    const hasSidecar = readFileOrNull(sidecarPath(dir))?.startsWith(DIRECTORY_SIDECAR_MARKER) === true;
    if (isCategoryRoot || carries || hasSidecar) dirs.push(dir);
    return carries;
  };
  for (const category of RECALL_FALLBACK_DIRS) {
    const categoryDir = path.join(scopeRoot, category);
    if (!isRealDirectory(categoryDir)) continue;
    walk(categoryDir, true);
  }
  return dirs;
}

async function syncSidecarDir(
  dir: string,
  enabled: boolean,
  childAbstracts: Map<string, string>,
  written: string[],
  removed: string[],
): Promise<void> {
  const target = sidecarPath(dir);
  const raw = readFileOrNull(target);
  const existing = raw !== null && raw.startsWith(DIRECTORY_SIDECAR_MARKER) ? raw : null;
  if (!enabled) {
    if (existing !== null) {
      unlinkSync(target);
      removed.push(target);
    }
    return;
  }
  const next = renderSidecar(dir, directoryFingerprint(dir), childAbstracts);
  if (next === null) {
    if (existing !== null) {
      unlinkSync(target);
      removed.push(target);
    }
    return;
  }
  const parsedNext = parseSidecar(next);
  if (parsedNext) childAbstracts.set(dir, parsedNext.abstract);
  if (raw === next) return;
  if (existing === null && raw !== null) return; // user-authored file: hands off
  await writeFileAtomically(target, next);
  written.push(target);
}

function childAbstractsFromDisk(dir: string): Map<string, string> {
  const abstracts = new Map<string, string>();
  for (const name of directoryChildren(dir)) {
    const childDir = path.join(dir, name);
    const parsed = parseSidecar(readFileOrNull(sidecarPath(childDir)) ?? "");
    if (parsed) abstracts.set(childDir, parsed.abstract);
  }
  return abstracts;
}

/**
 * Category-root ancestry of a changed memory path, deepest first.
 * Paths outside a recall category return `[]` so writes to `state/` or
 * `namespaces/<ns>/` itself never mint a sidecar.
 */
export function directorySidecarAncestry(memoryDir: string, changedPath: string): string[] {
  const root = path.resolve(memoryDir);
  const abs = path.isAbsolute(changedPath) ? path.resolve(changedPath) : path.resolve(root, changedPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [];
  const parts = rel.split(path.sep).filter(Boolean);
  const dirParts = isRealDirectory(abs) ? parts : parts.slice(0, -1);
  let categoryAt = -1;
  if (dirParts[0] === "namespaces" && dirParts.length >= 3 && CATEGORY_ROOTS.has(dirParts[2] ?? "")) {
    categoryAt = 2;
  } else if (CATEGORY_ROOTS.has(dirParts[0] ?? "")) {
    categoryAt = 0;
  }
  if (categoryAt === -1) return [];
  const dirs: string[] = [];
  for (let i = dirParts.length; i > categoryAt; i--) {
    dirs.push(path.join(root, ...dirParts.slice(0, i)));
  }
  return dirs;
}

/**
 * Regenerates directory sidecars incrementally. Unchanged sidecars are left
 * untouched; emptied directories lose theirs; user files at the sidecar path
 * (no marker) are never written or removed. With `enabled: false` every
 * generated sidecar is removed — the OKF index-maintenance contract.
 */
export async function runDirectorySidecarMaintenance(
  memoryDir: string,
  enabled: boolean,
): Promise<DirectorySidecarReport> {
  const written: string[] = [];
  const removed: string[] = [];
  for (const scope of scopeRoots(memoryDir)) {
    const childAbstracts = new Map<string, string>();
    for (const dir of collectSidecarDirs(scope)) {
      await syncSidecarDir(dir, enabled, childAbstracts, written, removed);
    }
  }
  return { written, removed };
}

/**
 * Incremental write-path refresh: only the changed directory and its
 * category ancestors, using the same fingerprint/render path as maintenance.
 * `enabled: false` returns immediately — no readdir, no writes.
 */
export async function refreshDirectorySidecarsAfterWrite(
  memoryDir: string,
  changedPath: string,
  enabled: boolean,
): Promise<DirectorySidecarReport> {
  if (!enabled) return { written: [], removed: [] };
  const written: string[] = [];
  const removed: string[] = [];
  for (const dir of directorySidecarAncestry(memoryDir, changedPath)) {
    await syncSidecarDir(dir, true, childAbstractsFromDisk(dir), written, removed);
  }
  return { written, removed };
}

/**
 * Read a directory's sidecar for retrieval. By default a stale sidecar is
 * refreshed in place (child directories first), which is what makes direct
 * writes that bypass maintenance still converge. With `{ refresh: false }`
 * the stored sidecar is returned as-is with `fresh: false` so callers can
 * observe staleness without writes.
 */
export async function loadDirectorySidecar(
  dir: string,
  options: { refresh?: boolean } = {},
): Promise<DirectorySidecar | null> {
  const refresh = options.refresh !== false;
  const target = sidecarPath(dir);
  const stored = readFileOrNull(target);
  const generated = stored !== null && stored.startsWith(DIRECTORY_SIDECAR_MARKER);
  const parsed = generated ? parseSidecar(stored) : null;
  const fingerprint = directoryFingerprint(dir);
  if (parsed !== null && (parsed.fingerprint === fingerprint || !refresh)) {
    return {
      dir,
      abstract: parsed.abstract,
      overview: parsed.overview,
      childCount: parsed.childCount,
      fresh: parsed.fingerprint === fingerprint,
    };
  }
  if (!refresh) return null;

  // Refresh bottom-up so this directory's body embeds current child abstracts.
  const childAbstracts = new Map<string, string>();
  for (const name of directoryChildren(dir)) {
    const child = await loadDirectorySidecar(path.join(dir, name));
    if (child) childAbstracts.set(path.join(dir, name), child.abstract);
  }
  const next = renderSidecar(dir, directoryFingerprint(dir), childAbstracts);
  if (next === null) {
    if (generated) unlinkSync(target);
    return null;
  }
  if (readFileOrNull(target) !== next) {
    if (stored !== null && !generated) {
      // User-authored file at the sidecar path: serve nothing rather than clobber it.
      return null;
    }
    await writeFileAtomically(target, next);
  }
  const refreshed = parseSidecar(next);
  return refreshed
    ? {
        dir,
        abstract: refreshed.abstract,
        overview: refreshed.overview,
        childCount: refreshed.childCount,
        fresh: true,
      }
    : null;
}

/**
 * Overview-query primitive for hierarchical retrieval (layer 1 of #2977):
 * score every sidecar's abstract (+3 per query term) and overview (+1 per
 * term) lexically, then return the most specific matches — when both a
 * directory and its descendant match, only the descendant is kept, matching
 * the drill-down semantics the full retrieval mode will build on.
 */
export async function findDirectorySidecarsForQuery(
  memoryDir: string,
  query: string,
  options: { namespace?: string; limit?: number; refresh?: boolean } = {},
): Promise<DirectorySidecarMatch[]> {
  const scope = options.namespace ? path.join(memoryDir, "namespaces", options.namespace) : memoryDir;
  if (!isRealDirectory(scope)) return [];
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2);

  const matches: DirectorySidecarMatch[] = [];
  for (const root of scopeRoots(scope)) {
    for (const dir of collectSidecarDirs(root)) {
      const sidecar = await loadDirectorySidecar(dir, { refresh: options.refresh });
      if (!sidecar) continue;
      const abstractLower = sidecar.abstract.toLowerCase();
      const overviewLower = sidecar.overview.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (abstractLower.includes(term)) score += 3;
        else if (overviewLower.includes(term)) score += 1;
      }
      if (score > 0) matches.push({ ...sidecar, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));

  const limit = options.limit ?? DEFAULT_QUERY_LIMIT;
  return matches
    .filter((candidate) => !matches.some((other) => other.dir.startsWith(`${candidate.dir}${path.sep}`)))
    .slice(0, limit);
}

function attachNeighborhoodAbstract(snippet: string, abstract: string): string {
  const line = `${NEIGHBORHOOD_ABSTRACT_LABEL} ${abstract}`;
  if (snippet === line || snippet.startsWith(`${line}\n`)) return snippet;
  return snippet.length === 0 ? line : `${line}\n${snippet}`;
}

function mostSpecificSidecarForHit(
  memoryDir: string,
  hitPath: string,
  matches: readonly DirectorySidecarMatch[],
): DirectorySidecarMatch | null {
  if (path.basename(hitPath) === DIRECTORY_SIDECAR_BASENAME) return null;
  const abs = path.isAbsolute(hitPath) ? path.resolve(hitPath) : path.resolve(memoryDir, hitPath);
  let best: DirectorySidecarMatch | null = null;
  for (const match of matches) {
    const rel = path.relative(match.dir, abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (best === null || match.dir.length > best.dir.length) best = match;
  }
  return best;
}

/**
 * Retrieval drill-down (layer 3 of #2977): score fresh directory sidecars
 * and attach the winning neighborhood abstract to hits under that directory.
 * `enabled: false` (the default) returns hits unchanged with no I/O.
 * Never writes. Does not reorder. parseConfig is not consulted.
 */
export async function applyDirectorySidecarDrillDown<T extends DirectorySidecarHit>(
  memoryDir: string,
  query: string,
  hits: readonly T[],
  options: { enabled?: boolean; namespace?: string } = {},
): Promise<T[]> {
  if (options.enabled !== true) return [...hits];
  const matches = await findDirectorySidecarsForQuery(memoryDir, query, {
    namespace: options.namespace,
    refresh: false,
  });
  const fresh = matches.filter((match) => match.fresh && match.abstract.length > 0);
  if (fresh.length === 0) return [...hits];
  return hits.map((hit) => {
    const match = mostSpecificSidecarForHit(memoryDir, hit.path, fresh);
    if (!match) return hit;
    const snippet = attachNeighborhoodAbstract(hit.snippet, match.abstract);
    return snippet === hit.snippet ? hit : { ...hit, snippet };
  });
}
