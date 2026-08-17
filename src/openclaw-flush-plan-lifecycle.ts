import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { ImportTurn } from "@remnic/core/bulk-import";

export type OpenClawFlushPlanProcessStatus =
  | "disabled"
  | "missing"
  | "empty"
  | "skipped"
  | "processed"
  | "processed_preserved_tail"
  | "processed_marker_recovered"
  | "processed_marker_recovered_tail"
  | "processed_cleanup_deferred";

export interface OpenClawFlushPlanProcessResult {
  status: OpenClawFlushPlanProcessStatus;
  path?: string;
  bytesProcessed?: number;
  preservedBytes?: number;
  reason?: string;
}

export interface OpenClawFlushPlanIngestor {
  ingestBulkImportBatch(
    turns: ImportTurn[],
    options?: {
      deadlineMs?: number;
      failOnExtractionFailure?: boolean;
      includeSourceValidAtContext?: boolean;
    },
  ): Promise<void | OpenClawFlushPlanIngestResult>;
}

export interface OpenClawFlushPlanIngestResult {
  attemptedTurnCount?: number;
  extractionCount?: number;
  persistedCount?: number;
  durableOutputCount?: number;
  skippedCount?: number;
  failedCount?: number;
  postPersistMetadataFailureCount?: number;
  processedTurnCount?: number;
}

export interface OpenClawFlushPlanLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface ProcessOpenClawFlushPlanFileParams {
  enabled: boolean;
  workspaceDir: string;
  serviceId: string;
  ingestor: OpenClawFlushPlanIngestor;
  logger?: OpenClawFlushPlanLogger;
  reason?: string;
  deadlineMs?: number;
  maxTurnChars?: number;
  now?: () => Date;
}

const DEFAULT_MAX_IMPORT_TURN_CHARS = 4000;
const MARKER_WRITE_TEMP_ATTEMPTS = 8;
const CLEANUP_SNAPSHOT_PREFIX = "flush-plan.cleanup-";
const CLEANUP_SNAPSHOT_SUFFIX = ".md";
const CLEANUP_SNAPSHOT_TIMESTAMP_PATTERN =
  /^flush-plan\.cleanup-[^.]+\.(\d+)\.[^.]+\.md$/;
const FLUSH_PLAN_CHANGED_BEFORE_CLEANUP_REASON =
  "flush plan changed before cleanup; restored rotated content";
const FLUSH_PLAN_METADATA_FAILURE_CLEANUP_DEFERRED_REASON =
  "flush plan imported but metadata persistence was incomplete; cleanup deferred";
const FLUSH_PLAN_IMPORT_INSTRUCTION =
  "Extract durable Remnic memories from this OpenClaw pre-compaction flush-plan snapshot. " +
  "Treat this wrapper as provenance only. Ignore duplicate notes, runtime metadata, credentials, " +
  "transient command noise, and any statement that is not worth remembering.";

interface ProcessedFlushPlanMarker {
  version: 1;
  status: "pending" | "processed";
  processedHash: string;
  processedBytes: number;
  processedContent?: string;
  processedChunks?: ProcessedFlushPlanMarkerChunk[];
  processedAt: string;
  reason: string;
}

interface ProcessedFlushPlanMarkerChunk {
  rawBytes: number;
  turnFingerprint: string;
  timestamp: string;
  chunkIndex: number;
  chunkCount: number;
  maxTurnChars: number;
}

export function resolveOpenClawFlushPlanPath(params: {
  workspaceDir: string;
  serviceId: string;
}): string {
  return path.resolve(
    params.workspaceDir,
    "state",
    "plugins",
    params.serviceId,
    "flush-plan.md",
  );
}

function resolveProcessedMarkerPath(flushPlanPath: string): string {
  return path.join(path.dirname(flushPlanPath), "flush-plan.processed.json");
}

function resolveCleanupSnapshotPath(flushPlanPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return path.join(path.dirname(flushPlanPath), `flush-plan.cleanup-${suffix}.md`);
}

function isCleanupSnapshotName(name: string): boolean {
  return name.startsWith(CLEANUP_SNAPSHOT_PREFIX) && name.endsWith(CLEANUP_SNAPSHOT_SUFFIX);
}

function cleanupSnapshotTimestamp(cleanupPath: string): number | undefined {
  const match = CLEANUP_SNAPSHOT_TIMESTAMP_PATTERN.exec(path.basename(cleanupPath));
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function compareCleanupSnapshotsNewestFirst(leftPath: string, rightPath: string): number {
  const leftTimestamp = cleanupSnapshotTimestamp(leftPath);
  const rightTimestamp = cleanupSnapshotTimestamp(rightPath);
  if (leftTimestamp !== undefined && rightTimestamp !== undefined) {
    if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  } else if (leftTimestamp !== undefined) {
    return -1;
  } else if (rightTimestamp !== undefined) {
    return 1;
  }
  return path.basename(rightPath).localeCompare(path.basename(leftPath));
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function utf8PrefixByByteLength(
  content: string,
  byteLength: number,
): string | undefined {
  const buffer = Buffer.from(content, "utf8");
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > buffer.length) {
    return undefined;
  }
  const prefix = buffer.subarray(0, byteLength).toString("utf8");
  return Buffer.byteLength(prefix, "utf8") === byteLength ? prefix : undefined;
}

function parseProcessedMarker(raw: string): ProcessedFlushPlanMarker | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    (candidate.status !== undefined &&
      candidate.status !== "pending" &&
      candidate.status !== "processed") ||
    typeof candidate.processedHash !== "string" ||
    typeof candidate.processedBytes !== "number" ||
    !Number.isSafeInteger(candidate.processedBytes) ||
    typeof candidate.processedAt !== "string" ||
    typeof candidate.reason !== "string"
  ) {
    return undefined;
  }
  const processedChunks = parseProcessedMarkerChunks(candidate.processedChunks);
  if (candidate.processedChunks !== undefined && processedChunks === undefined) {
    return undefined;
  }

  return {
    version: 1,
    status: candidate.status === "pending" ? "pending" : "processed",
    processedHash: candidate.processedHash,
    processedBytes: candidate.processedBytes,
    processedContent:
      typeof candidate.processedContent === "string"
        ? candidate.processedContent
        : undefined,
    processedChunks,
    processedAt: candidate.processedAt,
    reason: candidate.reason,
  };
}

