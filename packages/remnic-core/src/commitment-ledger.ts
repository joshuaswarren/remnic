import path from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalString,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export type CommitmentLedgerSource = "tool_result" | "cli" | "system" | "manual";
export type CommitmentLedgerKind = "promise" | "follow_up" | "deadline" | "deliverable";
export type CommitmentLedgerState = "open" | "fulfilled" | "cancelled" | "expired";

export interface CommitmentLedgerEntry {
  schemaVersion: 1;
  entryId: string;
  recordedAt: string;
  sessionKey: string;
  source: CommitmentLedgerSource;
  kind: CommitmentLedgerKind;
  state: CommitmentLedgerState;
  scope: string;
  summary: string;
  dueAt?: string;
  entityRefs?: string[];
  workProductEntryRefs?: string[];
  objectiveStateSnapshotRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
  stateChangedAt?: string;
  resolvedAt?: string;
}

export interface CommitmentLedgerStatus {
  enabled: boolean;
  rootDir: string;
  entriesDir: string;
  entries: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<CommitmentLedgerKind, number>>;
    byState: Partial<Record<CommitmentLedgerState, number>>;
    latestEntryId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestEntry?: CommitmentLedgerEntry;
  invalidEntries: Array<{
    path: string;
    error: string;
  }>;
  lifecycle?: {
    staleOpen: number;
    overdueOpen: number;
    decayEligibleResolved: number;
  };
}

export interface CommitmentLedgerLifecycleResult {
  transitionedToExpired: CommitmentLedgerEntry[];
  deletedResolved: CommitmentLedgerEntry[];
}

export function resolveCommitmentLedgerDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "commitment-ledger");
}

export function validateCommitmentLedgerEntry(raw: unknown): CommitmentLedgerEntry {
  if (!isRecord(raw)) throw new Error("commitment ledger entry must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const kind = assertString(raw.kind, "kind");
  if (!["promise", "follow_up", "deadline", "deliverable"].includes(kind)) {
    throw new Error("kind must be one of promise|follow_up|deadline|deliverable");
  }

  const state = assertString(raw.state, "state");
  if (!["open", "fulfilled", "cancelled", "expired"].includes(state)) {
    throw new Error("state must be one of open|fulfilled|cancelled|expired");
  }

  const dueAt = optionalString(raw.dueAt);
  if (dueAt !== undefined) {
    assertIsoRecordedAt(dueAt, "dueAt");
  }

  const stateChangedAt = optionalString(raw.stateChangedAt);
  if (stateChangedAt !== undefined) {
    assertIsoRecordedAt(stateChangedAt, "stateChangedAt");
  }

  const resolvedAt = optionalString(raw.resolvedAt);
  if (resolvedAt !== undefined) {
    assertIsoRecordedAt(resolvedAt, "resolvedAt");
  }

  const normalizedStateChangedAt = stateChangedAt ?? (state === "open" ? undefined : assertString(raw.recordedAt, "recordedAt"));
  const normalizedResolvedAt = resolvedAt ?? (state === "open" ? undefined : normalizedStateChangedAt);

  return {
    schemaVersion: 1,
    entryId: assertSafePathSegment(assertString(raw.entryId, "entryId"), "entryId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as CommitmentLedgerSource,
    kind: kind as CommitmentLedgerKind,
    state: state as CommitmentLedgerState,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    dueAt,
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    workProductEntryRefs: optionalStringArray(raw.workProductEntryRefs, "workProductEntryRefs"),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
    stateChangedAt: normalizedStateChangedAt,
    resolvedAt: normalizedResolvedAt,
  };
}

export async function recordCommitmentLedgerEntry(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  entry: CommitmentLedgerEntry;
}): Promise<string> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const validated = validateCommitmentLedgerEntry(options.entry);
  const day = recordStoreDay(validated.recordedAt);
  const entriesDir = path.join(rootDir, "entries", day);
  const filePath = path.join(entriesDir, `${validated.entryId}.json`);
  await mkdir(entriesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readCommitmentLedgerEntries(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
}): Promise<{
  files: string[];
  entries: CommitmentLedgerEntry[];
  entryFiles: Array<{ entry: CommitmentLedgerEntry; filePath: string }>;
  invalidEntries: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const files = await listJsonFiles(path.join(rootDir, "entries"));
  const entries: CommitmentLedgerEntry[] = [];
  const entryFiles: Array<{ entry: CommitmentLedgerEntry; filePath: string }> = [];
  const invalidEntries: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      const entry = validateCommitmentLedgerEntry(await readJsonFile(filePath));
      entries.push(entry);
      entryFiles.push({ entry, filePath });
    } catch (error) {
      invalidEntries.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, entries, entryFiles, invalidEntries };
}

function isResolvedState(state: CommitmentLedgerState): boolean {
  return state === "fulfilled" || state === "cancelled" || state === "expired";
}

function isOverdueOpenEntry(entry: CommitmentLedgerEntry, nowMs: number): boolean {
  return entry.state === "open" && typeof entry.dueAt === "string" && Date.parse(entry.dueAt) < nowMs;
}

