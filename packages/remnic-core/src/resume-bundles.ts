import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { listJsonFiles, readJsonFile } from "./json-store.js";
import {
  resolveObjectiveStateStoreDir,
  validateObjectiveStateSnapshot,
  type ObjectiveStateSnapshot,
} from "./objective-state.js";
import {
  resolveWorkProductLedgerDir,
  validateWorkProductLedgerEntry,
  type WorkProductLedgerEntry,
} from "./work-product-ledger.js";
import {
  resolveCommitmentLedgerDir,
  validateCommitmentLedgerEntry,
  type CommitmentLedgerEntry,
} from "./commitment-ledger.js";
import { parseConfig } from "./config.js";
import { TranscriptManager } from "./transcript.js";
import {
  assertIsoRecordedAt,
  assertSafePathSegment,
  assertString,
  isRecord,
  optionalStringArray,
  recordStoreDay,
  validateStringRecord,
} from "./store-contract.js";

export type ResumeBundleSource = "tool_result" | "cli" | "system" | "manual";

export interface ResumeBundle {
  schemaVersion: 1;
  bundleId: string;
  recordedAt: string;
  sessionKey: string;
  source: ResumeBundleSource;
  scope: string;
  summary: string;
  objectiveStateSnapshotRefs?: string[];
  workProductEntryRefs?: string[];
  commitmentEntryRefs?: string[];
  keyFacts?: string[];
  nextActions?: string[];
  riskFlags?: string[];
  metadata?: Record<string, string>;
}

export interface ResumeBundleStatus {
  enabled: boolean;
  rootDir: string;
  bundlesDir: string;
  bundles: {
    total: number;
    valid: number;
    invalid: number;
    bySource: Partial<Record<ResumeBundleSource, number>>;
    latestBundleId?: string;
    latestRecordedAt?: string;
    latestSessionKey?: string;
  };
  latestBundle?: ResumeBundle;
  invalidBundles: Array<{
    path: string;
    error: string;
  }>;
}

const DEFAULT_RESUME_BUNDLE_REF_LIMIT = 5;

export function resolveResumeBundleDir(memoryDir: string, overrideDir?: string): string {
  if (typeof overrideDir === "string" && overrideDir.trim().length > 0) {
    return overrideDir.trim();
  }
  return path.join(memoryDir, "state", "resume-bundles");
}

export function validateResumeBundle(raw: unknown): ResumeBundle {
  if (!isRecord(raw)) throw new Error("resume bundle must be an object");
  if (raw.schemaVersion !== 1) throw new Error("schemaVersion must be 1");

  const source = assertString(raw.source, "source");
  if (!["tool_result", "cli", "system", "manual"].includes(source)) {
    throw new Error("source must be one of tool_result|cli|system|manual");
  }

  const recordedAt = assertIsoRecordedAt(assertString(raw.recordedAt, "recordedAt"));
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error("recordedAt must be an ISO timestamp");
  }

  return {
    schemaVersion: 1,
    bundleId: assertSafePathSegment(assertString(raw.bundleId, "bundleId"), "bundleId"),
    recordedAt,
    sessionKey: assertString(raw.sessionKey, "sessionKey"),
    source: source as ResumeBundleSource,
    scope: assertString(raw.scope, "scope"),
    summary: assertString(raw.summary, "summary"),
    objectiveStateSnapshotRefs: optionalStringArray(raw.objectiveStateSnapshotRefs, "objectiveStateSnapshotRefs"),
    workProductEntryRefs: optionalStringArray(raw.workProductEntryRefs, "workProductEntryRefs"),
    commitmentEntryRefs: optionalStringArray(raw.commitmentEntryRefs, "commitmentEntryRefs"),
    keyFacts: optionalStringArray(raw.keyFacts, "keyFacts"),
    nextActions: optionalStringArray(raw.nextActions, "nextActions"),
    riskFlags: optionalStringArray(raw.riskFlags, "riskFlags"),
    metadata: validateStringRecord(raw.metadata, "metadata"),
  };
}

async function readValidatedItems<T>(options: {
  rootDir: string;
  validate: (raw: unknown) => T;
}): Promise<T[]> {
  const files = await listJsonFiles(options.rootDir);
  const items: T[] = [];
  for (const filePath of files) {
    try {
      items.push(options.validate(await readJsonFile(filePath)));
    } catch {
      // Status inspection already reports invalid artifacts. Bundle assembly fail-opens.
    }
  }
  return items;
}

async function readObjectiveStateSnapshotsForSession(options: {
  memoryDir: string;
  objectiveStateStoreDir?: string;
  sessionKey: string;
  maxResults?: number;
}): Promise<ObjectiveStateSnapshot[]> {
  const rootDir = resolveObjectiveStateStoreDir(options.memoryDir, options.objectiveStateStoreDir);
  const items = await readValidatedItems({
    rootDir: path.join(rootDir, "snapshots"),
    validate: validateObjectiveStateSnapshot,
  });
  return items
    .filter((item) => item.sessionKey === options.sessionKey)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, options.maxResults ?? DEFAULT_RESUME_BUNDLE_REF_LIMIT);
}

