/**
 * @remnic/core — Live Connectors State Store (issue #683 PR 1/N)
 *
 * Persists per-connector cursor + sync metadata to
 *   `<memoryDir>/state/connectors/<id>.json`
 *
 * Reasons this lives next to memory data, not in user config:
 *   - cursors are *operational* state that should travel with the memory
 *     directory when a user moves it across machines;
 *   - it keeps memory + ingest provenance co-located so tooling that backs up
 *     the memory directory captures cursor state too.
 *
 * Atomic-write contract (CLAUDE.md gotcha #54):
 *   - We NEVER `rmSync(target)` before `renameSync(tmp, target)`.
 *   - Writes go to a sibling tmp file and `rename()` swaps it in.
 *   - On error, the tmp file is best-effort cleaned up; the previous good
 *     state file is left untouched.
 *
 * Privacy: cursors are opaque connector-defined strings. We do not log them
 * and do not surface them through user-visible APIs. Document content NEVER
 * touches this module.
 */

import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

import { expandTildePath } from "../../utils/path.js";

import {
  isValidConnectorId,
  type ConnectorCursor,
} from "./framework.js";

/**
 * Status of the most recent sync attempt for a connector.
 *
 * `"never"` is distinct from `"success"` so callers can detect
 * "registered but never run" without inspecting timestamps. Per CLAUDE.md
 * gotcha #34, we deliberately distinguish empty/unknown from failure states.
 */
export type ConnectorSyncStatus = "success" | "error" | "never";

/**
 * Persisted per-connector state.
 *
 * Stored as pretty-printed JSON for human inspection — the file is small
 * (one record per connector) and operators may need to debug stuck cursors
 * by hand.
 */
export interface ConnectorState {
  /** Connector id. Matches the filename stem. */
  readonly id: string;
  /** Last persisted cursor, or `null` if the connector has never synced. */
  readonly cursor: ConnectorCursor | null;
  /** ISO 8601 timestamp of the last completed sync attempt, or `null`. */
  readonly lastSyncAt: string | null;
  /** Status of the last completed sync attempt. */
  readonly lastSyncStatus: ConnectorSyncStatus;
  /** Optional error message from the last failed sync. Truncated to 1 KB. */
  readonly lastSyncError?: string;
  /** Cumulative count of documents successfully imported across all syncs. */
  readonly totalDocsImported: number;
  /** ISO 8601 timestamp of when this state record was last written. */
  readonly updatedAt: string;
}

const STATE_DIR_NAME = "state";
const CONNECTORS_DIR_NAME = "connectors";
const CONNECTOR_LOCKS_DIR_NAME = "connector-locks";
const MAX_ERROR_LENGTH = 1024;
const CONNECTOR_LOCK_STALE_MS = 10 * 60 * 1000;
const CONNECTOR_LOCK_TIMEOUT_MS = 60 * 1000;
const CONNECTOR_LOCK_RETRY_MS = 50;
const VALID_SYNC_STATUSES: ReadonlySet<ConnectorSyncStatus> = new Set([
  "success",
  "error",
  "never",
]);

/**
 * Internal error thrown when a state file's JSON is unparseable or its shape
 * doesn't match `ConnectorState`. Used by `listConnectorStates` to distinguish
 * "skip this corrupt file" cases from genuine I/O failures (`EACCES`, `EIO`)
 * that the caller must see.
 */
class ConnectorStateCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorStateCorruptionError";
  }
}

/**
 * Resolve `<memoryDir>/state/connectors/`, expanding `~` per CLAUDE.md #17.
 */
function resolveConnectorsDir(memoryDir: string): string {
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    throw new TypeError("memoryDir must be a non-empty string");
  }
  return path.join(expandTildePath(memoryDir), STATE_DIR_NAME, CONNECTORS_DIR_NAME);
}

