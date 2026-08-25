/**
 * Memory-store browse verbs (issue #2978) — deterministic `ls` / `tree` /
 * `find` over ONE resolved namespace's memory store, so an agent can see
 * what exists instead of guessing ids at an opaque search box.
 *
 * Scope rules (all existing contracts, no new ones):
 *   - Every call resolves through the caller's `resolveReadableNamespace`
 *     (read/write path symmetry) and ONE storage instance — browse never
 *     enumerates across namespaces.
 *   - Only the recall corpus is browsable: a path's top segment must be a
 *     `RECALL_FALLBACK_DIRS` category AND survive
 *     `isGenericRecallExcludedPath`. Derived stores (`artifacts/`,
 *     `meetings/` records, wearables day stores, `state/`, ...) are
 *     indistinguishable from missing paths — `not_found`, never listed.
 *   - Support-passport private memories are filtered exactly like
 *     `memoryBrowse` (the paginated list): their names never appear.
 *   - Output is deterministically sorted (plain code-point order, no
 *     locale) and entry-capped so a huge store cannot blow the response.
 *
 * `ponytail:` the index is rebuilt from `readAllMemories()` per call —
 * O(corpus) per browse. Fine at agent cadence; swap for a cached directory
 * index if browsing ever sits on a hot path.
 */

import { toMemoryPathRel } from "./memory-lifecycle-ledger-utils.js";
import { normalizeProjectionPreview } from "./memory-projection-format.js";
import { isGenericRecallExcludedPath } from "./orchestration/generic-recall-paths.js";
import { isSupportPassportPrivateMemory } from "./support-passport/card-projection.js";
import { RECALL_FALLBACK_DIRS } from "./utils/category-dir.js";
import type { MemoryFile } from "./types.js";

/** Browse reads touch only these storage members. */
export interface MemoryBrowseStorage {
  readonly dir: string;
  readAllMemories(): Promise<MemoryFile[]>;
}

/** Injected seams; the service supplies live wiring, tests supply doubles. */
export interface MemoryBrowseDeps {
  readonly resolveReadableNamespace: (namespace: string | undefined, principal?: string) => string;
  readonly getStorage: (namespace: string) => Promise<MemoryBrowseStorage>;
}

export type BrowseVerb = "ls" | "tree" | "find";

export interface MemoryStoreBrowseRequest {
  readonly verb: BrowseVerb;
  /** ls/tree: directory relative to the store root ("" or "/" = root). */
  readonly path?: string;
  /** tree: expansion depth, 1..MAX_TREE_DEPTH (default 1). */
  readonly depth?: number;
  /** find: glob (`*` wildcard) or substring matched against path and name. */
  readonly pattern?: string;
  readonly namespace?: string;
  readonly authenticatedPrincipal?: string;
}

export interface MemoryBrowseEntry {
  /** Store-relative path with forward slashes; dirs carry no trailing slash. */
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly name: string;
  /** Files: first content line (180-char preview). Dirs: empty. */
  readonly description: string;
  /** Dirs: recursive memory count beneath. Files: 1. */
  readonly count: number;
  /** 0-based depth relative to the browse root (tree nests; ls/find are 0). */
  readonly depth: number;
}

export type MemoryBrowseError = "invalid_path" | "not_found" | "invalid_depth" | "invalid_pattern";

export type MemoryStoreBrowseResult =
  | {
      ok: true;
      verb: BrowseVerb;
      namespace: string;
      path: string;
      total: number;
      entries: MemoryBrowseEntry[];
      truncated: boolean;
      rendered: string;
    }
  | {
      ok: false;
      verb: BrowseVerb;
      path: string;
      error: MemoryBrowseError;
      message: string;
      rendered: string;
    };

export const MAX_LS_ENTRIES = 200;
export const MAX_TREE_ENTRIES = 400;
export const MAX_TREE_DEPTH = 4;
export const MAX_FIND_ENTRIES = 200;
const MAX_PATH_CHARS = 512;
const MAX_PATTERN_CHARS = 256;

const BROWSABLE_ROOTS: Record<string, true> = Object.fromEntries(RECALL_FALLBACK_DIRS.map((dir) => [dir, true]));