async function readWorkProductEntriesForSession(options: {
  memoryDir: string;
  workProductLedgerDir?: string;
  sessionKey: string;
  maxResults?: number;
}): Promise<WorkProductLedgerEntry[]> {
  const rootDir = resolveWorkProductLedgerDir(options.memoryDir, options.workProductLedgerDir);
  const items = await readValidatedItems({
    rootDir: path.join(rootDir, "entries"),
    validate: validateWorkProductLedgerEntry,
  });
  return items
    .filter((item) => item.sessionKey === options.sessionKey)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, options.maxResults ?? DEFAULT_RESUME_BUNDLE_REF_LIMIT);
}

async function readCommitmentEntriesForSession(options: {
  memoryDir: string;
  commitmentLedgerDir?: string;
  sessionKey: string;
  maxResults?: number;
  state?: CommitmentLedgerEntry["state"];
}): Promise<CommitmentLedgerEntry[]> {
  const rootDir = resolveCommitmentLedgerDir(options.memoryDir, options.commitmentLedgerDir);
  const items = await readValidatedItems({
    rootDir: path.join(rootDir, "entries"),
    validate: validateCommitmentLedgerEntry,
  });
  return items
    .filter((item) => item.sessionKey === options.sessionKey)
    .filter((item) => (options.state ? item.state === options.state : true))
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
    .slice(0, options.maxResults ?? DEFAULT_RESUME_BUNDLE_REF_LIMIT);
}

function buildRecoveryFact(recoverySummary: {
  healthy: boolean;
  issueCount: number;
  incompleteTurns: number;
  brokenChains: number;
  checkpointHealthy: boolean;
}): string {
  return recoverySummary.healthy
    ? `Transcript recovery healthy with ${recoverySummary.issueCount} issue(s), ${recoverySummary.incompleteTurns} incomplete turn(s), and ${recoverySummary.brokenChains} broken chain(s).`
    : `Transcript recovery flagged ${recoverySummary.issueCount} issue(s), ${recoverySummary.incompleteTurns} incomplete turn(s), and ${recoverySummary.brokenChains} broken chain(s); checkpoint healthy: ${recoverySummary.checkpointHealthy ? "yes" : "no"}.`;
}

function buildBundleSummary(options: {
  sessionKey: string;
  openCommitmentCount: number;
  workProductCount: number;
  objectiveSnapshotCount: number;
  recoveryHealthy?: boolean;
}): string {
  const parts = [
    `${options.openCommitmentCount} open commitment(s)`,
    `${options.workProductCount} recent work product(s)`,
    `${options.objectiveSnapshotCount} recent objective-state snapshot(s)`,
  ];
  if (options.recoveryHealthy === false) {
    parts.push("transcript recovery issues remain");
  }
  return `Resume ${options.sessionKey}: ${parts.join(", ")}.`;
}