function resolveConnectorLocksDir(memoryDir: string): string {
  if (typeof memoryDir !== "string" || memoryDir.length === 0) {
    throw new TypeError("memoryDir must be a non-empty string");
  }
  return path.join(expandTildePath(memoryDir), STATE_DIR_NAME, CONNECTOR_LOCKS_DIR_NAME);
}

/**
 * Resolve the state file path for a single connector. Throws on invalid id
 * to prevent path traversal via crafted ids.
 */
function resolveConnectorStatePath(memoryDir: string, id: string): string {
  if (!isValidConnectorId(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
    );
  }
  return path.join(resolveConnectorsDir(memoryDir), `${id}.json`);
}

function resolveConnectorLockPath(memoryDir: string, id: string): string {
  if (!isValidConnectorId(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
    );
  }
  return path.join(resolveConnectorLocksDir(memoryDir), `${id}.lock`);
}

/**
 * Type guard for parsed state records. Validates the on-disk shape so a
 * corrupted/edited file produces a clear error rather than crashing later.
 *
 * Per CLAUDE.md gotcha #18, JSON.parse('null') yields `null` which would
 * pass a naive truthy check. We explicitly require an object.
 */
function isConnectorStateShape(value: unknown): value is ConnectorState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (typeof v.lastSyncStatus !== "string") return false;
  if (!["success", "error", "never"].includes(v.lastSyncStatus)) return false;
  // totalDocsImported is a cumulative count — fractional values would corrupt
  // metrics on later increments. Mirror the boundary check in writeConnectorState.
  if (typeof v.totalDocsImported !== "number" || !Number.isInteger(v.totalDocsImported)) return false;
  if (v.totalDocsImported < 0) return false;
  if (typeof v.updatedAt !== "string") return false;
  if (v.lastSyncAt !== null && typeof v.lastSyncAt !== "string") return false;
  if (v.cursor !== null) {
    if (typeof v.cursor !== "object" || v.cursor === null) return false;
    const c = v.cursor as Record<string, unknown>;
    if (typeof c.kind !== "string" || typeof c.value !== "string" || typeof c.updatedAt !== "string") {
      return false;
    }
  }
  if (v.lastSyncError !== undefined && typeof v.lastSyncError !== "string") return false;
  return true;
}

/**
 * Reject any path component along `<memoryDir>/state/connectors/<id>.json`
 * that is a symlink. Without this guard, a symlink in any of those
 * components would let `fs.readFile` escape the memory root and consume an
 * arbitrary outside file as cursor state — silently poisoning sync state and
 * violating the project-wide rule against symlink traversal.
 *
 * `lstat` is used (not `stat`) so we observe the link itself rather than its
 * target. Missing components are tolerated — the caller's `readFile` /
 * `mkdir` will surface ENOENT in its normal way.
 *
 * (PR #724 review.)
 */
async function assertNoSymlinkOnPath(memoryDir: string, filePath: string): Promise<void> {
  const expandedRoot = expandTildePath(memoryDir);
  // Normalize so `..` segments can't bypass the prefix check below.
  const root = path.resolve(expandedRoot);
  const target = path.resolve(filePath);
  const rel = path.relative(root, target);
  // path.relative() yields a "../..." prefix when target escapes root.
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `connector state path ${target} escapes memory root ${root}`,
    );
  }
  // Walk every component from root to target (inclusive) and lstat each.
  const segments = rel.length === 0 ? [] : rel.split(path.sep);
  let current = root;
  const componentsToCheck = [current];
  for (const seg of segments) {
    current = path.join(current, seg);
    componentsToCheck.push(current);
  }
  for (const component of componentsToCheck) {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(component);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Not yet created — that's fine; caller's readFile/mkdir handles it.
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `connector state path component ${component} is a symlink; refusing to follow`,
      );
    }
  }
}

