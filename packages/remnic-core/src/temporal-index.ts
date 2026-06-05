/**
 * Temporal and Tag Indexes (v8.1 — SwiftMem-inspired)
 *
 * Maintains two fast on-disk lookup structures in `state/`:
 *   index_time.json — maps YYYY-MM-DD date buckets to memory file paths
 *   index_tags.json — maps tag strings to memory file paths
 *
 * Used as an optional prefilter in the retrieval pipeline:
 * given a time range or a set of tags, narrow the candidate set
 * before the QMD hybrid search so we can pass a smaller pool to scoring.
 *
 * Design constraints:
 * - Must be fail-open (any error returns empty / unfiltered)
 * - Reads/writes are batched per extraction run
 * - Both indexes are plain JSON; no external dependencies
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface TemporalIndex {
  /** version bumped when schema changes */
  version: number;
  /** Last full rebuild timestamp (ISO string) */
  lastRebuildAt?: string;
  /** Map from YYYY-MM-DD → array of memory paths */
  dates: Record<string, string[]>;
}

export interface TagIndex {
  version: number;
  lastRebuildAt?: string;
  /** Map from canonical tag string → node metadata */
  tags: Record<string, TagNode | string[]>;
  /** Map from alias string → canonical tags */
  aliases?: Record<string, string[]>;
}

export interface TagNode {
  paths: string[];
  aliases?: string[];
  parents?: string[];
}

const INDEX_VERSION = 1;
const TEMPORAL_INDEX_FILE = "index_time.json";
const TAG_INDEX_FILE = "index_tags.json";
const TAG_INDEX_VERSION = 2;
const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_POLL_MS = 10;
const INDEX_PROCESS_START_TOLERANCE_MS = 2_000;
const INDEX_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const INDEX_PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

interface IndexLockOwner {
  pid: number;
  createdAt?: string;
  processStartedAtMs?: number;
}

type IndexLockCleanupResult = "removed" | "wait" | "blocked";

function stateDir(memoryDir: string): string {
  return path.join(memoryDir, "state");
}

function temporalIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TEMPORAL_INDEX_FILE);
}

function tagIndexPath(memoryDir: string): string {
  return path.join(stateDir(memoryDir), TAG_INDEX_FILE);
}

function ensureStateDir(memoryDir: string): void {
  const dir = stateDir(memoryDir);
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath: string, data: unknown): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Fail silently — indexes are advisory only
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(INDEX_LOCK_SLEEP, 0, 0, ms);
}

function uniqueTempPath(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const nonce = crypto.randomBytes(6).toString("hex");
  return path.join(dir, `.${base}.${process.pid}.${Date.now()}.${nonce}.tmp`);
}

function lockOwnerPath(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function writeIndexLockOwner(lockDir: string): void {
  try {
    fs.writeFileSync(
      lockOwnerPath(lockDir),
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        processStartedAtMs: INDEX_PROCESS_STARTED_AT_MS,
      }),
      {
        encoding: "utf8",
        flag: "wx",
      }
    );
  } catch {
    // Fail silently — the directory lock is still the serialization primitive.
  }
}

function readIndexLockOwner(lockDir: string): IndexLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockOwnerPath(lockDir), "utf8")) as { pid?: unknown };
    if (!(typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0)) return null;
    const owner: IndexLockOwner = { pid: parsed.pid };
    if (
      "createdAt" in parsed &&
      typeof (parsed as { createdAt?: unknown }).createdAt === "string" &&
      (parsed as { createdAt: string }).createdAt.length > 0
    ) {
      owner.createdAt = (parsed as { createdAt: string }).createdAt;
    }
    const processStartedAtMs = (parsed as { processStartedAtMs?: unknown }).processStartedAtMs;
    if (typeof processStartedAtMs === "number" && Number.isFinite(processStartedAtMs) && processStartedAtMs > 0) {
      owner.processStartedAtMs = processStartedAtMs;
    }
    return owner;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

function readProcessStartedAtMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    if (!output) return null;
    const startedAtMs = Date.parse(output);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

function lockOwnerIsRunning(owner: IndexLockOwner): boolean {
  if (!processIsAlive(owner.pid)) return false;
  if (owner.processStartedAtMs === undefined) return true;
  const runningStartedAtMs = readProcessStartedAtMs(owner.pid);
  if (runningStartedAtMs === null) return true;
  return runningStartedAtMs <= owner.processStartedAtMs + INDEX_PROCESS_START_TOLERANCE_MS;
}

function lockIsFresh(lockInfo: fs.Stats, owner: IndexLockOwner | null): boolean {
  const ownerCreatedAtMs =
    typeof owner?.createdAt === "string" && owner.createdAt.length > 0 ? Date.parse(owner.createdAt) : Number.NaN;
  const referenceMs = Number.isFinite(ownerCreatedAtMs) ? ownerCreatedAtMs : lockInfo.mtimeMs;
  return Date.now() - referenceMs < INDEX_LOCK_STALE_MS;
}