function isStaleOpenEntry(entry: CommitmentLedgerEntry, nowMs: number, staleDays: number): boolean {
  if (entry.state !== "open") return false;
  if (typeof entry.dueAt === "string") return false;
  const staleCutoff = nowMs - staleDays * 24 * 60 * 60 * 1000;
  return Date.parse(entry.recordedAt) < staleCutoff;
}

function isDecayEligibleResolvedEntry(entry: CommitmentLedgerEntry, nowMs: number, decayDays: number): boolean {
  if (!isResolvedState(entry.state)) return false;
  const reference = entry.resolvedAt ?? entry.stateChangedAt ?? entry.recordedAt;
  const decayCutoff = nowMs - decayDays * 24 * 60 * 60 * 1000;
  return Date.parse(reference) < decayCutoff;
}

function assertPositiveIntegerDays(value: number, keyName: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${keyName} must be an integer greater than or equal to 1; got ${String(value)}`);
  }
  return value;
}

async function findCommitmentLedgerEntryById(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  entryId: string;
}): Promise<{ entry: CommitmentLedgerEntry; filePath: string } | null> {
  const { entryFiles } = await readCommitmentLedgerEntries(options);
  for (const candidate of entryFiles) {
    if (candidate.entry.entryId === options.entryId || path.basename(candidate.filePath, ".json") === options.entryId) {
      return candidate;
    }
  }
  return null;
}

export async function transitionCommitmentLedgerEntryState(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  entryId: string;
  nextState: CommitmentLedgerState;
  changedAt: string;
}): Promise<CommitmentLedgerEntry> {
  const match = await findCommitmentLedgerEntryById(options);
  if (!match) {
    throw new Error(`commitment entry not found: ${options.entryId}`);
  }

  const changedAt = assertIsoRecordedAt(options.changedAt, "changedAt");
  const nextState = options.nextState;
  const nextEntry: CommitmentLedgerEntry = {
    ...match.entry,
    state: nextState,
    stateChangedAt: changedAt,
    resolvedAt: isResolvedState(nextState) ? changedAt : undefined,
  };

  await writeFile(match.filePath, JSON.stringify(validateCommitmentLedgerEntry(nextEntry), null, 2), "utf8");
  return nextEntry;
}

export async function applyCommitmentLedgerLifecycle(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  enabled: boolean;
  decayDays: number;
  now?: string;
}): Promise<CommitmentLedgerLifecycleResult> {
  if (!options.enabled) {
    return { transitionedToExpired: [], deletedResolved: [] };
  }

  const nowIso = assertIsoRecordedAt(options.now ?? new Date().toISOString(), "now");
  const nowMs = Date.parse(nowIso);
  const decayDays = assertPositiveIntegerDays(options.decayDays, "decayDays");
  const { entryFiles } = await readCommitmentLedgerEntries(options);

  const transitionedToExpired: CommitmentLedgerEntry[] = [];
  const deletedResolved: CommitmentLedgerEntry[] = [];

  for (const { entry, filePath } of entryFiles) {

    if (isOverdueOpenEntry(entry, nowMs)) {
      const updated = validateCommitmentLedgerEntry({
        ...entry,
        state: "expired",
        stateChangedAt: nowIso,
        resolvedAt: nowIso,
      });
      await writeFile(filePath, JSON.stringify(updated, null, 2), "utf8");
      transitionedToExpired.push(updated);
      continue;
    }

    if (isDecayEligibleResolvedEntry(entry, nowMs, decayDays)) {
      await unlink(filePath);
      deletedResolved.push(entry);
    }
  }

  return { transitionedToExpired, deletedResolved };
}

export async function getCommitmentLedgerStatus(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  enabled: boolean;
  lifecycleEnabled?: boolean;
  staleDays?: number;
  decayDays?: number;
  now?: string;
}): Promise<CommitmentLedgerStatus> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const entriesDir = path.join(rootDir, "entries");
  const { files, entries, invalidEntries } = await readCommitmentLedgerEntries(options);
  entries.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const nowMs = Date.parse(assertIsoRecordedAt(options.now ?? new Date().toISOString(), "now"));
  const staleDays = Math.max(1, Math.floor(options.staleDays ?? 14));
  const decayDays = Math.max(1, Math.floor(options.decayDays ?? 90));

  const byKind: Partial<Record<CommitmentLedgerKind, number>> = {};
  const byState: Partial<Record<CommitmentLedgerState, number>> = {};
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    byState[entry.state] = (byState[entry.state] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    rootDir,
    entriesDir,
    entries: {
      total: files.length,
      valid: entries.length,
      invalid: invalidEntries.length,
      byKind,
      byState,
      latestEntryId: entries[0]?.entryId,
      latestRecordedAt: entries[0]?.recordedAt,
      latestSessionKey: entries[0]?.sessionKey,
    },
    latestEntry: entries[0],
    invalidEntries,
    lifecycle: options.lifecycleEnabled
      ? {
          overdueOpen: entries.filter((entry) => isOverdueOpenEntry(entry, nowMs)).length,
          staleOpen: entries.filter((entry) => isStaleOpenEntry(entry, nowMs, staleDays)).length,
          decayEligibleResolved: entries.filter((entry) => isDecayEligibleResolvedEntry(entry, nowMs, decayDays)).length,
        }
      : undefined,
  };
}