async function tryAcquireConnectorLock(memoryDir: string, id: string): Promise<string | null> {
  const dir = resolveConnectorLocksDir(memoryDir);
  const lockPath = resolveConnectorLockPath(memoryDir, id);
  await assertNoSymlinkOnPath(memoryDir, lockPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await handle.close();
    return lockPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(lockPath);
    } catch (statErr) {
      if ((statErr as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw statErr;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(
        `connector state path component ${lockPath} is a symlink; refusing to follow`,
      );
    }
    if (Date.now() - stat.mtimeMs > CONNECTOR_LOCK_STALE_MS) {
      await fs.unlink(lockPath);
      return null;
    }
    return null;
  }
}

export async function withConnectorStateLock<T>(
  memoryDir: string,
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + CONNECTOR_LOCK_TIMEOUT_MS;
  let lockPath: string | null = null;
  while (lockPath === null) {
    lockPath = await tryAcquireConnectorLock(memoryDir, id);
    if (lockPath !== null) break;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for connector "${id}" state lock`);
    }
    await delay(CONNECTOR_LOCK_RETRY_MS);
  }
  try {
    return await run();
  } finally {
    try {
      await fs.unlink(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * Read the persisted state for a single connector.
 *
 * Returns `null` if the file does not exist (ENOENT). Throws on any other
 * I/O error or on shape mismatch — operators should see corruption loudly.
 *
 * Rejects symlinks anywhere on the path so a planted symlink can't redirect
 * reads outside the memory root. (PR #724 review.)
 */
export async function readConnectorState(
  memoryDir: string,
  id: string,
): Promise<ConnectorState | null> {
  const filePath = resolveConnectorStatePath(memoryDir, id);
  await assertNoSymlinkOnPath(memoryDir, filePath);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConnectorStateCorruptionError(
      `connector state at ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!isConnectorStateShape(parsed)) {
    throw new ConnectorStateCorruptionError(
      `connector state at ${filePath} does not match ConnectorState shape`,
    );
  }
  if (parsed.id !== id) {
    throw new ConnectorStateCorruptionError(
      `connector state at ${filePath} has mismatched id ${JSON.stringify(parsed.id)}; expected ${JSON.stringify(id)}`,
    );
  }
  return parsed;
}

/**
 * Write state atomically: create-tmp + rename. Never destroys the previous
 * file before the new one is in place — see CLAUDE.md gotcha #54.
 *
 * We accept `Omit<ConnectorState, "updatedAt">` and stamp `updatedAt`
 * ourselves so callers can't accidentally persist a stale timestamp.
 */
export async function writeConnectorState(
  memoryDir: string,
  id: string,
  state: Omit<ConnectorState, "updatedAt">,
): Promise<ConnectorState> {
  if (!isValidConnectorId(id)) {
    throw new TypeError(
      `invalid connector id ${JSON.stringify(id)} — must match /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/`,
    );
  }
  if (state.id !== id) {
    throw new Error(
      `writeConnectorState(): state.id ${JSON.stringify(state.id)} does not match id argument ${JSON.stringify(id)}`,
    );
  }
  // Full boundary validation. Persisting an out-of-shape record would brick
  // the connector's cursor file: subsequent `readConnectorState` calls would
  // throw `ConnectorStateCorruptionError` until manual repair. JS callers
  // bypassing TS types must be rejected here, not later. (PR #724 review.)
  if (!VALID_SYNC_STATUSES.has(state.lastSyncStatus as ConnectorSyncStatus)) {
    throw new Error(
      `writeConnectorState(): lastSyncStatus must be one of ${[...VALID_SYNC_STATUSES].join(", ")}, got ${JSON.stringify(state.lastSyncStatus)}`,
    );
  }
  if (state.lastSyncAt !== null && typeof state.lastSyncAt !== "string") {
    throw new Error(
      `writeConnectorState(): lastSyncAt must be a string or null, got ${typeof state.lastSyncAt}`,
    );
  }
  if (state.cursor !== null) {
    if (typeof state.cursor !== "object") {
      throw new Error(`writeConnectorState(): cursor must be an object or null`);
    }
    if (
      typeof state.cursor.kind !== "string" ||
      typeof state.cursor.value !== "string" ||
      typeof state.cursor.updatedAt !== "string"
    ) {
      throw new Error(
        `writeConnectorState(): cursor must have string kind, value, and updatedAt`,
      );
    }
  }
  if (
    typeof state.totalDocsImported !== "number" ||
    !Number.isInteger(state.totalDocsImported) ||
    state.totalDocsImported < 0
  ) {
    throw new Error(
      `writeConnectorState(): totalDocsImported must be a non-negative integer`,
    );
  }
  if (state.lastSyncError !== undefined && typeof state.lastSyncError !== "string") {
    throw new Error(`writeConnectorState(): lastSyncError must be a string when provided`);
  }
  const truncatedError =
    state.lastSyncError !== undefined && state.lastSyncError.length > MAX_ERROR_LENGTH
      ? state.lastSyncError.slice(0, MAX_ERROR_LENGTH)
      : state.lastSyncError;

  const finalState: ConnectorState = {
    id: state.id,
    cursor: state.cursor,
    lastSyncAt: state.lastSyncAt,
    lastSyncStatus: state.lastSyncStatus,
    ...(truncatedError !== undefined ? { lastSyncError: truncatedError } : {}),
    totalDocsImported: state.totalDocsImported,
    updatedAt: new Date().toISOString(),
  };

  const dir = resolveConnectorsDir(memoryDir);
  const targetPath = path.join(dir, `${id}.json`);
  // Reject planted symlinks before mkdir/write so a redirected target can't
  // overwrite an arbitrary file outside the memory root. (PR #724 review.)
  await assertNoSymlinkOnPath(memoryDir, targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const body = `${JSON.stringify(finalState, null, 2)}\n`;
  try {
    await fs.writeFile(tmpPath, body, { encoding: "utf-8", mode: 0o600 });
    await fs.rename(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file. Never touch `targetPath` — the
    // previous good state must remain readable on failure.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
  return finalState;
}

/**
 * Enumerate every persisted connector state. Returns an empty array when
 * the directory does not exist yet (clean install, no syncs ever run).
 *
 * Files that do not match the `<id>.json` naming rule are skipped — this
 * keeps stray editor backups (`.json~`, `.swp`) from breaking enumeration.
 *
 * Corruption (unparseable JSON, shape mismatch, id mismatch) is also
 * skipped so one bad file doesn't take down the listing. Operators
 * inspecting `state/connectors/` can still see the offending file by hand.
 *
 * **Genuine I/O failures (`EACCES`, `EIO`, etc.) are NOT swallowed** —
 * silently returning an incomplete state set would make active connectors
 * appear missing and trigger duplicate ingestion on the next scheduler tick.
 * (PR #724 review.)
 */
export async function listConnectorStates(memoryDir: string): Promise<ConnectorState[]> {
  const dir = resolveConnectorsDir(memoryDir);
  // Refuse to enumerate through a symlinked state directory — a planted
  // symlink at <memoryDir>/state or <memoryDir>/state/connectors would
  // otherwise let reads escape the memory root. (PR #724 review.)
  await assertNoSymlinkOnPath(memoryDir, dir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: ConnectorState[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!isValidConnectorId(id)) continue;
    try {
      const state = await readConnectorState(memoryDir, id);
      if (state !== null) out.push(state);
    } catch (err) {
      if (err instanceof ConnectorStateCorruptionError) {
        // Skip corrupt files; preserve availability of the rest.
        continue;
      }
      // Anything else (EACCES, EIO, ENOTDIR, ...) is a real operational
      // failure. Fail loudly so the scheduler / CLI can surface it.
      throw err;
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Test-only helper: resolve where a given connector's state lives. Exported
 * so tests can assert the on-disk layout without duplicating the path math.
 * Not part of the stable public API.
 *
 * @internal
 */
export function _connectorStatePathForTest(memoryDir: string, id: string): string {
  return resolveConnectorStatePath(memoryDir, id);
}