function parseProcessedMarkerChunks(
  rawChunks: unknown,
): ProcessedFlushPlanMarkerChunk[] | undefined {
  if (rawChunks === undefined) return undefined;
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) return undefined;

  const chunks: ProcessedFlushPlanMarkerChunk[] = [];
  for (const rawChunk of rawChunks) {
    if (!rawChunk || typeof rawChunk !== "object" || Array.isArray(rawChunk)) {
      return undefined;
    }
    const chunk = rawChunk as Record<string, unknown>;
    if (
      typeof chunk.rawBytes !== "number" ||
      !Number.isSafeInteger(chunk.rawBytes) ||
      chunk.rawBytes <= 0 ||
      typeof chunk.turnFingerprint !== "string" ||
      chunk.turnFingerprint.length === 0 ||
      typeof chunk.timestamp !== "string" ||
      typeof chunk.chunkIndex !== "number" ||
      !Number.isSafeInteger(chunk.chunkIndex) ||
      chunk.chunkIndex < 0 ||
      typeof chunk.chunkCount !== "number" ||
      !Number.isSafeInteger(chunk.chunkCount) ||
      chunk.chunkCount <= 0 ||
      typeof chunk.maxTurnChars !== "number" ||
      !Number.isSafeInteger(chunk.maxTurnChars) ||
      chunk.maxTurnChars <= 0
    ) {
      return undefined;
    }
    chunks.push({
      rawBytes: chunk.rawBytes,
      turnFingerprint: chunk.turnFingerprint,
      timestamp: chunk.timestamp,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      maxTurnChars: chunk.maxTurnChars,
    });
  }

  if (
    chunks.some(
      (chunk, index) =>
        chunk.chunkIndex !== index ||
        chunk.chunkCount !== chunks.length ||
        chunk.maxTurnChars !== chunks[0].maxTurnChars,
    )
  ) {
    return undefined;
  }

  return chunks;
}