/** The recall-corpus visibility rule shared by every browse code path. */
function isBrowsableMemoryPath(relPath: string): boolean {
  if (!relPath.endsWith(".md")) return false;
  const top = relPath.split("/")[0] ?? "";
  return BROWSABLE_ROOTS[top] === true && !isGenericRecallExcludedPath(relPath);
}

/**
 * Normalize a caller-supplied store path. Returns "" for the root. Throws
 * `Error` on absolute paths, `..`/`.` segments, backslashes, control
 * characters, or oversize input — never reinterpreted (pattern 39).
 */
export function sanitizeBrowsePath(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  if (trimmed.length > MAX_PATH_CHARS) throw new Error("path is too long");
  if (trimmed.includes("\\")) throw new Error("path must use '/' separators");
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "") throw new Error("path has an empty segment");
    if (segment === "." || segment === "..") throw new Error("path must not contain '.' or '..' segments");
    for (const ch of segment) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) throw new Error("path has control characters");
    }
  }
  return segments.join("/");
}

/** Escape every regex metacharacter in a glob segment. */
function segmentRegex(segment: string): RegExp {
  const source = `^${segment.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`;
  return new RegExp(source, "i");
}

/**
 * `*` glob (one segment per pattern segment, `find -name` semantics — `*`
 * never crosses `/`) or case-insensitive substring over path and name.
 */
export function browsePatternMatches(pattern: string, relPath: string): boolean {
  const segments = relPath.split("/");
  const name = segments[segments.length - 1] ?? "";
  const patternSegments = pattern.split("/");
  if (patternSegments.length === 1) {
    const single = patternSegments[0]!;
    if (single.includes("*")) return segmentRegex(single).test(name);
    const needle = single.toLowerCase();
    return relPath.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
  }
  if (patternSegments.length !== segments.length) return false;
  return patternSegments.every((segment, index) => segmentRegex(segment).test(segments[index]!));
}

interface DirNode {
  readonly subdirs: Map<string, DirNode>;
  readonly files: Map<string, MemoryFile>;
  count: number;
}

function emptyNode(): DirNode {
  return { subdirs: new Map(), files: new Map(), count: 0 };
}

/** Directory index over the browsable corpus: root "" holds category dirs. */
function buildIndex(memories: readonly MemoryFile[], dir: string): DirNode {
  const root = emptyNode();
  for (const memory of memories) {
    const rel = toMemoryPathRel(dir, memory.path);
    if (!isBrowsableMemoryPath(rel)) continue;
    const segments = rel.split("/");
    let node = root;
    node.count += 1;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = node.subdirs.get(name);
      if (child === undefined) {
        child = emptyNode();
        node.subdirs.set(name, child);
      }
      node = child;
      node.count += 1;
    }
    node.files.set(segments[segments.length - 1]!, memory);
  }
  return root;
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function dirEntries(node: DirNode, dirPath: string): MemoryBrowseEntry[] {
  const prefix = dirPath === "" ? "" : `${dirPath}/`;
  const entries: MemoryBrowseEntry[] = [];
  for (const [name, child] of node.subdirs) {
    entries.push({ path: `${prefix}${name}`, kind: "dir", name, description: "", count: child.count, depth: 0 });
  }
  for (const [name, memory] of node.files) {
    entries.push({
      path: `${prefix}${name}`,
      kind: "file",
      name,
      description: normalizeProjectionPreview(memory.content),
      count: 1,
      depth: 0,
    });
  }
  return entries.sort(byPath);
}

function renderEntries(verb: BrowseVerb, namespace: string, browsePath: string, entries: readonly MemoryBrowseEntry[]): string {
  const lines = [`${verb} ${namespace}:${browsePath === "" ? "/" : browsePath}`];
  for (const entry of entries) {
    const indent = "  ".repeat(entry.depth);
    if (entry.kind === "dir") {
      lines.push(`${indent}${entry.path}/ (${entry.count} memories)`);
    } else {
      const description = entry.description.length > 0 ? ` — ${entry.description}` : "";
      lines.push(`${indent}${entry.path}${description}`);
    }
  }
  return lines.join("\n");
}

