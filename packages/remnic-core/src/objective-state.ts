import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
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

export type ObjectiveStateSnapshotSource = "tool_result" | "cli" | "system" | "manual";
export type ObjectiveStateSnapshotKind = "tool" | "file" | "process" | "record" | "workspace";
export type ObjectiveStateChangeKind = "created" | "updated" | "deleted" | "observed" | "executed" | "failed";
export type ObjectiveStateOutcome = "success" | "failure" | "partial" | "unknown";

export interface ObjectiveStateValueRef {
  exists?: boolean;
  ref?: string;
  valueHash?: string;
}

export interface ObjectiveStateSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  recordedAt: string;
  sessionKey: string;
  source: ObjectiveStateSnapshotSource;
  kind: ObjectiveStateSnapshotKind;
  changeKind: ObjectiveStateChangeKind;
  scope: string;
  summary: string;
  toolName?: string;
  command?: string;
  outcome?: ObjectiveStateOutcome;
  before?: ObjectiveStateValueRef;
  after?: ObjectiveStateValueRef;
  entityRefs?: string[];
  tags?: string[];
  metadata?: Record<string, string>;
}

export interface ObjectiveStateStoreStatus {
  enabled: boolean;
  writesEnabled: boolean;
  rootDir: string;
  snapshotsDir: string;
  snapshots: {
    total: number;
    valid: number;
    invalid: number;
    byKind: Partial<Record<ObjectiveStateSnapshotKind, number>>;
    byOutcome: Partial<Record<ObjectiveStateOutcome, number>>;
    latestSnapshotId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestSnapshot?: ObjectiveStateSnapshot;
  invalidSnapshots: Array<{
    path: string;
    error: string;
  }>;
}

export interface ObjectiveStateSearchResult {
  snapshot: ObjectiveStateSnapshot;
  score: number;
}

function validateValueRef(raw: unknown, field: string): ObjectiveStateValueRef | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const exists = typeof raw.exists === "boolean" ? raw.exists : undefined;
  const ref = optionalString(raw.ref);
  const valueHash = optionalString(raw.valueHash);
  if (exists === undefined && ref === undefined && valueHash === undefined) {
    throw new Error(`${field} must include exists, ref, or valueHash`);
  }
  return { exists, ref, valueHash };
}

function validateMetadata(raw: unknown): Record<string, string> | undefined {
  return validateStringRecord(raw, "metadata");
}

export function resolveObjectiveStateStoreDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "objective-state");
}

export function objectiveStateStoreOverrideForNamespace(options: {
  memoryDir: string;
  configuredStoreDir?: string;
  namespacesEnabled: boolean;
  namespace: string;
}): string | undefined {
  const configured = options.configuredStoreDir?.trim();
  if (!configured) return undefined;
  if (!options.namespacesEnabled) return configured;

  const defaultStoreDir = path.join(options.memoryDir, "state", "objective-state");
  if (path.resolve(configured) === path.resolve(defaultStoreDir)) {
    return undefined;
  }
  return path.join(configured, "namespaces", options.namespace);
}

export function validateObjectiveStateSnapshot(raw: unknown): ObjectiveStateSnapshot {
  if (!isRecord(raw)) throw new Error("objective-state snapshot must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const kind = assertString(raw.kind, "kind");
  if (!["tool", "file", "process", "record", "workspace"].includes(kind)) {
    throw new Error("kind must be one of tool|file|process|record|workspace");
  }

  const changeKind = assertString(raw.changeKind, "changeKind");
  if (!["created", "updated", "deleted", "observed", "executed", "failed"].includes(changeKind)) {
    throw new Error("changeKind must be one of created|updated|deleted|observed|executed|failed");
  }

  const outcomeRaw = optionalString(raw.outcome);
  if (outcomeRaw !== undefined && !["success", "failure", "partial", "unknown"].includes(outcomeRaw)) {
    throw new Error("outcome must be one of success|failure|partial|unknown");
  }

  return {
    schemaVersion: 1,
    snapshotId: assertSafePathSegment(assertString(raw.snapshotId, "snapshotId"), "snapshotId"),
    recordedAt: assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt")),
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as ObjectiveStateSnapshotSource,
    kind: kind as ObjectiveStateSnapshotKind,
    changeKind: changeKind as ObjectiveStateChangeKind,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    toolName: optionalString(raw.toolName),
    command: optionalString(raw.command),
    outcome: outcomeRaw as ObjectiveStateOutcome | undefined,
    before: validateValueRef(raw.before, "before"),
    after: validateValueRef(raw.after, "after"),
    entityRefs: optionalStringArray(raw.entityRefs, "entityRefs"),
    tags: optionalStringArray(raw.tags, "tags"),
    metadata: validateMetadata(raw.metadata),
  };
}

export async function recordObjectiveStateSnapshot(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  snapshot: ObjectiveStateSnapshot;
}): Promise<string> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const validated = validateObjectiveStateSnapshot(options.snapshot);
  const day = recordStoreDay(validated.recordedAt);
  const snapshotsDir = path.join(rootDir, "snapshots", day);
  const filePath = path.join(snapshotsDir, `${validated.snapshotId}.json`);
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