function removeAbandonedIndexLock(lockDir: string): IndexLockCleanupResult {
  try {
    const info = fs.lstatSync(lockDir);
    if (info.isSymbolicLink()) return "blocked";
    if (!info.isDirectory()) {
      fs.rmSync(lockDir, { force: true });
      return "removed";
    }
    const owner = readIndexLockOwner(lockDir);
    if (owner !== null) {
      if (lockOwnerIsRunning(owner)) return "wait";
    }
    if (owner === null && lockIsFresh(info, null)) return "wait";
    fs.rmSync(lockDir, { recursive: true, force: true });
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "removed";
    // Fail silently — indexes are advisory only
    return "blocked";
  }
}

function withIndexFileLock(filePath: string, update: () => void): void {
  const lockDir = `${filePath}.lock.d`;
  let acquired = false;

  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      writeIndexLockOwner(lockDir);
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(lockDir), { recursive: true });
        } catch {
          return;
        }
        sleepSync(INDEX_LOCK_POLL_MS);
        continue;
      }
      if (code !== "EEXIST") return;
      const cleanupResult = removeAbandonedIndexLock(lockDir);
      if (cleanupResult === "blocked") return;
      sleepSync(INDEX_LOCK_POLL_MS);
    }
  }

  try {
    update();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Fail silently — indexes are advisory only
    }
  }
}

/**
 * Atomic write: write to a unique `.tmp` sibling then rename so readers never
 * observe a partially-written file.
 */
function writeJsonAtomic(filePath: string, data: unknown): void {
  const payload = JSON.stringify(data, null, 2);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = uniqueTempPath(filePath);
    try {
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, filePath);
      return;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Fail silently — indexes are advisory only
      }
      sleepSync(INDEX_LOCK_POLL_MS);
    }
  }
}

function updateTemporalIndex(memoryDir: string, update: (index: TemporalIndex) => void): void {
  const indexPath = temporalIndexPath(memoryDir);
  withIndexFileLock(indexPath, () => {
    const index = readJsonSafe<TemporalIndex>(indexPath, { version: INDEX_VERSION, dates: {} });
    update(index);
    writeJsonAtomic(indexPath, index);
  });
}

function updateTagIndex(memoryDir: string, update: (index: TagIndex) => void): void {
  const indexPath = tagIndexPath(memoryDir);
  withIndexFileLock(indexPath, () => {
    const index = normalizeTagIndex(
      readJsonSafe<TagIndex>(indexPath, { version: TAG_INDEX_VERSION, tags: {}, aliases: {} })
    );
    update(index);
    writeJsonAtomic(indexPath, index);
  });
}

function isoDateFromTimestamp(isoString: string): string {
  if (typeof isoString !== "string" || isoString.length < 10) {
    // Malformed frontmatter — fall back to today so the memory is still indexed.
    // Log a warning to surface data-quality issues without aborting the write.
    console.warn(`[engram] temporal-index: malformed timestamp "${isoString}", falling back to today`);
    return new Date().toISOString().slice(0, 10);
  }
  return isoString.slice(0, 10); // YYYY-MM-DD
}

function addPathToSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) {
    record[key] = [];
  }
  if (!record[key].includes(p)) {
    record[key].push(p);
  }
}

function removePathFromSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) return;
  record[key] = record[key].filter((x) => x !== p);
  if (record[key].length === 0) {
    delete record[key];
  }
}

function removePathFromAllSets(record: Record<string, string[]>, p: string): void {
  for (const key of Object.keys(record)) {
    removePathFromSet(record, key, p);
  }
}

function normalizeTagSegment(segment: string): string {
  return segment
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeCanonicalTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/\s*[>:|.]+\s*/g, "/")
    .replace(/\s*\/\s*/g, "/")
    .split("/")
    .map(normalizeTagSegment)
    .filter(Boolean)
    .join("/");
}

function normalizeAliasKey(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[\/_.:-]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeAlias(alias: string): string | null {
  if (!alias.endsWith("s") || alias.length <= 3) return null;
  return alias.slice(0, -1);
}

function deriveParentTags(canonical: string): string[] {
  const parts = canonical.split("/").filter(Boolean);
  const parents: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    parents.push(parts.slice(0, i).join("/"));
  }
  return parents;
}

function deriveTagAliases(rawTag: string, canonical: string): string[] {
  const aliases = new Set<string>();
  const canonicalAlias = normalizeAliasKey(canonical);
  const rawAlias = normalizeAliasKey(rawTag);
  const leaf = canonical.split("/").at(-1) ?? canonical;
  const leafAlias = normalizeAliasKey(leaf);

  for (const candidate of [canonicalAlias, rawAlias, leafAlias]) {
    if (!candidate) continue;
    aliases.add(candidate);
    const singular = singularizeAlias(candidate);
    if (singular) aliases.add(singular);
  }

  return Array.from(aliases);
}