async function readProcessedMarker(
  markerPath: string,
): Promise<ProcessedFlushPlanMarker | undefined> {
  try {
    const stat = await lstat(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    return parseProcessedMarker(await readFile(markerPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeProcessedMarker(params: {
  markerPath: string;
  marker: ProcessedFlushPlanMarker;
}): Promise<void> {
  await mkdir(path.dirname(params.markerPath), { recursive: true });
  const markerBody = `${JSON.stringify(params.marker, null, 2)}\n`;
  let lastCollision: unknown;

  for (let attempt = 0; attempt < MARKER_WRITE_TEMP_ATTEMPTS; attempt += 1) {
    const tempPath = path.join(
      path.dirname(params.markerPath),
      `.${path.basename(params.markerPath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(tempPath, markerBody, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      try {
        await rename(tempPath, params.markerPath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        lastCollision = error;
        continue;
      }
      throw error;
    }
  }

  throw lastCollision instanceof Error
    ? lastCollision
    : new Error("Unable to create exclusive flush-plan marker temp file");
}

async function removeProcessedMarker(markerPath: string): Promise<void> {
  try {
    await unlink(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
}

function isMeaningfulFlushPlanContent(content: string): boolean {
  return content
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("<!--");
    });
}

async function isSafeFlushPlanAppendTarget(flushPlanPath: string): Promise<boolean> {
  try {
    const stat = await lstat(flushPlanPath);
    return !stat.isSymbolicLink() && stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    throw error;
  }
}

export function reconcileOpenClawFlushPlanReplacementContent(params: {
  existingContent: string;
  preservedContent: string;
}): string | undefined {
  if (params.preservedContent.length === 0) return undefined;
  if (params.existingContent.startsWith(params.preservedContent)) return undefined;
  return `${params.preservedContent}${params.existingContent}`;
}

type ReconcileReplacementFileResult =
  | { ok: true; content: string }
  | { ok: false };

async function readSafeFlushPlanReplacementContent(
  flushPlanPath: string,
): Promise<ReconcileReplacementFileResult> {
  if (!(await isSafeFlushPlanAppendTarget(flushPlanPath))) return { ok: false };
  try {
    return { ok: true, content: await readFile(flushPlanPath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, content: "" };
    }
    throw error;
  }
}

async function reconcileOpenClawFlushPlanReplacementFile(params: {
  flushPlanPath: string;
  preservedContent: string;
}): Promise<ReconcileReplacementFileResult> {
  if (params.preservedContent.length === 0) {
    return readSafeFlushPlanReplacementContent(params.flushPlanPath);
  }

  const initial = await readSafeFlushPlanReplacementContent(params.flushPlanPath);
  if (!initial.ok) return initial;
  const initialReconciled = reconcileOpenClawFlushPlanReplacementContent({
    existingContent: initial.content,
    preservedContent: params.preservedContent,
  });
  if (initialReconciled === undefined) return initial;

  if (initial.content.length === 0) {
    try {
      await writeFile(params.flushPlanPath, initialReconciled, {
        encoding: "utf8",
        flag: "wx",
      });
      return { ok: true, content: initialReconciled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
  }

  // OpenClaw can recreate or append to this file while Remnic is cleaning up a
  // rotated snapshot. Re-read at the last possible point so the overwrite merges
  // fresh appends instead of writing from the stale snapshot above.
  const latest = await readSafeFlushPlanReplacementContent(params.flushPlanPath);
  if (!latest.ok) return latest;
  const latestReconciled = reconcileOpenClawFlushPlanReplacementContent({
    existingContent: latest.content,
    preservedContent: params.preservedContent,
  });
  if (latestReconciled === undefined) return latest;

  if (latest.content.length === 0) {
    try {
      await writeFile(params.flushPlanPath, latestReconciled, {
        encoding: "utf8",
        flag: "wx",
      });
      return { ok: true, content: latestReconciled };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    const created = await readSafeFlushPlanReplacementContent(params.flushPlanPath);
    if (!created.ok) return created;
    const createdReconciled = reconcileOpenClawFlushPlanReplacementContent({
      existingContent: created.content,
      preservedContent: params.preservedContent,
    });
    if (createdReconciled === undefined) return created;
    if (!(await isSafeFlushPlanAppendTarget(params.flushPlanPath))) return { ok: false };
    await writeFile(params.flushPlanPath, createdReconciled, "utf8");
    return { ok: true, content: createdReconciled };
  }

  if (!(await isSafeFlushPlanAppendTarget(params.flushPlanPath))) return { ok: false };
  await writeFile(params.flushPlanPath, latestReconciled, "utf8");
  return { ok: true, content: latestReconciled };
}

async function reconcileExistingFlushPlanReplacement(params: {
  flushPlanPath: string;
  preservedContent: string;
}): Promise<boolean> {
  const result = await reconcileOpenClawFlushPlanReplacementFile(params);
  return result.ok;
}

async function validateFlushPlanLocation(params: {
  workspaceDir: string;
  flushPlanPath: string;
}): Promise<OpenClawFlushPlanProcessResult | undefined> {
  const workspaceRoot = path.resolve(params.workspaceDir);
  const flushPlanDir = path.dirname(params.flushPlanPath);
  if (!isPathInsideOrEqual(workspaceRoot, flushPlanDir)) {
    return {
      status: "skipped",
      path: params.flushPlanPath,
      reason: "flush plan path is outside workspace",
    };
  }

  let workspaceRealPath = workspaceRoot;
  try {
    workspaceRealPath = await realpath(workspaceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  const relativeDir = path.relative(workspaceRoot, flushPlanDir);
  const parentSegments =
    relativeDir.length === 0 ? [] : relativeDir.split(path.sep).filter(Boolean);
  let currentPath = workspaceRoot;
  for (const segment of parentSegments) {
    currentPath = path.join(currentPath, segment);
    let stat;
    try {
      stat = await lstat(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      return {
        status: "skipped",
        path: params.flushPlanPath,
        reason: "flush plan parent path contains a symlink",
      };
    }
    if (!stat.isDirectory()) {
      return {
        status: "skipped",
        path: params.flushPlanPath,
        reason: "flush plan parent path is not a directory",
      };
    }
    const currentRealPath = await realpath(currentPath);
    if (!isPathInsideOrEqual(workspaceRealPath, currentRealPath)) {
      return {
        status: "skipped",
        path: params.flushPlanPath,
        reason: "flush plan parent path escapes workspace",
      };
    }
  }

  return undefined;
}

async function recoverInterruptedCleanupSnapshots(params: {
  flushPlanPath: string;
  logger?: OpenClawFlushPlanLogger;
  marker?: ProcessedFlushPlanMarker;
  markerPath?: string;
}): Promise<{ removedProcessedMarker: boolean }> {
  let removedProcessedMarker = false;
  let marker = params.marker;
  const flushPlanDir = path.dirname(params.flushPlanPath);
  let entries;
  try {
    entries = await readdir(flushPlanDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { removedProcessedMarker };
    }
    throw error;
  }

  const cleanupPaths = entries
    .filter((entry) => isCleanupSnapshotName(entry.name))
    .map((entry) => path.join(flushPlanDir, entry.name))
    .sort(compareCleanupSnapshotsNewestFirst);
  if (cleanupPaths.length === 0) return { removedProcessedMarker };

  if (!(await isSafeFlushPlanAppendTarget(params.flushPlanPath))) {
    params.logger?.warn(
      "OpenClaw flush-plan cleanup recovery skipped because flush-plan.md is not a regular file",
    );
    return { removedProcessedMarker };
  }

  let currentContent: string | undefined;
  try {
    currentContent = await readFile(params.flushPlanPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }

  for (const cleanupPath of cleanupPaths) {
    let stat;
    try {
      stat = await lstat(cleanupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      params.logger?.warn(
        `OpenClaw flush-plan cleanup recovery skipped unsafe snapshot ${path.basename(cleanupPath)}`,
      );
      continue;
    }

    const cleanupContent = await readFile(cleanupPath, "utf8");
    if (
      marker?.processedContent &&
      cleanupContent.startsWith(marker.processedContent)
    ) {
      const restoredTail = cleanupContent.slice(marker.processedContent.length);
      if (restoredTail.length > 0) {
        const reconciled = await reconcileOpenClawFlushPlanReplacementFile({
          flushPlanPath: params.flushPlanPath,
          preservedContent: restoredTail,
        });
        if (!reconciled.ok) {
          params.logger?.warn(
            "OpenClaw flush-plan cleanup recovery paused because flush-plan.md is no longer a regular file",
          );
          return { removedProcessedMarker };
        }
        currentContent = reconciled.content;
      }
      await unlink(cleanupPath);
      if (params.markerPath) {
        await removeProcessedMarker(params.markerPath);
        removedProcessedMarker = true;
        marker = undefined;
      }
      params.logger?.warn(
        `Recovered interrupted OpenClaw flush-plan cleanup snapshot ${path.basename(cleanupPath)}`,
      );
      continue;
    }
    if (cleanupContent.length > 0) {
      const reconciled = await reconcileOpenClawFlushPlanReplacementFile({
        flushPlanPath: params.flushPlanPath,
        preservedContent: cleanupContent,
      });
      if (!reconciled.ok) {
        params.logger?.warn(
          "OpenClaw flush-plan cleanup recovery paused because flush-plan.md is no longer a regular file",
        );
        return { removedProcessedMarker };
      }
      currentContent = reconciled.content;
    }
    await unlink(cleanupPath);
    params.logger?.warn(
      `Recovered interrupted OpenClaw flush-plan cleanup snapshot ${path.basename(cleanupPath)}`,
    );
  }
  return { removedProcessedMarker };
}

function normalizeMaxTurnChars(maxTurnChars: number | undefined): number {
  return typeof maxTurnChars === "number" &&
    Number.isFinite(maxTurnChars) &&
    maxTurnChars > 0
    ? Math.floor(maxTurnChars)
    : DEFAULT_MAX_IMPORT_TURN_CHARS;
}

function flushPlanImportPrefix(params: {
  chunkIndex: number;
  chunkCount: number;
  maxTurnChars: number;
}): string {
  const verbose =
    params.chunkCount > 1
      ? `${FLUSH_PLAN_IMPORT_INSTRUCTION} This is chunk ${params.chunkIndex + 1} of ${params.chunkCount}; extract it independently.\n\n`
      : `${FLUSH_PLAN_IMPORT_INSTRUCTION}\n\n`;
  if (verbose.length < params.maxTurnChars) return verbose;

  const compact =
    params.chunkCount > 1
      ? `OpenClaw flush-plan chunk ${params.chunkIndex + 1}/${params.chunkCount}.\n\n`
      : "OpenClaw flush-plan snapshot.\n\n";
  if (compact.length < params.maxTurnChars) return compact;
  return "";
}

function splitTextByMaxChars(content: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    let end = Math.min(offset + maxChars, content.length);
    if (end < content.length) {
      const newline = content.lastIndexOf("\n", end);
      if (newline > offset) {
        end = newline + 1;
      }
    }
    chunks.push(content.slice(offset, end));
    offset = end;
  }
  return chunks.filter((chunk) => chunk.trim().length > 0);
}

function splitFlushPlanContentIntoChunks(params: {
  content: string;
  maxTurnChars: number;
}): string[] {
  const trimmed = params.content.trim();
  if (trimmed.length === 0) return [];

  let chunkCount = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const maxPrefixChars = Math.max(
      ...Array.from({ length: chunkCount }, (_, chunkIndex) =>
        flushPlanImportPrefix({
          chunkIndex,
          chunkCount,
          maxTurnChars: params.maxTurnChars,
        }).length,
      ),
    );
    const maxChunkChars = Math.max(1, params.maxTurnChars - maxPrefixChars);
    const chunks = splitTextByMaxChars(trimmed, maxChunkChars);
    if (chunks.length === chunkCount) return chunks;
    chunkCount = Math.max(1, chunks.length);
  }

  const maxPrefixChars = flushPlanImportPrefix({
    chunkIndex: chunkCount - 1,
    chunkCount,
    maxTurnChars: params.maxTurnChars,
  }).length;
  return splitTextByMaxChars(trimmed, Math.max(1, params.maxTurnChars - maxPrefixChars));
}

function buildFlushPlanImportTurn(params: {
  content: string;
  flushPlanPath: string;
  fingerprintPath: string;
  serviceId: string;
  importedAt: string;
  turnTimestamp?: string;
  turnFingerprint?: string;
  reason: string;
  chunkIndex: number;
  chunkCount: number;
  maxTurnChars: number;
}): ImportTurn {
  const prefix = flushPlanImportPrefix({
    chunkIndex: params.chunkIndex,
    chunkCount: params.chunkCount,
    maxTurnChars: params.maxTurnChars,
  });
  return {
    role: "user",
    timestamp: params.turnTimestamp ?? params.importedAt,
    participantId: "openclaw-memory-flush-plan",
    participantName: "OpenClaw memory flush planner",
    content: `${prefix}${params.content.trim()}`,
    sourceFormat: "openclaw",
    sourceConnector: "openclaw",
    rawContent: params.content,
    importProvenance: {
      sourceLabel: "OpenClaw flush plan",
      sourceId:
        params.chunkCount > 1
          ? `${params.serviceId}:flush-plan:${params.chunkIndex + 1}/${params.chunkCount}`
          : `${params.serviceId}:flush-plan`,
      sourceTimestamp: params.importedAt,
      importedFromPath: params.flushPlanPath,
      importedAt: params.importedAt,
      metadata: {
        serviceId: params.serviceId,
        reason: params.reason,
        bytes: Buffer.byteLength(params.content, "utf8"),
        chunkIndex: params.chunkIndex,
        chunkCount: params.chunkCount,
        maxTurnChars: params.maxTurnChars,
      },
    },
    turnFingerprint:
      params.turnFingerprint ??
      hashContent(
        [
          "openclaw-flush-plan",
          params.serviceId,
          params.fingerprintPath,
          params.content,
        ].join("\n"),
      ),
    persistProcessedFingerprint: true,
  };
}

function timestampForFlushPlanChunk(importedAt: string, chunkIndex: number): string {
  const importedAtMs = Date.parse(importedAt);
  if (!Number.isFinite(importedAtMs)) return importedAt;
  return new Date(importedAtMs + chunkIndex).toISOString();
}

function isFailedIngestResult(
  result: void | OpenClawFlushPlanIngestResult,
): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      typeof result.failedCount === "number" &&
      result.failedCount > 0,
  );
}

function partialIngestResultFromError(
  error: unknown,
): OpenClawFlushPlanIngestResult | undefined {
  if (!error || typeof error !== "object") return undefined;
  const partialResult = (error as { partialResult?: unknown }).partialResult;
  if (!partialResult || typeof partialResult !== "object") return undefined;
  return partialResult as OpenClawFlushPlanIngestResult;
}

async function ingestFlushPlanImportTurns(params: {
  ingestor: OpenClawFlushPlanIngestor;
  importTurns: ImportTurn[];
  deadlineMs?: number;
}): Promise<void | OpenClawFlushPlanIngestResult> {
  const aggregate: Required<OpenClawFlushPlanIngestResult> = {
    attemptedTurnCount: 0,
    extractionCount: 0,
    persistedCount: 0,
    durableOutputCount: 0,
    skippedCount: 0,
    failedCount: 0,
    postPersistMetadataFailureCount: 0,
    processedTurnCount: 0,
  };
  const addResult = (result: void | OpenClawFlushPlanIngestResult): void => {
    if (!result) return;
    for (const key of Object.keys(aggregate) as Array<keyof typeof aggregate>) {
      const value = result[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        aggregate[key] += value;
      }
    }
  };

  for (const importTurn of params.importTurns) {
    try {
      const result = await params.ingestor.ingestBulkImportBatch([importTurn], {
        ...(params.deadlineMs === undefined
          ? {}
          : { deadlineMs: params.deadlineMs }),
        failOnExtractionFailure: true,
        includeSourceValidAtContext: false,
      });
      addResult(result);
      if (isFailedIngestResult(result)) return aggregate;
      if (!result || typeof result.processedTurnCount !== "number") {
        aggregate.processedTurnCount += 1;
      }
    } catch (error) {
      const partialResult = partialIngestResultFromError(error);
      addResult(partialResult);
      if (aggregate.processedTurnCount > 0) {
        aggregate.failedCount = Math.max(1, aggregate.failedCount);
        return aggregate;
      }
      throw error;
    }
  }
  return aggregate;
}

function hasPostPersistMetadataFailure(
  result: void | OpenClawFlushPlanIngestResult,
): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      typeof result.postPersistMetadataFailureCount === "number" &&
      result.postPersistMetadataFailureCount > 0,
  );
}

function processedPrefixFromPartialIngest(params: {
  content: string;
  importTurns: ImportTurn[];
  ingestResult: void | OpenClawFlushPlanIngestResult;
}): string | undefined {
  if (!isFailedIngestResult(params.ingestResult)) return undefined;
  const processedTurnCount =
    typeof params.ingestResult?.processedTurnCount === "number"
      ? Math.max(0, Math.floor(params.ingestResult.processedTurnCount))
      : 0;
  if (processedTurnCount <= 0) return undefined;
  const processedContent = params.importTurns
    .slice(0, Math.min(processedTurnCount, params.importTurns.length))
    .map((turn) =>
      typeof turn.rawContent === "string" ? turn.rawContent : turn.content,
    )
    .join("");
  if (processedContent.length === 0) return undefined;
  if (params.content.startsWith(processedContent)) return processedContent;

  const leadingWhitespaceLength =
    params.content.length - params.content.trimStart().length;
  if (leadingWhitespaceLength > 0) {
    const withLeadingWhitespace = params.content.slice(
      0,
      leadingWhitespaceLength + processedContent.length,
    );
    if (
      withLeadingWhitespace.slice(leadingWhitespaceLength) === processedContent
    ) {
      return withLeadingWhitespace;
    }
  }

  return undefined;
}

async function handleFlushPlanIngestResult(params: {
  ingestResult: void | OpenClawFlushPlanIngestResult;
  importTurns: ImportTurn[];
  content: string;
  flushPlanPath: string;
  markerPath: string;
  processedAt: string;
  reason: string;
  logger?: OpenClawFlushPlanLogger;
}): Promise<OpenClawFlushPlanProcessResult | undefined> {
  const partialProcessedPrefix = processedPrefixFromPartialIngest({
    content: params.content,
    importTurns: params.importTurns,
    ingestResult: params.ingestResult,
  });
  if (partialProcessedPrefix) {
    params.logger?.warn(
      "OpenClaw flush-plan partially imported; preserving unprocessed tail for retry",
    );
    if (hasPostPersistMetadataFailure(params.ingestResult)) {
      return await deferProcessedFlushPlanCleanupForMetadataFailure({
        flushPlanPath: params.flushPlanPath,
        markerPath: params.markerPath,
        content: partialProcessedPrefix,
        processedAt: params.processedAt,
        reason: params.reason,
        importTurns: params.importTurns,
      });
    }

    await writeProcessedMarker({
      markerPath: params.markerPath,
      marker: buildProcessedMarker({
        status: "processed",
        content: partialProcessedPrefix,
        processedAt: params.processedAt,
        reason: params.reason,
        importTurns: params.importTurns,
      }),
    });
    const result = await removeProcessedFlushPlanPrefix({
      flushPlanPath: params.flushPlanPath,
      processedPrefix: partialProcessedPrefix,
    });
    if (result.status === "processed_cleanup_deferred") {
      params.logger?.warn(
        `OpenClaw flush-plan processed but cleanup deferred: ${result.reason}`,
      );
    } else {
      await removeProcessedMarker(params.markerPath);
    }
    return result;
  }

  if (isFailedIngestResult(params.ingestResult)) {
    throw new Error("OpenClaw flush-plan import failed");
  }

  if (hasPostPersistMetadataFailure(params.ingestResult)) {
    return await deferProcessedFlushPlanCleanupForMetadataFailure({
      flushPlanPath: params.flushPlanPath,
      markerPath: params.markerPath,
      content: params.content,
      processedAt: params.processedAt,
      reason: params.reason,
      importTurns: params.importTurns,
    });
  }

  return undefined;
}

function buildProcessedMarker(params: {
  status: ProcessedFlushPlanMarker["status"];
  content: string;
  processedAt: string;
  reason: string;
  importTurns?: ImportTurn[];
}): ProcessedFlushPlanMarker {
  return {
    version: 1,
    status: params.status,
    processedHash: hashContent(params.content),
    processedBytes: Buffer.byteLength(params.content, "utf8"),
    processedContent: params.content,
    processedChunks: buildProcessedMarkerChunks({
      content: params.content,
      importTurns: params.importTurns,
    }),
    processedAt: params.processedAt,
    reason: params.reason,
  };
}

function buildProcessedMarkerChunks(params: {
  content: string;
  importTurns?: ImportTurn[];
}): ProcessedFlushPlanMarkerChunk[] | undefined {
  if (!params.importTurns || params.importTurns.length === 0) return undefined;

  const importedContent = params.content.trim();
  if (importedContent.length === 0) return undefined;
  const chunks: ProcessedFlushPlanMarkerChunk[] = [];
  let reconstructed = "";
  for (const [index, turn] of params.importTurns.entries()) {
    if (typeof turn.rawContent !== "string" || typeof turn.turnFingerprint !== "string") {
      return undefined;
    }
    const nextReconstructed = `${reconstructed}${turn.rawContent}`;
    if (!importedContent.startsWith(nextReconstructed)) return undefined;
    const metadata =
      turn.importProvenance?.metadata &&
      typeof turn.importProvenance.metadata === "object" &&
      !Array.isArray(turn.importProvenance.metadata)
        ? turn.importProvenance.metadata
        : undefined;
    const chunkIndex =
      typeof metadata?.chunkIndex === "number" && Number.isSafeInteger(metadata.chunkIndex)
        ? metadata.chunkIndex
        : index;
    const chunkCount =
      typeof metadata?.chunkCount === "number" && Number.isSafeInteger(metadata.chunkCount)
        ? metadata.chunkCount
        : params.importTurns.length;
    const maxTurnChars =
      typeof metadata?.maxTurnChars === "number" &&
      Number.isSafeInteger(metadata.maxTurnChars)
        ? metadata.maxTurnChars
        : DEFAULT_MAX_IMPORT_TURN_CHARS;
    chunks.push({
      rawBytes: Buffer.byteLength(turn.rawContent, "utf8"),
      turnFingerprint: turn.turnFingerprint,
      timestamp: turn.timestamp ?? "",
      chunkIndex,
      chunkCount,
      maxTurnChars,
    });
    reconstructed = nextReconstructed;
    if (reconstructed === importedContent) break;
  }

  if (reconstructed !== importedContent) return undefined;
  if (
    chunks.length === 0 ||
    chunks.some(
      (chunk, index) =>
        chunk.chunkIndex !== index ||
        chunk.chunkCount !== chunks.length ||
        chunk.maxTurnChars !== chunks[0].maxTurnChars ||
        chunk.timestamp.length === 0,
    )
  ) {
    return undefined;
  }

  return chunks;
}

async function deferProcessedFlushPlanCleanupForMetadataFailure(params: {
  flushPlanPath: string;
  markerPath: string;
  content: string;
  processedAt: string;
  reason: string;
  importTurns?: ImportTurn[];
}): Promise<OpenClawFlushPlanProcessResult> {
  await writeProcessedMarker({
    markerPath: params.markerPath,
    marker: buildProcessedMarker({
      status: "processed",
      content: params.content,
      processedAt: params.processedAt,
      reason: params.reason,
      importTurns: params.importTurns,
    }),
  });
  return {
    status: "processed_cleanup_deferred",
    path: params.flushPlanPath,
    bytesProcessed: Buffer.byteLength(params.content, "utf8"),
    reason: FLUSH_PLAN_METADATA_FAILURE_CLEANUP_DEFERRED_REASON,
  };
}

function buildFlushPlanImportTurns(params: {
  content: string;
  flushPlanPath: string;
  fingerprintPath: string;
  serviceId: string;
  importedAt: string;
  reason: string;
  maxTurnChars?: number;
}): ImportTurn[] {
  const maxTurnChars = normalizeMaxTurnChars(params.maxTurnChars);
  const chunks = splitFlushPlanContentIntoChunks({
    content: params.content,
    maxTurnChars,
  });
  return chunks.map((chunk, chunkIndex) =>
    buildFlushPlanImportTurn({
      content: chunk,
      flushPlanPath: params.flushPlanPath,
      fingerprintPath: params.fingerprintPath,
      serviceId: params.serviceId,
      importedAt: params.importedAt,
      turnTimestamp: timestampForFlushPlanChunk(params.importedAt, chunkIndex),
      reason: params.reason,
      chunkIndex,
      chunkCount: chunks.length,
      maxTurnChars,
    }),
  );
}

async function readFlushPlanSnapshot(
  flushPlanPath: string,
): Promise<{ status: "ok"; content: string } | OpenClawFlushPlanProcessResult> {
  let stat;
  try {
    stat = await lstat(flushPlanPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing", path: flushPlanPath };
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    return {
      status: "skipped",
      path: flushPlanPath,
      reason: "flush plan path is a symlink",
    };
  }
  if (!stat.isFile()) {
    return {
      status: "skipped",
      path: flushPlanPath,
      reason: "flush plan path is not a regular file",
    };
  }

  const content = await readFile(flushPlanPath, "utf8");
  if (!isMeaningfulFlushPlanContent(content)) {
    return { status: "empty", path: flushPlanPath };
  }
  return { status: "ok", content };
}

function findProcessedMarkerPrefix(params: {
  content: string;
  marker: ProcessedFlushPlanMarker;
}): string | undefined {
  const processedPrefix = utf8PrefixByByteLength(
    params.content,
    params.marker.processedBytes,
  );
  if (
    processedPrefix !== undefined &&
    hashContent(processedPrefix) === params.marker.processedHash
  ) {
    return processedPrefix;
  }

  if (
    params.marker.processedContent &&
    params.content.startsWith(params.marker.processedContent) &&
    hashContent(params.marker.processedContent) === params.marker.processedHash
  ) {
    return params.marker.processedContent;
  }

  return undefined;
}

function splitContentByMarkerChunks(params: {
  content: string;
  chunks: ProcessedFlushPlanMarkerChunk[];
}): string[] | undefined {
  const buffer = Buffer.from(params.content, "utf8");
  let offset = 0;
  const contentChunks: string[] = [];

  for (const chunk of params.chunks) {
    const nextOffset = offset + chunk.rawBytes;
    if (nextOffset > buffer.length) return undefined;
    const contentChunk = buffer.subarray(offset, nextOffset).toString("utf8");
    if (Buffer.byteLength(contentChunk, "utf8") !== chunk.rawBytes) {
      return undefined;
    }
    contentChunks.push(contentChunk);
    offset = nextOffset;
  }

  if (offset !== buffer.length) return undefined;
  return contentChunks;
}

function buildFlushPlanImportTurnsFromMarker(params: {
  content: string;
  marker: ProcessedFlushPlanMarker;
  flushPlanPath: string;
  fingerprintPath: string;
  serviceId: string;
}): ImportTurn[] | undefined {
  if (!params.marker.processedChunks) return undefined;
  const contentChunks = splitContentByMarkerChunks({
    content: params.content.trim(),
    chunks: params.marker.processedChunks,
  });
  if (!contentChunks) return undefined;
  return params.marker.processedChunks.map((chunk, index) =>
    buildFlushPlanImportTurn({
      content: contentChunks[index],
      flushPlanPath: params.flushPlanPath,
      fingerprintPath: params.fingerprintPath,
      serviceId: params.serviceId,
      importedAt: params.marker.processedAt,
      turnTimestamp: chunk.timestamp,
      turnFingerprint: chunk.turnFingerprint,
      reason: params.marker.reason,
      chunkIndex: chunk.chunkIndex,
      chunkCount: chunk.chunkCount,
      maxTurnChars: chunk.maxTurnChars,
    }),
  );
}

async function removeProcessedFlushPlanContent(params: {
  flushPlanPath: string;
  processedContent: string;
  recoveredFromMarker?: boolean;
  allowNonPrefixMatch?: boolean;
}): Promise<OpenClawFlushPlanProcessResult> {
  const processedBytes = Buffer.byteLength(params.processedContent, "utf8");
  let cleanupPath: string | undefined;
  try {
    const stat = await lstat(params.flushPlanPath);
    if (stat.isSymbolicLink()) {
      return {
        status: "processed_cleanup_deferred",
        path: params.flushPlanPath,
        bytesProcessed: processedBytes,
        reason: "flush plan path became a symlink before cleanup",
      };
    }
    if (!stat.isFile()) {
      return {
        status: "processed_cleanup_deferred",
        path: params.flushPlanPath,
        bytesProcessed: processedBytes,
        reason: "flush plan path stopped being a regular file before cleanup",
      };
    }
    cleanupPath = resolveCleanupSnapshotPath(params.flushPlanPath);
    await rename(params.flushPlanPath, cleanupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        status: "processed",
        path: params.flushPlanPath,
        bytesProcessed: processedBytes,
      };
    }
    throw error;
  }

  try {
    await writeFile(params.flushPlanPath, "", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw error;
    }
  }

  const current = await readFile(cleanupPath, "utf8");
  const processedStatus = params.recoveredFromMarker
    ? "processed_marker_recovered"
    : "processed";
  const preservedTailStatus = params.recoveredFromMarker
    ? "processed_marker_recovered_tail"
    : "processed_preserved_tail";
  const matchIndex =
    current === params.processedContent || current.startsWith(params.processedContent)
      ? 0
      : params.allowNonPrefixMatch
        ? current.indexOf(params.processedContent)
        : -1;

  if (matchIndex >= 0) {
    const preservedContent =
      current.slice(0, matchIndex) +
      current.slice(matchIndex + params.processedContent.length);
    if (preservedContent.length > 0) {
      const reconciled = await reconcileExistingFlushPlanReplacement({
        flushPlanPath: params.flushPlanPath,
        preservedContent,
      });
      if (!reconciled) {
        return {
          status: "processed_cleanup_deferred",
          path: params.flushPlanPath,
          bytesProcessed: processedBytes,
          reason: "flush plan path was recreated as an unsafe target during cleanup",
        };
      }
    }
    await unlink(cleanupPath);
    return {
      status: preservedContent.length > 0 ? preservedTailStatus : processedStatus,
      path: params.flushPlanPath,
      bytesProcessed: processedBytes,
      preservedBytes:
        preservedContent.length > 0
          ? Buffer.byteLength(preservedContent, "utf8")
          : undefined,
    };
  }

  const reconciled = await reconcileExistingFlushPlanReplacement({
    flushPlanPath: params.flushPlanPath,
    preservedContent: current,
  });
  if (!reconciled) {
    return {
      status: "processed_cleanup_deferred",
      path: params.flushPlanPath,
      bytesProcessed: processedBytes,
      reason: "flush plan path was recreated as an unsafe target during cleanup",
    };
  }
  await unlink(cleanupPath);
  return {
    status: "processed_cleanup_deferred",
    path: params.flushPlanPath,
    bytesProcessed: processedBytes,
    reason: FLUSH_PLAN_CHANGED_BEFORE_CLEANUP_REASON,
  };
}

async function removeProcessedFlushPlanPrefix(params: {
  flushPlanPath: string;
  processedPrefix: string;
  recoveredFromMarker?: boolean;
}): Promise<OpenClawFlushPlanProcessResult> {
  return removeProcessedFlushPlanContent({
    flushPlanPath: params.flushPlanPath,
    processedContent: params.processedPrefix,
    recoveredFromMarker: params.recoveredFromMarker,
    allowNonPrefixMatch: false,
  });
}

async function recoverProcessedFlushPlanPrefix(params: {
  flushPlanPath: string;
  markerPath: string;
  content: string;
  marker: ProcessedFlushPlanMarker;
}): Promise<OpenClawFlushPlanProcessResult | undefined> {
  const processedPrefix = findProcessedMarkerPrefix({
    content: params.content,
    marker: params.marker,
  });
  if (processedPrefix) {
    const result = await removeProcessedFlushPlanPrefix({
      flushPlanPath: params.flushPlanPath,
      processedPrefix,
      recoveredFromMarker: true,
    });
    if (result.status !== "processed_cleanup_deferred") {
      await removeProcessedMarker(params.markerPath);
    }
    return result;
  }

  await removeProcessedMarker(params.markerPath);
  return undefined;
}

async function recoverPendingFlushPlanImport(params: {
  flushPlanPath: string;
  fingerprintPath: string;
  markerPath: string;
  content: string;
  marker: ProcessedFlushPlanMarker;
  serviceId: string;
  ingestor: OpenClawFlushPlanIngestor;
  deadlineMs?: number;
  maxTurnChars?: number;
  logger?: OpenClawFlushPlanLogger;
}): Promise<OpenClawFlushPlanProcessResult | undefined> {
  const processedPrefix = findProcessedMarkerPrefix({
    content: params.content,
    marker: params.marker,
  });
  if (!processedPrefix) {
    await removeProcessedMarker(params.markerPath);
    return undefined;
  }

  const importTurns =
    buildFlushPlanImportTurnsFromMarker({
      content: processedPrefix,
      marker: params.marker,
      flushPlanPath: params.flushPlanPath,
      fingerprintPath: params.fingerprintPath,
      serviceId: params.serviceId,
    }) ??
    buildFlushPlanImportTurns({
      content: processedPrefix,
      flushPlanPath: params.flushPlanPath,
      fingerprintPath: params.fingerprintPath,
      serviceId: params.serviceId,
      importedAt: params.marker.processedAt,
      reason: params.marker.reason,
      maxTurnChars: params.maxTurnChars,
    });
  const ingestResult = await ingestFlushPlanImportTurns({
    ingestor: params.ingestor,
    importTurns,
    deadlineMs: params.deadlineMs,
  });
  const handledResult = await handleFlushPlanIngestResult({
    ingestResult,
    importTurns,
    content: processedPrefix,
    flushPlanPath: params.flushPlanPath,
    markerPath: params.markerPath,
    processedAt: params.marker.processedAt,
    reason: params.marker.reason,
    logger: params.logger,
  });
  if (handledResult) return handledResult;

  await writeProcessedMarker({
    markerPath: params.markerPath,
    marker: buildProcessedMarker({
      status: "processed",
      content: processedPrefix,
      processedAt: params.marker.processedAt,
      reason: params.marker.reason,
      importTurns,
    }),
  });
  const result = await removeProcessedFlushPlanPrefix({
    flushPlanPath: params.flushPlanPath,
    processedPrefix,
    recoveredFromMarker: true,
  });
  if (result.status === "processed_cleanup_deferred") {
    params.logger?.warn(
      `OpenClaw flush-plan processed but cleanup deferred: ${result.reason}`,
    );
  } else {
    await removeProcessedMarker(params.markerPath);
  }
  return result;
}

async function resolveFlushPlanFingerprintPath(params: {
  workspaceDir: string;
  flushPlanPath: string;
}): Promise<string> {
  const workspaceRoot = path.resolve(params.workspaceDir);
  const flushPlanPath = path.resolve(params.flushPlanPath);
  const relativeFlushPlanPath = path.relative(workspaceRoot, flushPlanPath);
  if (
    relativeFlushPlanPath.length > 0 &&
    !relativeFlushPlanPath.startsWith("..") &&
    !path.isAbsolute(relativeFlushPlanPath)
  ) {
    try {
      return path.resolve(await realpath(workspaceRoot), relativeFlushPlanPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }

  try {
    return await realpath(flushPlanPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return flushPlanPath;
  }
}

export async function processOpenClawFlushPlanFile(
  params: ProcessOpenClawFlushPlanFileParams,
): Promise<OpenClawFlushPlanProcessResult> {
  if (!params.enabled) return { status: "disabled" };

  const flushPlanPath = resolveOpenClawFlushPlanPath({
    workspaceDir: params.workspaceDir,
    serviceId: params.serviceId,
  });
  const unsafeLocation = await validateFlushPlanLocation({
    workspaceDir: params.workspaceDir,
    flushPlanPath,
  });
  if (unsafeLocation) return unsafeLocation;

  const markerPath = resolveProcessedMarkerPath(flushPlanPath);
  const processedMarker = await readProcessedMarker(markerPath);
  const cleanupRecovery = await recoverInterruptedCleanupSnapshots({
    flushPlanPath,
    logger: params.logger,
    marker: processedMarker,
    markerPath,
  });
  const activeProcessedMarker = cleanupRecovery.removedProcessedMarker
    ? undefined
    : processedMarker;
  const snapshot = await readFlushPlanSnapshot(flushPlanPath);
  if (snapshot.status !== "ok") {
    if (
      activeProcessedMarker &&
      (snapshot.status === "empty" || snapshot.status === "missing")
    ) {
      await removeProcessedMarker(markerPath);
    }
    return snapshot;
  }
  const fingerprintPath = await resolveFlushPlanFingerprintPath({
    workspaceDir: params.workspaceDir,
    flushPlanPath,
  });

  if (activeProcessedMarker) {
    const recovered =
      activeProcessedMarker.status === "pending"
        ? await recoverPendingFlushPlanImport({
            flushPlanPath,
            fingerprintPath,
            markerPath,
            content: snapshot.content,
            marker: activeProcessedMarker,
            serviceId: params.serviceId,
            ingestor: params.ingestor,
            deadlineMs: params.deadlineMs,
            maxTurnChars: params.maxTurnChars,
            logger: params.logger,
          })
        : await recoverProcessedFlushPlanPrefix({
            flushPlanPath,
            markerPath,
            content: snapshot.content,
            marker: activeProcessedMarker,
          });
    if (recovered) return recovered;
  }

  const importedAt = (params.now ?? (() => new Date()))().toISOString();
  const reason = params.reason ?? "openclaw-flush-plan";
  const importTurns = buildFlushPlanImportTurns({
    content: snapshot.content,
    flushPlanPath,
    fingerprintPath,
    serviceId: params.serviceId,
    importedAt,
    reason,
    maxTurnChars: params.maxTurnChars,
  });
  await mkdir(path.dirname(flushPlanPath), { recursive: true });
  await writeProcessedMarker({
    markerPath,
    marker: buildProcessedMarker({
      status: "pending",
      content: snapshot.content,
      processedAt: importedAt,
      reason,
      importTurns,
    }),
  });
  const ingestResult = await ingestFlushPlanImportTurns({
    ingestor: params.ingestor,
    importTurns,
    deadlineMs: params.deadlineMs,
  });
  const handledResult = await handleFlushPlanIngestResult({
    ingestResult,
    importTurns,
    content: snapshot.content,
    flushPlanPath,
    markerPath,
    processedAt: importedAt,
    reason,
    logger: params.logger,
  });
  if (handledResult) return handledResult;

  await writeProcessedMarker({
    markerPath,
    marker: buildProcessedMarker({
      status: "processed",
      content: snapshot.content,
      processedAt: importedAt,
      reason,
      importTurns,
    }),
  });
  const result = await removeProcessedFlushPlanPrefix({
    flushPlanPath,
    processedPrefix: snapshot.content,
  });
  if (result.status === "processed_cleanup_deferred") {
    params.logger?.warn(
      `OpenClaw flush-plan processed but cleanup deferred: ${result.reason}`,
    );
  } else {
    await removeProcessedMarker(markerPath);
  }
  return result;
}