export async function buildResumeBundleFromState(options: {
  memoryDir: string;
  sessionKey: string;
  bundleId: string;
  recordedAt: string;
  scope: string;
  source?: ResumeBundleSource;
  transcriptEnabled?: boolean;
  objectiveStateMemoryEnabled?: boolean;
  objectiveStateStoreDir?: string;
  creationMemoryEnabled?: boolean;
  workProductLedgerDir?: string;
  commitmentLedgerEnabled?: boolean;
  commitmentLedgerDir?: string;
  maxRefsPerStore?: number;
}): Promise<ResumeBundle> {
  const recordedAt = assertIsoRecordedAt(options.recordedAt, "recordedAt");
  const maxRefsPerStore = Math.max(1, Math.floor(options.maxRefsPerStore ?? DEFAULT_RESUME_BUNDLE_REF_LIMIT));

  const objectiveSnapshots = options.objectiveStateMemoryEnabled
    ? await readObjectiveStateSnapshotsForSession({
        memoryDir: options.memoryDir,
        objectiveStateStoreDir: options.objectiveStateStoreDir,
        sessionKey: options.sessionKey,
        maxResults: maxRefsPerStore,
      })
    : [];

  const workProducts = options.creationMemoryEnabled
    ? await readWorkProductEntriesForSession({
        memoryDir: options.memoryDir,
        workProductLedgerDir: options.workProductLedgerDir,
        sessionKey: options.sessionKey,
        maxResults: maxRefsPerStore,
      })
    : [];

  const commitments = options.creationMemoryEnabled && options.commitmentLedgerEnabled
    ? await readCommitmentEntriesForSession({
        memoryDir: options.memoryDir,
        commitmentLedgerDir: options.commitmentLedgerDir,
        sessionKey: options.sessionKey,
        maxResults: maxRefsPerStore,
        state: "open",
      })
    : [];

  const openCommitments = commitments;
  const recordedAtMs = Date.parse(recordedAt);
  const overdueCommitments = openCommitments.filter((entry) => {
    if (!entry.dueAt) return false;
    const dueAtMs = Date.parse(entry.dueAt);
    return Number.isFinite(dueAtMs) && dueAtMs < recordedAtMs;
  });

  let recoverySummary:
    | {
        healthy: boolean;
        issueCount: number;
        incompleteTurns: number;
        brokenChains: number;
        checkpointHealthy: boolean;
      }
    | undefined;
  if (options.transcriptEnabled) {
    const transcript = new TranscriptManager(parseConfig({
      memoryDir: options.memoryDir,
      transcriptEnabled: true,
    }));
    await transcript.initialize();
    recoverySummary = await transcript.getRecoverySummary(options.sessionKey);
  }

  const keyFacts = [
    recoverySummary ? buildRecoveryFact(recoverySummary) : undefined,
    workProducts[0]?.summary,
    objectiveSnapshots[0]?.summary,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const nextActions = openCommitments
    .map((entry) => entry.summary)
    .filter((summary, index, values) => values.indexOf(summary) === index)
    .slice(0, maxRefsPerStore);

  const riskFlags = [
    recoverySummary && !recoverySummary.healthy ? buildRecoveryFact(recoverySummary) : undefined,
    ...objectiveSnapshots
      .filter((snapshot) => snapshot.outcome === "failure" || snapshot.outcome === "partial")
      .map((snapshot) => snapshot.summary),
    ...overdueCommitments.map((entry) => `Overdue commitment: ${entry.summary}`),
  ].filter((value, index, values): value is string =>
    typeof value === "string" && value.length > 0 && values.indexOf(value) === index,
  );

  return validateResumeBundle({
    schemaVersion: 1,
    bundleId: options.bundleId,
    recordedAt,
    sessionKey: options.sessionKey,
    source: options.source ?? "system",
    scope: options.scope,
    summary: buildBundleSummary({
      sessionKey: options.sessionKey,
      openCommitmentCount: openCommitments.length,
      workProductCount: workProducts.length,
      objectiveSnapshotCount: objectiveSnapshots.length,
      recoveryHealthy: recoverySummary?.healthy,
    }),
    objectiveStateSnapshotRefs: objectiveSnapshots.map((snapshot) => snapshot.snapshotId),
    workProductEntryRefs: workProducts.map((entry) => entry.entryId),
    commitmentEntryRefs: openCommitments.map((entry) => entry.entryId),
    keyFacts: keyFacts.length > 0 ? keyFacts : undefined,
    nextActions: nextActions.length > 0 ? nextActions : undefined,
    riskFlags: riskFlags.length > 0 ? riskFlags : undefined,
  });
}

export async function recordResumeBundle(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  bundle: ResumeBundle;
}): Promise<string> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const validated = validateResumeBundle(options.bundle);
  const day = recordStoreDay(validated.recordedAt);
  const bundlesDir = path.join(rootDir, "bundles", day);
  const filePath = path.join(bundlesDir, `${validated.bundleId}.json`);
  await mkdir(bundlesDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(validated, null, 2), "utf8");
  return filePath;
}

async function readResumeBundles(options: {
  memoryDir: string;
  resumeBundleDir?: string;
}): Promise<{
  files: string[];
  bundles: ResumeBundle[];
  invalidBundles: Array<{ path: string; error: string }>;
}> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const files = await listJsonFiles(path.join(rootDir, "bundles"));
  const bundles: ResumeBundle[] = [];
  const invalidBundles: Array<{ path: string; error: string }> = [];
  for (const filePath of files) {
    try {
      bundles.push(validateResumeBundle(await readJsonFile(filePath)));
    } catch (error) {
      invalidBundles.push({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { files, bundles, invalidBundles };
}

export async function getResumeBundleStatus(options: {
  memoryDir: string;
  resumeBundleDir?: string;
  enabled: boolean;
}): Promise<ResumeBundleStatus> {
  const rootDir = resolveResumeBundleDir(options.memoryDir, options.resumeBundleDir);
  const bundlesDir = path.join(rootDir, "bundles");
  if (!options.enabled) {
    return {
      enabled: false,
      rootDir,
      bundlesDir,
      bundles: {
        total: 0,
        valid: 0,
        invalid: 0,
        bySource: {},
      },
      invalidBundles: [],
    };
  }
  const { files, bundles, invalidBundles } = await readResumeBundles(options);

  let latestBundle: ResumeBundle | undefined;
  const bySource: Partial<Record<ResumeBundleSource, number>> = {};
  for (const bundle of bundles) {
    bySource[bundle.source] = (bySource[bundle.source] ?? 0) + 1;
    if (!latestBundle || Date.parse(bundle.recordedAt) > Date.parse(latestBundle.recordedAt)) {
      latestBundle = bundle;
    }
  }

  return {
    enabled: options.enabled,
    rootDir,
    bundlesDir,
    bundles: {
      total: files.length,
      valid: bundles.length,
      invalid: invalidBundles.length,
      bySource,
      latestBundleId: latestBundle?.bundleId,
      latestRecordedAt: latestBundle?.recordedAt,
      latestSessionKey: latestBundle?.sessionKey,
    },
    latestBundle,
    invalidBundles,
  };
}