function normalizeTagIndex(raw: TagIndex | null | undefined): TagIndex {
  const normalized: TagIndex = {
    version: TAG_INDEX_VERSION,
    tags: {},
    aliases: {},
  };

  if (!raw || typeof raw !== "object") {
    return normalized;
  }

  const sourceTags = raw.tags ?? {};
  for (const [rawCanonical, nodeOrPaths] of Object.entries(sourceTags)) {
    const canonical = normalizeCanonicalTag(rawCanonical);
    if (!canonical) continue;
    const node: TagNode = Array.isArray(nodeOrPaths)
      ? { paths: [...new Set(nodeOrPaths)] }
      : {
          paths: Array.isArray(nodeOrPaths?.paths) ? [...new Set(nodeOrPaths.paths)] : [],
          aliases: Array.isArray(nodeOrPaths?.aliases) ? [...new Set(nodeOrPaths.aliases)] : [],
          parents: Array.isArray(nodeOrPaths?.parents) ? [...new Set(nodeOrPaths.parents)] : [],
        };
    const existingNode = normalized.tags[canonical];
    if (existingNode && !Array.isArray(existingNode)) {
      existingNode.paths = [...new Set([...existingNode.paths, ...node.paths])];
      existingNode.aliases = [...new Set([...(existingNode.aliases ?? []), ...(node.aliases ?? [])])];
      existingNode.parents = [...new Set([...(existingNode.parents ?? []), ...(node.parents ?? [])])];
    } else if (Array.isArray(existingNode)) {
      normalized.tags[canonical] = {
        paths: [...new Set([...existingNode, ...node.paths])],
        aliases: [...new Set(node.aliases ?? [])],
        parents: [...new Set(node.parents ?? deriveParentTags(canonical))],
      };
    } else {
      normalized.tags[canonical] = node;
    }
    for (const alias of deriveTagAliases(canonical, canonical)) {
      const list = normalized.aliases![alias] ?? [];
      if (!list.includes(canonical)) list.push(canonical);
      normalized.aliases![alias] = list;
    }
    for (const alias of node.aliases ?? []) {
      const aliasKey = normalizeAliasKey(alias);
      if (!aliasKey) continue;
      const list = normalized.aliases![aliasKey] ?? [];
      if (!list.includes(canonical)) list.push(canonical);
      normalized.aliases![aliasKey] = list;
    }
    const mergedNode = normalized.tags[canonical];
    if (mergedNode && !Array.isArray(mergedNode)) {
      mergedNode.parents = [...new Set(mergedNode.parents ?? deriveParentTags(canonical))];
    }
  }

  for (const [alias, canonicals] of Object.entries(raw.aliases ?? {})) {
    const aliasKey = normalizeAliasKey(alias);
    if (!aliasKey) continue;
    const list = normalized.aliases![aliasKey] ?? [];
    for (const canonical of canonicals ?? []) {
      const normalizedCanonical = normalizeCanonicalTag(canonical);
      if (normalizedCanonical && !list.includes(normalizedCanonical)) {
        list.push(normalizedCanonical);
      }
    }
    normalized.aliases![aliasKey] = list;
  }

  return normalized;
}

function ensureTagNode(index: TagIndex, canonical: string): TagNode {
  const existing = index.tags[canonical];
  if (existing && !Array.isArray(existing)) {
    return existing;
  }
  const created: TagNode = {
    paths: Array.isArray(existing) ? [...new Set(existing)] : [],
    aliases: [],
    parents: deriveParentTags(canonical),
  };
  index.tags[canonical] = created;
  return created;
}

function addTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
  const canonical = normalizeCanonicalTag(rawTag);
  if (!canonical) return;
  const node = ensureTagNode(index, canonical);
  if (!node.paths.includes(memoryPath)) {
    node.paths.push(memoryPath);
  }

  for (const alias of deriveTagAliases(rawTag, canonical)) {
    const aliasKey = normalizeAliasKey(alias);
    if (!aliasKey) continue;
    if (!node.aliases?.includes(aliasKey)) {
      node.aliases = [...new Set([...(node.aliases ?? []), aliasKey])];
    }
    const list = index.aliases?.[aliasKey] ?? [];
    if (!list.includes(canonical)) {
      index.aliases![aliasKey] = [...list, canonical];
    }
  }
}

function removeTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
  const canonical = normalizeCanonicalTag(rawTag);
  if (!canonical) return;
  const node = index.tags[canonical];
  if (!node || Array.isArray(node)) return;
  node.paths = node.paths.filter((value) => value !== memoryPath);
  if (node.paths.length === 0) {
    delete index.tags[canonical];
    pruneTagAliases(index);
  }
}