function refusal(verb: BrowseVerb, browsePath: string, error: MemoryBrowseError, message: string): MemoryStoreBrowseResult {
  return { ok: false, verb, path: browsePath, error, message, rendered: `browse ${verb} failed: ${error} — ${message}` };
}

/** Run one browse verb. Malformed input throws `Error`; typed refusals return in-band. */
export async function runMemoryBrowse(
  deps: MemoryBrowseDeps,
  request: MemoryStoreBrowseRequest,
): Promise<MemoryStoreBrowseResult> {
  const namespace = deps.resolveReadableNamespace(request.namespace, request.authenticatedPrincipal);
  const storage = await deps.getStorage(namespace);
  const memories = (await storage.readAllMemories()).filter((memory) => !isSupportPassportPrivateMemory(memory));

  if (request.verb === "find") {
    const pattern = (request.pattern ?? "").trim();
    if (pattern.length === 0) return refusal(request.verb, "", "invalid_pattern", "pattern is required");
    if (pattern.length > MAX_PATTERN_CHARS) {
      return refusal(request.verb, "", "invalid_pattern", "pattern is too long");
    }
    const hits: MemoryBrowseEntry[] = [];
    let truncated = false;
    let total = 0;
    for (const memory of memories) {
      const rel = toMemoryPathRel(storage.dir, memory.path);
      if (!isBrowsableMemoryPath(rel)) continue;
      if (!browsePatternMatches(pattern, rel)) continue;
      total += 1;
      if (hits.length >= MAX_FIND_ENTRIES) {
        truncated = true;
        break;
      }
      hits.push({
        path: rel,
        kind: "file",
        name: rel.split("/").pop() ?? rel,
        description: normalizeProjectionPreview(memory.content),
        count: 1,
        depth: 0,
      });
    }
    hits.sort(byPath);
    return { ok: true, verb: "find", namespace, path: "", total, entries: hits, truncated, rendered: renderEntries("find", namespace, "", hits) };
  }

  let browsePath: string;
  try {
    browsePath = sanitizeBrowsePath(request.path);
  } catch (err) {
    return refusal(request.verb, request.path ?? "", "invalid_path", err instanceof Error ? err.message : String(err));
  }
  const root = buildIndex(memories, storage.dir);
  let node: DirNode | undefined = root;
  for (const segment of browsePath === "" ? [] : browsePath.split("/")) {
    node = node?.subdirs.get(segment);
    if (node === undefined) break;
  }
  // Invisible-by-design stores resolve as not_found, indistinguishable from
  // a missing path: the index only ever contains browsable corpus paths.
  if (node === undefined) {
    return refusal(request.verb, browsePath, "not_found", `no browsable store path: ${browsePath}`);
  }

  if (request.verb === "ls") {
    const all = dirEntries(node, browsePath);
    const truncated = all.length > MAX_LS_ENTRIES;
    const entries = all.slice(0, MAX_LS_ENTRIES);
    return { ok: true, verb: "ls", namespace, path: browsePath, total: all.length, entries, truncated, rendered: renderEntries("ls", namespace, browsePath, entries) };
  }

  if (request.depth !== undefined && (!Number.isInteger(request.depth) || request.depth < 1 || request.depth > MAX_TREE_DEPTH)) {
    return refusal(request.verb, browsePath, "invalid_depth", `depth must be an integer between 1 and ${MAX_TREE_DEPTH}`);
  }
  const depth = request.depth ?? 1;
  const entries: MemoryBrowseEntry[] = [];
  let truncated = false;
  const walk = (current: DirNode, currentPath: string, currentDepth: number): void => {
    for (const entry of dirEntries(current, currentPath)) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      entries.push({ ...entry, depth: currentDepth });
      if (entry.kind === "dir" && currentDepth < depth - 1) {
        walk(current.subdirs.get(entry.name)!, entry.path, currentDepth + 1);
        if (truncated) return;
      }
    }
  };
  walk(node, browsePath, 0);
  return { ok: true, verb: "tree", namespace, path: browsePath, total: entries.length, entries, truncated, rendered: renderEntries("tree", namespace, browsePath, entries) };
}