export async function getObjectiveStateStoreStatus(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  enabled: boolean;
  writesEnabled: boolean;
}): Promise<ObjectiveStateStoreStatus> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const snapshotsDir = path.join(rootDir, "snapshots");
  const { files, snapshots, invalidSnapshots } = await readObjectiveStateSnapshots(options);

  snapshots.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const byKind: Partial<Record<ObjectiveStateSnapshotKind, number>> = {};
  const byOutcome: Partial<Record<ObjectiveStateOutcome, number>> = {};
  for (const snapshot of snapshots) {
    byKind[snapshot.kind] = (byKind[snapshot.kind] ?? 0) + 1;
    const outcome = snapshot.outcome ?? "unknown";
    byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
  }

  return {
    enabled: options.enabled,
    writesEnabled: options.writesEnabled,
    rootDir,
    snapshotsDir,
    snapshots: {
      total: files.length,
      valid: snapshots.length,
      invalid: invalidSnapshots.length,
      byKind,
      byOutcome,
      latestSnapshotId: snapshots[0]?.snapshotId,
      latestRecordedAt: snapshots[0]?.recordedAt,
      latestSessionKey: snapshots[0]?.sessionKey,
    },
    latestSnapshot: snapshots[0],
    invalidSnapshots,
  };
}

async function readObjectiveStateSnapshots(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
}): Promise<{
  files: string[];
  snapshots: ObjectiveStateSnapshot[];
  invalidSnapshots: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const files = await listJsonFiles(path.join(rootDir, "snapshots"));
  const snapshots: ObjectiveStateSnapshot[] = [];
  const invalidSnapshots: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      snapshots.push(validateObjectiveStateSnapshot(await readJsonFile(filePath)));
    } catch (error) {
      invalidSnapshots.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, snapshots, invalidSnapshots };
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function overlapScore(queryTokens: Set<string>, value: string | undefined, weight: number): number {
  if (!value) return 0;
  const tokens = new Set(normalizeTokens(value));
  let matches = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) matches += 1;
  }
  return matches * weight;
}

function lexicalScoreObjectiveStateSnapshot(
  snapshot: ObjectiveStateSnapshot,
  queryTokens: Set<string>,
): number {
  let score = 0;
  score += overlapScore(queryTokens, snapshot.scope, 4);
  score += overlapScore(queryTokens, snapshot.summary, 3);
  score += overlapScore(queryTokens, snapshot.command, 3);
  score += overlapScore(queryTokens, snapshot.toolName, 2);
  score += overlapScore(queryTokens, snapshot.tags?.join(" "), 2);
  score += overlapScore(queryTokens, snapshot.entityRefs?.join(" "), 2);
  score += overlapScore(queryTokens, snapshot.kind, 1);
  score += overlapScore(queryTokens, snapshot.changeKind, 1);
  score += overlapScore(queryTokens, snapshot.outcome, 1);
  return score;
}

function scoreObjectiveStateSnapshot(
  snapshot: ObjectiveStateSnapshot,
  lexicalScore: number,
  sessionKey?: string,
): number {
  let score = lexicalScore;
  if (sessionKey && snapshot.sessionKey === sessionKey) score += 1.5;

  const recordedAtMs = Date.parse(snapshot.recordedAt);
  if (Number.isFinite(recordedAtMs)) {
    const ageHours = Math.max(0, (Date.now() - recordedAtMs) / 3_600_000);
    score += 1 / (1 + ageHours);
  }
  return score;
}

export async function searchObjectiveStateSnapshots(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  query: string;
  maxResults: number;
  sessionKey?: string;
}): Promise<ObjectiveStateSearchResult[]> {
  const maxResults = Math.max(0, Math.floor(options.maxResults));
  if (maxResults === 0) return [];

  const { snapshots } = await readObjectiveStateSnapshots(options);
  if (snapshots.length === 0) return [];

  const queryTokens = new Set(normalizeTokens(options.query));
  const scored = snapshots.map((snapshot) => {
    const lexicalScore = lexicalScoreObjectiveStateSnapshot(snapshot, queryTokens);
    return {
      snapshot,
      lexicalScore,
      score: scoreObjectiveStateSnapshot(snapshot, lexicalScore, options.sessionKey),
    };
  });

  const filtered = queryTokens.size === 0
    ? scored
    : scored.filter((result) => result.lexicalScore > 0);

  filtered.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.snapshot.recordedAt.localeCompare(left.snapshot.recordedAt);
  });
  return filtered.slice(0, maxResults);
}