function removePathFromAllTagEntries(index: TagIndex, memoryPath: string): void {
  for (const [canonical, nodeOrPaths] of Object.entries(index.tags)) {
    if (Array.isArray(nodeOrPaths)) {
      const paths = nodeOrPaths.filter((value) => value !== memoryPath);
      if (paths.length === 0) {
        delete index.tags[canonical];
      } else {
        index.tags[canonical] = paths;
      }
      continue;
    }

    nodeOrPaths.paths = nodeOrPaths.paths.filter((value) => value !== memoryPath);
    if (nodeOrPaths.paths.length === 0) {
      delete index.tags[canonical];
    }
  }
  pruneTagAliases(index);
}

function pruneTagAliases(index: TagIndex): void {
  if (!index.aliases) return;
  for (const [alias, canonicals] of Object.entries(index.aliases)) {
    const filtered = [...new Set(canonicals.map(normalizeCanonicalTag))].filter(
      (canonical) => canonical.length > 0 && index.tags[canonical] !== undefined
    );
    if (filtered.length === 0) {
      delete index.aliases[alias];
    } else {
      index.aliases[alias] = filtered;
    }
  }
}

function expandCanonicalTags(index: TagIndex, rawTags: string[]): string[] {
  const canonicals = new Set<string>();
  for (const rawTag of rawTags) {
    const canonical = normalizeCanonicalTag(rawTag);
    if (canonical && index.tags[canonical]) {
      canonicals.add(canonical);
    }
    const aliasKey = normalizeAliasKey(rawTag);
    for (const resolved of index.aliases?.[aliasKey] ?? []) {
      canonicals.add(resolved);
    }
  }

  const expanded = new Set<string>();
  for (const canonical of canonicals) {
    expanded.add(canonical);
    const node = index.tags[canonical];
    if (node && !Array.isArray(node)) {
      for (const parent of node.parents ?? []) {
        expanded.add(parent);
      }
    }
  }
  return Array.from(expanded);
}

