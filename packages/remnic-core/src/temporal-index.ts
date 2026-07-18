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

import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export {
  clearIndexes,
  deindexMemory,
  indexMemoriesBatch,
  indexMemory,
  indexesExist,
} from "./temporal-index-compat.js";

export interface TemporalIndex {
  /** version bumped when schema changes */
  version: number;
  /** Last full rebuild timestamp (ISO string) */
  lastRebuildAt?: string;
  /** Map from YYYY-MM-DD → array of memory paths */
  dates: Record<string, string[]>;
  /**
   * Per-memory event-time rows used to reconstruct one chronology across
   * source sessions. Keyed by path so an update replaces the prior row.
   */
  events: Record<string, TemporalIndexEvent>;
}

export interface TemporalIndexEvent {
  path: string;
  /** Event/valid time used for chronology. */
  eventAt: string;
  /** Ingest/source-observation time, when known. */
  observedAt?: string;
  /** Source session provenance, when the extractor recorded it. */
  sessionKey?: string;
  /** Exclusive validity end, when the event is bounded. */
  validUntil?: string;
  /** SHA-256 lexical fingerprints for bounded query-aware candidate selection. */
  searchTokenHashes?: string[];
}

export interface TemporalIndexEntry {
  path: string;
  createdAt: string;
  tags: string[];
  validAt?: string;
  observedAt?: string;
  sessionKey?: string;
  validUntil?: string;
  /** Used only to derive token hashes; raw text is never persisted in the index. */
  searchText?: string;
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

export const INDEX_VERSION = 2;
const TEMPORAL_INDEX_FILE = "index_time.json";
const TAG_INDEX_FILE = "index_tags.json";
const TAG_INDEX_VERSION = 2;
const INDEX_LOCK_STALE_MS = 60_000;
const INDEX_LOCK_POLL_MS = 10;
const INDEX_PROCESS_START_TOLERANCE_MS = 2_000;
const INDEX_PROCESS_STARTED_AT_MS = Date.now() - process.uptime() * 1000;

interface IndexFileIdentity {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface CachedIndex<T> {
  identity: IndexFileIdentity;
  index: T;
  currentSchema: boolean;
}

type IndexLoadResult<T> =
  | { kind: "ok"; index: T; currentSchema: boolean }
  | { kind: "missing" }
  | { kind: "invalid" };

const parsedIndexCache = new Map<string, CachedIndex<unknown>>();
const writeChains = new Map<string, Promise<void>>();
// Operation-level serialization keyed by memoryDir (issue #1911, Codex Medium):
// a single logical index mutation touches TWO files (temporal + tag), each with
// its own per-file writeChain. Without an outer lock, two overlapping
// indexMemoryAsync calls could interleave so the temporal half of one commits
// with the tag half of the other. This chain makes each public mutator's paired
// writes atomic relative to other mutators on the same memoryDir.
const opChains = new Map<string, Promise<void>>();
let indexReadObserverForTest: (() => void) | undefined;

/** Test-only observer for asserting cache read/parse behavior. */
export function setIndexReadObserverForTest(observer?: () => void): void {
  indexReadObserverForTest = observer;
}

let indexWriteObserverForTest: ((filePath: string) => void) | undefined;

/** Test-only observer fired once per committed atomic index write. */
export function setIndexWriteObserverForTest(observer?: (filePath: string) => void): void {
  indexWriteObserverForTest = observer;
}

let indexWriteFailureForTest: ((filePath: string) => boolean) | undefined;

/**
 * Test-only hook to deterministically fail an atomic index write for matching
 * paths. Return true to fail the write for a given path. Lets partial-failure
 * branches be exercised without relying on filesystem permissions, which no-op
 * for privileged users (common in containerized CI) and differ on Windows.
 */
export function setIndexWriteFailureForTest(shouldFail?: (filePath: string) => boolean): void {
  indexWriteFailureForTest = shouldFail;
}

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

export async function ensureStateDir(memoryDir: string): Promise<void> {
  await fs.promises.mkdir(stateDir(memoryDir), { recursive: true });
}

function identityFromStat(stat: fs.Stats): IndexFileIdentity {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ino: stat.ino,
  };
}

function identityEquals(left: IndexFileIdentity, right: IndexFileIdentity): boolean {
  return left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino;
}

async function loadIndexCached<T>(
  filePath: string,
  normalize: (raw: unknown) => T,
  hasCurrentSchema: (raw: unknown) => boolean,
): Promise<IndexLoadResult<T>> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }

  try {
    const identity = identityFromStat(await handle.stat());
    const cached = parsedIndexCache.get(filePath) as CachedIndex<T> | undefined;
    if (cached && identityEquals(cached.identity, identity)) {
      return { kind: "ok", index: cached.index, currentSchema: cached.currentSchema };
    }
    indexReadObserverForTest?.();
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    const index = normalize(parsed);
    const currentSchema = hasCurrentSchema(parsed);
    parsedIndexCache.set(filePath, { identity, index, currentSchema });
    return { kind: "ok", index, currentSchema };
  } catch {
    parsedIndexCache.delete(filePath);
    return { kind: "invalid" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function withPathMutex<T>(filePath: string, update: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const run = previous.then(update, update);
  const tail = run.then(() => undefined, () => undefined);
  writeChains.set(filePath, tail);
  void tail.then(() => {
    if (writeChains.get(filePath) === tail) writeChains.delete(filePath);
  });
  return run;
}

/**
 * Operation-level mutex keyed by memoryDir (issue #1911, Codex Medium). Wraps a
 * whole logical index mutation (which writes BOTH the temporal and tag index
 * files) so overlapping mutators on the same memoryDir cannot interleave their
 * per-file writes and commit mismatched halves. The inner per-file writeChains
 * still protect each file; this outer chain just orders complete operations.
 */
export function withMemoryDirMutex<T>(memoryDir: string, op: () => Promise<T>): Promise<T> {
  const previous = opChains.get(memoryDir) ?? Promise.resolve();
  const run = previous.then(op, op);
  const tail = run.then(() => undefined, () => undefined);
  opChains.set(memoryDir, tail);
  void tail.then(() => {
    if (opChains.get(memoryDir) === tail) opChains.delete(memoryDir);
  });
  return run;
}
async function primeCacheAfterWrite(
  filePath: string,
  index: unknown,
  isCurrentSchema: () => boolean,
): Promise<void> {
  try {
    const identity = identityFromStat(await fs.promises.stat(filePath));
    // Derive currentSchema from the ACTUAL written index (issue #1911, Codex):
    // hardcoding true let deindexMemoryAsync (which does not bump version) cache
    // an old-schema index as current, so indexesExistAsync then skipped a
    // needed rebuild. The tag index is always current (no version gate); the
    // temporal index is current only when hasCurrentTemporalIndexSchema holds.
    parsedIndexCache.set(filePath, { identity, index, currentSchema: isCurrentSchema() });
  } catch {
    parsedIndexCache.delete(filePath);
  }
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

async function writeIndexLockOwner(lockDir: string): Promise<void> {
  try {
    await fs.promises.writeFile(
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

async function readIndexLockOwner(lockDir: string): Promise<IndexLockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(lockOwnerPath(lockDir), "utf8")) as { pid?: unknown };
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

async function readProcessStartedAtMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    const output = stdout.trim();
    if (!output) return null;
    const startedAtMs = Date.parse(output);
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

async function lockOwnerIsRunning(owner: IndexLockOwner): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return false;
  if (owner.processStartedAtMs === undefined) return true;
  const runningStartedAtMs = await readProcessStartedAtMs(owner.pid);
  if (runningStartedAtMs === null) return true;
  return runningStartedAtMs <= owner.processStartedAtMs + INDEX_PROCESS_START_TOLERANCE_MS;
}

function lockIsFresh(lockInfo: fs.Stats, owner: IndexLockOwner | null): boolean {
  const ownerCreatedAtMs =
    typeof owner?.createdAt === "string" && owner.createdAt.length > 0 ? Date.parse(owner.createdAt) : Number.NaN;
  const referenceMs = Number.isFinite(ownerCreatedAtMs) ? ownerCreatedAtMs : lockInfo.mtimeMs;
  return Date.now() - referenceMs < INDEX_LOCK_STALE_MS;
}

async function removeAbandonedIndexLock(lockDir: string): Promise<IndexLockCleanupResult> {
  try {
    const info = await fs.promises.lstat(lockDir);
    if (info.isSymbolicLink()) return "blocked";
    if (!info.isDirectory()) {
      await fs.promises.rm(lockDir, { force: true });
      return "removed";
    }
    const owner = await readIndexLockOwner(lockDir);
    if (owner !== null) {
      if (await lockOwnerIsRunning(owner)) return "wait";
    }
    if (owner === null && lockIsFresh(info, null)) return "wait";
    await fs.promises.rm(lockDir, { recursive: true, force: true });
    return "removed";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "removed";
    // Fail silently — indexes are advisory only
    return "blocked";
  }
}

async function withIndexFileLock<T>(filePath: string, update: () => Promise<T>): Promise<T | undefined> {
  const lockDir = `${filePath}.lock.d`;
  let acquired = false;

  while (!acquired) {
    try {
      await fs.promises.mkdir(lockDir);
      await writeIndexLockOwner(lockDir);
      acquired = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        try {
          await fs.promises.mkdir(path.dirname(lockDir), { recursive: true });
        } catch {
          return undefined;
        }
        await delay(INDEX_LOCK_POLL_MS);
        continue;
      }
      if (code !== "EEXIST") return undefined;
      const cleanupResult = await removeAbandonedIndexLock(lockDir);
      if (cleanupResult === "blocked") return undefined;
      await delay(INDEX_LOCK_POLL_MS);
    }
  }

  let result: T;
  try {
    result = await update();
  } finally {
    try {
      await fs.promises.rm(lockDir, { recursive: true, force: true });
    } catch {
      // Fail silently — indexes are advisory only
    }
  }
  return result;
}

/**
 * Atomic write: write to a unique `.tmp` sibling then rename so readers never
 * observe a partially-written file.
 */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<boolean> {
  const payload = JSON.stringify(data);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const tmp = uniqueTempPath(filePath);
    try {
      if (indexWriteFailureForTest?.(filePath)) {
        throw new Error("injected atomic-write failure (test)");
      }
      await fs.promises.writeFile(tmp, payload, "utf8");
      await fs.promises.rename(tmp, filePath);
      // The observer fires only after the committed rename. Isolate its
      // exceptions so a test hook can never turn a successful write into a
      // retry or a false (failed) result, which would clear the cache and
      // skip the paired tag-index phase.
      try {
        indexWriteObserverForTest?.(filePath);
      } catch {
        // Test hooks must not alter committed index-write results.
      }
      return true;
    } catch {
      try {
        await fs.promises.unlink(tmp);
      } catch {
        // Fail silently — indexes are advisory only
      }
      await delay(INDEX_LOCK_POLL_MS);
    }
  }
  return false;
}

function emptyTemporalIndex(): TemporalIndex {
  return { version: INDEX_VERSION, dates: {}, events: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTemporalIndex(raw: TemporalIndex | null | undefined): TemporalIndex {
  if (!isRecord(raw)) return emptyTemporalIndex();
  return {
    version: typeof raw.version === "number" ? raw.version : 0,
    dates: isRecord(raw.dates) ? raw.dates as Record<string, string[]> : {},
    events: isRecord(raw.events) ? raw.events as Record<string, TemporalIndexEvent> : {},
    ...(typeof raw.lastRebuildAt === "string" ? { lastRebuildAt: raw.lastRebuildAt } : {}),
  };
}

function hasCurrentTemporalIndexSchema(raw: unknown): boolean {
  return isRecord(raw) &&
    raw.version === INDEX_VERSION &&
    isRecord(raw.dates) &&
    isRecord(raw.events);
}

export async function updateTemporalIndex(memoryDir: string, update: (index: TemporalIndex) => void): Promise<boolean> {
  const indexPath = temporalIndexPath(memoryDir);
  return withPathMutex(indexPath, async () => {
    const ok = await withIndexFileLock(indexPath, async () => {
      const loaded = await loadIndexCached(
        indexPath,
        (raw) => normalizeTemporalIndex(raw as TemporalIndex),
        hasCurrentTemporalIndexSchema,
      );
      const index = structuredClone(loaded.kind === "ok" ? loaded.index : emptyTemporalIndex());
      update(index);
      if (await writeJsonAtomic(indexPath, index)) {
        await primeCacheAfterWrite(indexPath, index, () => hasCurrentTemporalIndexSchema(index));
        return true;
      }
      parsedIndexCache.delete(indexPath);
      return false;
    });
    return ok === true;
  });
}

export async function updateTagIndex(memoryDir: string, update: (index: TagIndex) => void): Promise<void> {
  const indexPath = tagIndexPath(memoryDir);
  await withPathMutex(indexPath, async () => {
    await withIndexFileLock(indexPath, async () => {
      const loaded = await loadIndexCached(
        indexPath,
        (raw) => normalizeTagIndex(raw as TagIndex),
        () => true,
      );
      const index = structuredClone(
        loaded.kind === "ok"
          ? loaded.index
          : { version: TAG_INDEX_VERSION, tags: {}, aliases: {} },
      );
      update(index);
      if (await writeJsonAtomic(indexPath, index)) {
        await primeCacheAfterWrite(indexPath, index, () => true);
      } else {
        parsedIndexCache.delete(indexPath);
      }
    });
  });
}

export function isoDateFromTimestamp(isoString: string): string {
  if (typeof isoString !== "string" || isoString.length < 10) {
    // Malformed frontmatter — fall back to today so the memory is still indexed.
    // Log a warning to surface data-quality issues without aborting the write.
    console.warn(`[engram] temporal-index: malformed timestamp "${isoString}", falling back to today`);
    return new Date().toISOString().slice(0, 10);
  }
  return isoString.slice(0, 10); // YYYY-MM-DD
}

function normalizedIsoTimestamp(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  try {
    return new Date(ms).toISOString();
  } catch {
    return undefined;
  }
}

export function temporalEventFromEntry(entry: TemporalIndexEntry): TemporalIndexEvent {
  const createdAt = normalizedIsoTimestamp(entry.createdAt) ?? new Date(0).toISOString();
  const eventAt = normalizedIsoTimestamp(entry.validAt) ?? createdAt;
  const observedAt = normalizedIsoTimestamp(entry.observedAt);
  const validUntil = normalizedIsoTimestamp(entry.validUntil);
  const sessionKey = typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
    ? entry.sessionKey.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
    : undefined;
  const searchTokenHashes = temporalSearchTokenHashes(entry.searchText);
  return {
    path: entry.path,
    eventAt,
    ...(observedAt ? { observedAt } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(searchTokenHashes.length > 0 ? { searchTokenHashes } : {}),
  };
}

function temporalSearchTokens(value: string | undefined): string[] {
  if (!value) return [];
  const tokens = value
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)
    ?.filter((token) => token.length > 1) ?? [];
  return [...new Set(tokens)].slice(0, 128);
}

function temporalSearchTokenHashes(value: string | undefined): string[] {
  return temporalSearchTokens(value).map((token) =>
    crypto.createHash("sha256").update(token).digest("hex"),
  );
}

function compareTemporalIndexEvents(
  left: TemporalIndexEvent,
  right: TemporalIndexEvent,
): number {
  const byEvent = left.eventAt.localeCompare(right.eventAt);
  if (byEvent !== 0) return byEvent;
  const byObservation = (left.observedAt ?? "").localeCompare(right.observedAt ?? "");
  if (byObservation !== 0) return byObservation;
  return left.path.localeCompare(right.path);
}

export function addPathToSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) {
    record[key] = [];
  }
  if (!record[key].includes(p)) {
    record[key].push(p);
  }
}

export function removePathFromSet(record: Record<string, string[]>, key: string, p: string): void {
  if (!record[key]) return;
  record[key] = record[key].filter((x) => x !== p);
  if (record[key].length === 0) {
    delete record[key];
  }
}

export function removePathFromAllSets(record: Record<string, string[]>, p: string): void {
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

export function addTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
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

export function removeTagGraphEntry(index: TagIndex, rawTag: string, memoryPath: string): void {
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

export function removePathFromAllTagEntries(index: TagIndex, memoryPath: string): void {
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

export type TemporalIndexCompatibilityMutation =
  | { kind: "index"; entries: TemporalIndexEntry[] }
  | { kind: "deindex"; entries: TemporalIndexEntry[] }
  | { kind: "clear" };

/** @internal Pure model shared by the deprecated synchronous compatibility surface. */
export function applyTemporalIndexCompatibilityMutation(
  raw: unknown,
  mutation: TemporalIndexCompatibilityMutation,
): TemporalIndex {
  const index = structuredClone(normalizeTemporalIndex(raw as TemporalIndex));
  if (mutation.kind === "clear") {
    return emptyTemporalIndex();
  }
  if (mutation.kind === "index") index.version = INDEX_VERSION;
  for (const entry of mutation.entries) {
    const dateKey = isoDateFromTimestamp(entry.createdAt);
    if (mutation.kind === "index") {
      removePathFromAllSets(index.dates, entry.path);
      addPathToSet(index.dates, dateKey, entry.path);
      index.events[entry.path] = temporalEventFromEntry(entry);
    } else {
      removePathFromSet(index.dates, dateKey, entry.path);
      delete index.events[entry.path];
    }
  }
  return index;
}

/** @internal Pure model shared by the deprecated synchronous compatibility surface. */
export function applyTagIndexCompatibilityMutation(
  raw: unknown,
  mutation: TemporalIndexCompatibilityMutation,
): TagIndex {
  const index = structuredClone(normalizeTagIndex(raw as TagIndex));
  if (mutation.kind === "clear") {
    return { version: TAG_INDEX_VERSION, tags: {}, aliases: {} };
  }
  for (const entry of mutation.entries) {
    if (mutation.kind === "index") {
      removePathFromAllTagEntries(index, entry.path);
      for (const tag of entry.tags) {
        if (tag && typeof tag === "string") addTagGraphEntry(index, tag, entry.path);
      }
    } else {
      for (const tag of entry.tags) {
        if (tag && typeof tag === "string") removeTagGraphEntry(index, tag, entry.path);
      }
    }
  }
  return index;
}

/** @internal Schema check shared by the deprecated synchronous compatibility surface. */
export function hasCurrentTemporalIndexSchemaForCompatibility(raw: unknown): boolean {
  return hasCurrentTemporalIndexSchema(raw);
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
export async function indexMemoryAsync(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
  temporal: Omit<Partial<TemporalIndexEntry>, "path" | "createdAt" | "tags"> = {},
): Promise<void> {
  try {
    await ensureStateDir(memoryDir);

    const dateKey = isoDateFromTimestamp(createdAt);
    await withMemoryDirMutex(memoryDir, async () => {
      // Write the temporal half first; if its atomic write FAILS, do NOT commit
      // the tag half (issue #1911, Cursor Medium) — committing tags while
      // temporal stays unchanged leaves a durable mismatch until a later index.
      const temporalOk = await updateTemporalIndex(memoryDir, (index) => {
        index.version = INDEX_VERSION;
        removePathFromAllSets(index.dates, memoryPath);
        addPathToSet(index.dates, dateKey, memoryPath);
        index.events[memoryPath] = temporalEventFromEntry({
          path: memoryPath,
          createdAt,
          tags,
          ...temporal,
        });
      });
      if (temporalOk) {
        await updateTagIndex(memoryDir, (index) => {
          removePathFromAllTagEntries(index, memoryPath);
          for (const tag of tags) {
            if (tag && typeof tag === "string") {
              addTagGraphEntry(index, tag, memoryPath);
            }
          }
        });
      }
    });
  } catch {
    // Fail silently
  }
}

/**
 * Remove a memory file from both indexes (called on deletion/archival).
 */
export async function deindexMemoryAsync(
  memoryDir: string,
  memoryPath: string,
  createdAt: string,
  tags: string[],
): Promise<void> {
  try {
    await ensureStateDir(memoryDir);

    const dateKey = isoDateFromTimestamp(createdAt);
    await withMemoryDirMutex(memoryDir, async () => {
      const temporalOk = await updateTemporalIndex(memoryDir, (index) => {
        removePathFromSet(index.dates, dateKey, memoryPath);
        delete index.events[memoryPath];
      });
      if (temporalOk) {
        await updateTagIndex(memoryDir, (index) => {
          for (const tag of tags) {
            if (tag && typeof tag === "string") {
              removeTagGraphEntry(index, tag, memoryPath);
            }
          }
        });
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
export async function clearIndexesAsync(memoryDir: string): Promise<void> {
  try {
    await ensureStateDir(memoryDir);
    await withMemoryDirMutex(memoryDir, async () => {
      const temporalOk = await updateTemporalIndex(memoryDir, (index) => {
        index.version = INDEX_VERSION;
        index.lastRebuildAt = undefined;
        index.dates = {};
        index.events = {};
      });
      if (temporalOk) {
        await updateTagIndex(memoryDir, (index) => {
          index.version = TAG_INDEX_VERSION;
          index.lastRebuildAt = undefined;
          index.tags = {};
          index.aliases = {};
        });
      }
    });
  } catch {
    // Fail silently — indexes are advisory only
  }
}

/**
 * Returns true when both index files exist on disk.
 * Used to detect first-time enablement so callers can trigger a full rebuild.
 */
export async function indexesExistAsync(memoryDir: string): Promise<boolean> {
  try {
    await fs.promises.access(tagIndexPath(memoryDir));
    const loaded = await loadIndexCached(
      temporalIndexPath(memoryDir),
      (raw) => normalizeTemporalIndex(raw as TemporalIndex),
      hasCurrentTemporalIndexSchema,
    );
    return loaded.kind === "ok" && loaded.currentSchema;
  } catch {
    return false;
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
    const loaded = await loadIndexCached(
      tPath,
      (raw) => normalizeTemporalIndex(raw as TemporalIndex),
      hasCurrentTemporalIndexSchema,
    );
    if (loaded.kind === "missing") return null;
    const tIndex = loaded.kind === "ok" ? loaded.index : emptyTemporalIndex();
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
 * Return the persisted event-time rows as one deterministic cross-session
 * chronology. Equal event times are ordered by observation time, then path.
 * Returns `null` when the index is missing, corrupt, or from an older schema;
 * callers can then fail open to the pre-index recall path.
 */
export async function queryTemporalTimelineAsync(
  memoryDir: string,
  options: { query?: string; limit?: number } = {},
): Promise<TemporalIndexEvent[] | null> {
  try {
    const loaded = await loadIndexCached(
      temporalIndexPath(memoryDir),
      (raw) => normalizeTemporalIndex(raw as TemporalIndex),
      hasCurrentTemporalIndexSchema,
    );
    if (loaded.kind !== "ok" || !loaded.currentSchema) return null;
    const index = loaded.index;
    const chronology = Object.values(index.events)
      .filter((event) =>
        typeof event?.path === "string" &&
        event.path.length > 0 &&
        normalizedIsoTimestamp(event.eventAt) !== undefined
      )
      .map((event) => ({
        path: event.path,
        eventAt: normalizedIsoTimestamp(event.eventAt)!,
        ...(normalizedIsoTimestamp(event.observedAt)
          ? { observedAt: normalizedIsoTimestamp(event.observedAt) }
          : {}),
        ...(typeof event.sessionKey === "string" && event.sessionKey.trim().length > 0
          ? { sessionKey: event.sessionKey.trim() }
          : {}),
        ...(normalizedIsoTimestamp(event.validUntil)
          ? { validUntil: normalizedIsoTimestamp(event.validUntil) }
          : {}),
        ...(Array.isArray(event.searchTokenHashes)
          ? { searchTokenHashes: event.searchTokenHashes.filter((hash) => typeof hash === "string") }
          : {}),
      }))
      .sort(compareTemporalIndexEvents);
    const requestedLimit = typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.max(0, Math.floor(options.limit))
      : chronology.length;
    if (requestedLimit === 0) return [];
    if (chronology.length <= requestedLimit) return chronology;

    const queryHashes = new Set(temporalSearchTokenHashes(options.query));
    const scored = chronology.map((event) => ({
      event,
      score: (event.searchTokenHashes ?? []).reduce(
        (sum, hash) => sum + (queryHashes.has(hash) ? 1 : 0),
        0,
      ),
    }));
    if (scored.some(({ score }) => score > 0)) {
      return scored
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || compareTemporalIndexEvents(left.event, right.event))
        .slice(0, requestedLimit)
        .map(({ event }) => event)
        .sort(compareTemporalIndexEvents);
    }

    // No lexical match (legacy rows or generic "first/last" query): retain
    // both chronology edges so earliest and latest questions remain answerable.
    const earlyCount = Math.ceil(requestedLimit / 2);
    const lateCount = requestedLimit - earlyCount;
    const selected = [
      ...chronology.slice(0, earlyCount),
      ...(lateCount > 0 ? chronology.slice(-lateCount) : []),
    ];
    return selected.sort(compareTemporalIndexEvents);
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
    const loaded = await loadIndexCached(
      gPath,
      (raw) => normalizeTagIndex(raw as TagIndex),
      () => true,
    );
    if (loaded.kind !== "ok") return null;
    return queryByTagsFromIndex(loaded.index, tags);
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
    const loaded = await loadIndexCached(
      tagIndexPath(memoryDir),
      (raw) => normalizeTagIndex(raw as TagIndex),
      () => true,
    );
    if (loaded.kind !== "ok") {
      return { matchedTags: explicitTags, expandedTags: explicitTags, paths: null };
    }
    const tagIndex = loaded.index;
    const matched = new Set<string>(explicitTags);
    const normalizedPrompt = ` ${normalizeAliasKey(prompt)} `;
    const containsAlias = (alias: string): boolean => {
      const phrase = aliasPhrase(alias);
      return phrase.length > 0 && normalizedPrompt.includes(` ${phrase} `);
    };

    for (const canonical of Object.keys(tagIndex.tags)) {
      if (containsAlias(canonical)) {
        matched.add(canonical);
      }
    }
    for (const [alias, canonicals] of Object.entries(tagIndex.aliases ?? {})) {
      if (!containsAlias(alias)) continue;
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
 * Run a group of index reads as ONE consistent snapshot (issue #1911, Codex
 * Medium). The `read` callback executes inside a single withMemoryDirMutex
 * acquisition — the same in-memory op-lock every async mutator holds across its
 * paired temporal+tag writes — so no mutation can land between the reads inside
 * it. A recall that reads the temporal and tag indexes together therefore never
 * observes a half-updated state (e.g. a new temporal row with a not-yet-written
 * tag membership) that would let prefiltering drop the current memory. The
 * genuine-tag-miss contract is preserved: a truly absent tag still yields an
 * empty set, only now never as a transient artifact of an in-flight write.
 * Index reads are cache-backed (microseconds), so ordering them on the op-chain
 * is negligible beside the multi-second QMD phase.
 */
export function readIndexSnapshotAsync<T>(
  memoryDir: string,
  read: () => Promise<T>,
): Promise<T> {
  return withMemoryDirMutex(memoryDir, read);
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