function aliasPhrase(alias: string): string {
  return alias.replace(/\//g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function promptContainsAlias(prompt: string, alias: string): boolean {
  const phrase = aliasPhrase(alias);
  if (!phrase) return false;
  const normalizedPrompt = ` ${normalizeAliasKey(prompt)} `;
  return normalizedPrompt.includes(` ${phrase} `);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Add (or update) a memory file in both indexes.
 *
 * @param memoryDir Root memory directory
 * @param memoryPath Absolute path to the memory file
 * @param createdAt ISO timestamp of the memory's creation date
 * @param tags Array of tag strings from the memory's frontmatter
 */
export function indexMemory(memoryDir: string, memoryPath: string, createdAt: string, tags: string[]): void {
  try {
    ensureStateDir(memoryDir);

    const dateKey = isoDateFromTimestamp(createdAt);
    updateTemporalIndex(memoryDir, (index) => {
      removePathFromAllSets(index.dates, memoryPath);
      addPathToSet(index.dates, dateKey, memoryPath);
    });

    updateTagIndex(memoryDir, (index) => {
      removePathFromAllTagEntries(index, memoryPath);
      for (const tag of tags) {
        if (tag && typeof tag === "string") {
          addTagGraphEntry(index, tag, memoryPath);
        }
      }
    });
  } catch {
    // Fail silently
  }
}

/**
 * Remove a memory file from both indexes (called on deletion/archival).
 */
export function deindexMemory(memoryDir: string, memoryPath: string, createdAt: string, tags: string[]): void {
  try {
    ensureStateDir(memoryDir);

    const dateKey = isoDateFromTimestamp(createdAt);
    updateTemporalIndex(memoryDir, (index) => {
      removePathFromSet(index.dates, dateKey, memoryPath);
    });

    updateTagIndex(memoryDir, (index) => {
      for (const tag of tags) {
        if (tag && typeof tag === "string") {
          removeTagGraphEntry(index, tag, memoryPath);
        }
      }
    });
  } catch {
    // Fail silently
  }
}

/**
 * Reset both index files to empty state.
 * Called before a full-corpus rebuild so stale paths in any surviving index
 * file do not persist after the rebuild completes.
 */
export function clearIndexes(memoryDir: string): void {
  try {
    ensureStateDir(memoryDir);
    updateTemporalIndex(memoryDir, (index) => {
      index.version = INDEX_VERSION;
      index.lastRebuildAt = undefined;
      index.dates = {};
    });
    updateTagIndex(memoryDir, (index) => {
      index.version = TAG_INDEX_VERSION;
      index.lastRebuildAt = undefined;
      index.tags = {};
      index.aliases = {};
    });
  } catch {
    // Fail silently — indexes are advisory only
  }
}

/**
 * Returns true when both index files exist on disk.
 * Used to detect first-time enablement so callers can trigger a full rebuild.
 */
export function indexesExist(memoryDir: string): boolean {
  try {
    return fs.existsSync(temporalIndexPath(memoryDir)) && fs.existsSync(tagIndexPath(memoryDir));
  } catch {
    return false;
  }
}

/**
 * Batch-add multiple memories to both indexes in a single read-modify-write cycle.
 * More efficient than calling indexMemory() per file when adding many at once.
 */
export function indexMemoriesBatch(
  memoryDir: string,
  entries: Array<{ path: string; createdAt: string; tags: string[] }>
): void {
  if (entries.length === 0) return;
  try {
    ensureStateDir(memoryDir);

    updateTemporalIndex(memoryDir, (index) => {
      for (const entry of entries) {
        const dateKey = isoDateFromTimestamp(entry.createdAt);
        removePathFromAllSets(index.dates, entry.path);
        addPathToSet(index.dates, dateKey, entry.path);
      }
    });

    updateTagIndex(memoryDir, (index) => {
      for (const entry of entries) {
        removePathFromAllTagEntries(index, entry.path);
        for (const tag of entry.tags) {
          if (tag && typeof tag === "string") {
            addTagGraphEntry(index, tag, entry.path);
          }
        }
      }
    });
  } catch {
    // Fail silently
  }
}

/**
 * Return the set of memory paths whose index date falls in [fromDate, toDate).
 *
 * Boundary semantics (exclusive upper bound):
 * - `fromDate` is INCLUSIVE — entries on this date ARE returned.
 * - `toDate`   is EXCLUSIVE — entries on this date are NOT returned.
 *   Pass `recencyWindowBoundsFromPrompt(query).toDate` to get the correct
 *   exclusive boundary; do NOT add +1 day yourself.
 * - Default `toDate` = tomorrow, so omitting it includes all of today.
 *
 * @param memoryDir - root memory directory (contains state/index_time.json)
 * @param fromDate  - inclusive start date, YYYY-MM-DD
 * @param toDate    - exclusive end date, YYYY-MM-DD (default: tomorrow)
 * @returns Set of matching file paths, or null if the index is unavailable.
 */
export async function queryByDateRangeAsync(
  memoryDir: string,
  fromDate: string,
  toDate?: string
): Promise<Set<string> | null> {
  try {
    const tPath = temporalIndexPath(memoryDir);
    let raw: string;
    try {
      raw = await fs.promises.readFile(tPath, "utf8");
    } catch {
      return null; // File missing or unreadable
    }
    let tIndex: TemporalIndex;
    try {
      tIndex = JSON.parse(raw) as TemporalIndex;
    } catch {
      tIndex = { version: INDEX_VERSION, dates: {} };
    }
    // toDate is exclusive (first day NOT included). Default: tomorrow so "all of today" is included.
    const end = toDate ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    const results = new Set<string>();
    for (const [date, paths] of Object.entries(tIndex.dates)) {
      if (date >= fromDate && date < end) {
        for (const p of paths) {
          results.add(p);
        }
      }
    }
    return results;
  } catch {
    return null;
  }
}

/**
 * Async version of queryByTags — uses non-blocking fs.promises.readFile
 * to avoid blocking the Node.js event loop.
 */
export async function queryByTagsAsync(memoryDir: string, tags: string[]): Promise<Set<string> | null> {
  if (tags.length === 0) return null;
  try {
    const gPath = tagIndexPath(memoryDir);
    let raw: string;
    try {
      raw = await fs.promises.readFile(gPath, "utf8");
    } catch {
      return null; // File missing or unreadable
    }
    let gIndex: TagIndex;
    try {
      gIndex = normalizeTagIndex(JSON.parse(raw) as TagIndex);
    } catch {
      return null;
    }

    return queryByTagsFromIndex(gIndex, tags);
  } catch {
    return null;
  }
}

function queryByTagsFromIndex(index: TagIndex, tags: string[]): Set<string> {
  const expandedTags = expandCanonicalTags(index, tags);
  const results = new Set<string>();
  for (const canonical of expandedTags) {
    const nodeOrPaths = index.tags[canonical];
    const paths = Array.isArray(nodeOrPaths) ? nodeOrPaths : (nodeOrPaths?.paths ?? []);
    for (const pathValue of paths) {
      results.add(pathValue);
    }
  }
  return results;
}

/**
 * Extract tags from a prompt for tag-based prefiltering.
 * Looks for hashtag-style tokens (#foo).
 * Returns lowercase, deduplicated list.
 */
export function extractTagsFromPrompt(prompt: string): string[] {
  const found = new Set<string>();

  // Match #tag style tokens
  const hashMatches = prompt.matchAll(/#([a-zA-Z][\w-]{1,30})/g);
  for (const m of hashMatches) {
    const canonical = normalizeCanonicalTag(m[1]);
    if (canonical) found.add(canonical);
  }

  return Array.from(found);
}

export async function resolvePromptTagPrefilterAsync(
  memoryDir: string,
  prompt: string
): Promise<{
  matchedTags: string[];
  expandedTags: string[];
  paths: Set<string> | null;
}> {
  const explicitTags = extractTagsFromPrompt(prompt);
  try {
    const raw = await fs.promises.readFile(tagIndexPath(memoryDir), "utf8");
    const tagIndex = normalizeTagIndex(JSON.parse(raw) as TagIndex);
    const matched = new Set<string>(explicitTags);

    for (const canonical of Object.keys(tagIndex.tags)) {
      if (promptContainsAlias(prompt, canonical)) {
        matched.add(canonical);
      }
    }
    for (const [alias, canonicals] of Object.entries(tagIndex.aliases ?? {})) {
      if (!promptContainsAlias(prompt, alias)) continue;
      for (const canonical of canonicals) {
        matched.add(canonical);
      }
    }
    if (matched.size === 0) {
      return {
        matchedTags: [],
        expandedTags: [],
        paths: null,
      };
    }

    const expandedTags = expandCanonicalTags(tagIndex, Array.from(matched));
    const paths = queryByTagsFromIndex(tagIndex, expandedTags);
    return {
      matchedTags: Array.from(matched),
      expandedTags,
      paths,
    };
  } catch {
    return { matchedTags: explicitTags, expandedTags: explicitTags, paths: null };
  }
}

/**
 * Detect if a prompt is time-sensitive (mentions specific time references).
 * Used to decide whether to activate the temporal prefilter.
 */
export function isTemporalQuery(prompt: string): boolean {
  return /\b(today|yesterday|this week|last week|this month|last month|recent(?:ly)?|lately|just now|earlier today|this morning|last night|last year|this year|\d+ days? ago|\d+ hours? ago|\d+ weeks? ago|\d+ months? ago|(?:in |on |during |since |before |after )?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{1,4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:spring|summer|fall|autumn|winter)\s+\d{4}|on the \d{1,2}(?:st|nd|rd|th)?|last (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(
    prompt
  );
}

/**
 * Compute a "from date" string (YYYY-MM-DD) for a recency-based temporal query.
 * For "recent" / "lately" returns 7 days ago; for today/yesterday the obvious window.
 */
export function recencyWindowFromPrompt(prompt: string, nowMs: number = Date.now()): string {
  const p = prompt.toLowerCase();
  const now = new Date(nowMs);
  let daysBack = 7; // default

  if (/\btoday\b/.test(p) || /\bthis morning\b/.test(p) || /\bjust now\b/.test(p) || /\bearlier today\b/.test(p)) {
    daysBack = 0; // fromDate = today → window [today, today]
  } else if (/\byesterday\b/.test(p) || /\blast night\b/.test(p)) {
    daysBack = 1; // fromDate = yesterday → window [yesterday, today]
  } else if (/\bthis week\b/.test(p)) {
    daysBack = 7;
  } else if (/\blast week\b/.test(p)) {
    daysBack = 14;
  } else if (/\bthis month\b/.test(p)) {
    daysBack = 31;
  } else if (/\blast month\b/.test(p)) {
    daysBack = 62;
  } else if (/\bthis year\b/.test(p)) {
    // From Jan 1 of current year
    const jan1 = new Date(now.getFullYear(), 0, 1);
    return jan1.toISOString().slice(0, 10);
  } else if (/\blast year\b/.test(p)) {
    const jan1LastYear = new Date(now.getFullYear() - 1, 0, 1);
    return jan1LastYear.toISOString().slice(0, 10);
  } else {
    // Try specific month references: "in March", "during January", "since February"
    const monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const monthMatch = p.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/
    );
    if (monthMatch) {
      const monthIdx = monthNames.indexOf(monthMatch[1]);
      const year = monthMatch[2] ? Number.parseInt(monthMatch[2], 10) : now.getFullYear();
      // "before <month>" means everything prior to that month: use 2-year lookback
      // as fromDate so the window isn't unbounded. toDate is set to the month start
      // in recencyWindowBoundsFromPrompt.
      // IMPORTANT: when an explicit year is given, anchor the lookback to the named
      // month start (not to today). "before January 2024" should produce
      // fromDate ≈ 2022-01 — not today-730 days, which could land after 2024-01 and
      // invert the window for any explicitly past month within the 730-day horizon.
      if (/\bbefore\b/.test(p)) {
        if (monthMatch[2]) {
          // Explicit year: anchor fromDate 730 days before the named month start.
          const monthStart = new Date(year, monthIdx, 1);
          return new Date(monthStart.getTime() - 730 * 86_400_000).toISOString().slice(0, 10);
        }
        daysBack = 730;
      } else {
        const monthStart = new Date(year, monthIdx, 1);
        return monthStart.toISOString().slice(0, 10);
      }
    }

    // Try "N weeks ago"
    const weekMatch = p.match(/(\d{1,5})\s*weeks?\s*ago/);
    if (weekMatch) {
      daysBack = Math.min(365, Number.parseInt(weekMatch[1], 10) * 7);
    } else {
      // Try "N months ago"
      const monthsAgoMatch = p.match(/(\d{1,5})\s*months?\s*ago/);
      if (monthsAgoMatch) {
        daysBack = Math.min(730, Number.parseInt(monthsAgoMatch[1], 10) * 31);
      } else {
        const numMatch = p.match(/(\d{1,5})\s*days?\s*ago/);
        if (numMatch) {
          daysBack = Math.min(365, Number.parseInt(numMatch[1], 10)); // no off-by-one: "3 days ago" → 3
        } else {
          const hrMatch = p.match(/(\d{1,5})\s*hours?\s*ago/);
          if (hrMatch) {
            // Convert hours to days (ceiling); at least 1 day window
            daysBack = Math.max(1, Math.ceil(Number.parseInt(hrMatch[1], 10) / 24));
          }
        }
      }
    }

    // Try explicit date patterns: YYYY-MM-DD or MM/DD/YYYY
    const isoMatch = p.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    }
    const usMatch = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (usMatch) {
      const year = usMatch[3].length === 2 ? 2000 + Number.parseInt(usMatch[3], 10) : Number.parseInt(usMatch[3], 10);
      return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
    }

    // Try "last Monday/Tuesday/etc"
    const dayOfWeekMatch = p.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (dayOfWeekMatch) {
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
      const targetDay = dayNames.indexOf(dayOfWeekMatch[1]);
      const currentDay = now.getDay();
      daysBack = (currentDay - targetDay + 7) % 7 || 7; // at least 7 days back
    }
  }

  const from = new Date(nowMs - daysBack * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

/**
 * Returns both the start and end of the temporal window implied by the prompt.
 *
 * `fromDate` is computed by delegating to `recencyWindowFromPrompt`, so the two
 * functions cannot diverge on the lower bound.  `toDate` is computed independently
 * here using the same pattern-priority ordering, because the upper-bound arithmetic
 * differs (exclusive end vs. inclusive start) and would not be expressible as a
 * simple wrapper.
 *
 * Known divergence to be aware of: for "N hours ago", `recencyWindowFromPrompt`
 * uses `Math.max(1, Math.ceil(hours/24))` days back, so `fromDate` = yesterday for
 * sub-24h values.  `toDate` here is always `tomorrow` when no explicit date is
 * specified (see the `toDaysBack === 0` branch), giving a 2-day window.  This is
 * intentional — the window must cover both yesterday and today for recent hour-level
 * queries.  Any fix to the hours formula in `recencyWindowFromPrompt` must be
 * manually reflected here.
 *
 * - `fromDate`: first day of the implied window (same as `recencyWindowFromPrompt`)
 * - `toDate`: first day NOT in the window (exclusive upper bound), so callers
 *   should filter with `date >= fromDate && date < toDate`.
 */
export function recencyWindowBoundsFromPrompt(
  prompt: string,
  nowMs: number = Date.now()
): { fromDate: string; toDate: string } {
  const fromDate = recencyWindowFromPrompt(prompt, nowMs);
  const p = prompt.toLowerCase();
  const now = new Date(nowMs);
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(nowMs + 86_400_000).toISOString().slice(0, 10);

  let toDate: string;

  if (/\btoday\b|\bthis morning\b|\bjust now\b|\bearlier today\b/.test(p)) {
    toDate = tomorrow; // exclusive: include all of today
  } else if (/\byesterday\b|\blast night\b/.test(p)) {
    toDate = today; // exclusive: include all of yesterday, stop before today
  } else if (/\bthis week\b|\bthis month\b|\bthis year\b/.test(p)) {
    toDate = tomorrow; // exclusive: include all of today
  } else if (/\blast week\b/.test(p)) {
    toDate = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 10); // already exclusive
  } else if (/\blast month\b/.test(p)) {
    toDate = new Date(nowMs - 31 * 86_400_000).toISOString().slice(0, 10); // approximately exclusive
  } else if (/\blast year\b/.test(p)) {
    toDate = `${now.getFullYear()}-01-01`; // exclusive: stop at Jan 1 of current year
  } else {
    // Mirror the structure of recencyWindowFromPrompt's else branch:
    // month name → early set (highest priority), then ago patterns set a
    // working offset, then ISO/US/weekday patterns run AFTER ago patterns
    // and can override them — matching the priority ordering in recencyWindowFromPrompt.

    const monthNames = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const monthMatch = p.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/
    );
    if (monthMatch) {
      // "since <month>" / "after <month>" — open-ended: everything from that month to now.
      // "before <month>" — closed upper bound: everything before that month starts.
      // Plain "<month>" — just that calendar month.
      const monthIdx = monthNames.indexOf(monthMatch[1]);
      const year = monthMatch[2] ? Number.parseInt(monthMatch[2], 10) : now.getFullYear();
      const isSinceOrAfter = /\b(since|after)\b/.test(p);
      const isBefore = /\bbefore\b/.test(p);
      if (isSinceOrAfter) {
        toDate = tomorrow;
      } else if (isBefore) {
        // "before <month>" means everything prior to that month.
        // toDate = first day of that month (exclusive upper bound).
        toDate = new Date(year, monthIdx, 1).toISOString().slice(0, 10);
      } else {
        // Closed window: first day of the NEXT month is the exclusive upper bound.
        toDate = new Date(year, monthIdx + 1, 1).toISOString().slice(0, 10);
      }
    } else {
      // Ago patterns set a working offset (recent edge of the N-ago window).
      // Same nesting order as recencyWindowFromPrompt.
      // Sentinel -1 means "no ago pattern matched" → toDate falls back to tomorrow.
      let toDaysBack = -1;
      const weekMatch = p.match(/(\d{1,5})\s*weeks?\s*ago/);
      if (weekMatch) {
        toDaysBack = Math.max(0, Math.min(52, Number.parseInt(weekMatch[1], 10)) - 1) * 7;
      } else {
        const monthsAgoMatch = p.match(/(\d{1,5})\s*months?\s*ago/);
        if (monthsAgoMatch) {
          toDaysBack = Math.max(0, Math.min(24, Number.parseInt(monthsAgoMatch[1], 10)) - 1) * 31;
        } else {
          const numMatch = p.match(/(\d{1,5})\s*days?\s*ago/);
          if (numMatch) {
            // (N-1) mirrors the weeks/months ago formula: "3 days ago" → window [today-3, today-2]
            // N=1 → toDaysBack=0 → toDate=today (exclusive) → window [yesterday, today) = 1 day. ✓
            toDaysBack = Math.max(0, Math.min(365, Number.parseInt(numMatch[1], 10)) - 1);
          } else {
            const hrMatch = p.match(/(\d{1,5})\s*hours?\s*ago/);
            if (hrMatch) {
              // Sub-day precision: keep sentinel -1 so toDate falls back to tomorrow,
              // which includes today. fromDate = yesterday (recencyWindowFromPrompt uses ceiling).
              toDaysBack = -1;
            }
          }
        }
      }

      // Explicit date/weekday patterns run AFTER ago patterns (same as recencyWindowFromPrompt)
      // and override the ago-derived offset when present.
      const isoMatch = p.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (isoMatch) {
        // +1 day: exclusive upper bound includes the named date
        const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);
        toDate = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
      } else {
        const usMatch = p.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        if (usMatch) {
          const year =
            usMatch[3].length === 2 ? 2000 + Number.parseInt(usMatch[3], 10) : Number.parseInt(usMatch[3], 10);
          // +1 day: exclusive upper bound includes the named date
          const d = new Date(`${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}T00:00:00Z`);
          toDate = new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10);
        } else {
          const dayOfWeekMatch = p.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
          if (dayOfWeekMatch) {
            const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
            const targetDay = dayNames.indexOf(dayOfWeekMatch[1]);
            const currentDay = now.getDay();
            const daysBack = (currentDay - targetDay + 7) % 7 || 7;
            // +1 day: exclusive upper bound includes the named weekday
            toDate = new Date(nowMs - (daysBack - 1) * 86_400_000).toISOString().slice(0, 10);
          } else {
            // Use the ago-derived offset.
            // toDaysBack=-1 means no pattern matched (or hours-ago): use tomorrow so today
            // is included in the window. toDaysBack=0 means N=1 ago (e.g. "1 day ago"):
            // toDate = today (exclusive) correctly creates a 1-day window [yesterday, today).
            toDate = toDaysBack < 0 ? tomorrow : new Date(nowMs - toDaysBack * 86_400_000).toISOString().slice(0, 10);
          }
        }
      }
    }
  }

  // Guard: if toDate would precede fromDate (inverted window from conflicting keywords),
  // fall back to tomorrow (exclusive upper bound that covers today) so we never produce
  // an empty window. Using `today` is insufficient because `date < today` excludes today.
  if (toDate <= fromDate) toDate = tomorrow;

  return { fromDate, toDate };
}
