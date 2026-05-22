import path from "node:path";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { StorageManager } from "../storage.js";
import { decideLifecycleTransition } from "../lifecycle.js";
import type { MemoryFile, MemoryStatus } from "../types.js";

export type MemoryGovernanceMode = "shadow" | "apply";
export type MemoryGovernanceReasonCode =
  | "exact_duplicate"
  | "semantic_duplicate_candidate"
  | "disputed_memory"
  | "speculative_low_confidence"
  | "archive_candidate"
  | "explicit_capture_review"
  | "malformed_import";

export interface MemoryGovernanceReviewQueueEntry {
  entryId: string;
  memoryId: string;
  path: string;
  reasonCode: MemoryGovernanceReasonCode;
  severity: "low" | "medium" | "high";
  suggestedAction: "set_status" | "archive";
  suggestedStatus?: Extract<MemoryStatus, "pending_review" | "quarantined" | "rejected">;
  relatedMemoryIds: string[];
}

export interface MemoryGovernanceAppliedAction {
  action: "set_status" | "archive";
  memoryId: string;
  reasonCode: MemoryGovernanceReviewQueueEntry["reasonCode"];
  beforeStatus: MemoryStatus;
  afterStatus?: MemoryStatus;
  originalPath: string;
  currentPath: string;
}

interface MemoryGovernanceRestoreEntry {
  action: MemoryGovernanceAppliedAction["action"];
  memoryId: string;
  reasonCode: MemoryGovernanceReviewQueueEntry["reasonCode"];
  originalPath: string;
  currentPath: string;
  beforeRaw: string;
  expectedCurrentRaw?: string;
  applied: boolean;
}

export interface MemoryGovernanceRestoreManifest {
  runId: string;
  createdAt: string;
  entries: MemoryGovernanceRestoreEntry[];
}

export interface MemoryGovernanceSummary {
  schemaVersion: 1;
  runId: string;
  traceId: string;
  mode: MemoryGovernanceMode;
  createdAt: string;
  scannedMemories: number;
  reviewQueueCount: number;
  proposedActionCount: number;
  appliedActionCount: number;
  ruleVersion: string;
}

export interface MemoryGovernanceMetrics {
  reviewReasons: Record<MemoryGovernanceReasonCode, number>;
  proposedStatuses: Record<string, number>;
  keptMemoryCount: number;
  qualityScore: MemoryGovernanceQualityScore;
}

export interface MemoryGovernanceQualityScore {
  score: number;
  maxScore: 100;
  grade: "excellent" | "good" | "fair" | "poor";
  deductions: Array<{
    reasonCode: MemoryGovernanceReasonCode;
    count: number;
    pointsLost: number;
  }>;
}

export interface MemoryGovernanceTransitionReport {
  proposed: Record<string, MemoryGovernanceAppliedAction[]>;
  applied: Record<string, MemoryGovernanceAppliedAction[]>;
}

export interface MemoryGovernanceManifest {
  schemaVersion: 1;
  runId: string;
  traceId: string;
  mode: MemoryGovernanceMode;
  createdAt: string;
  ruleVersion: string;
  artifacts: Record<string, string>;
}

export interface MemoryGovernanceRunResult {
  runId: string;
  traceId: string;
  mode: MemoryGovernanceMode;
  summary: MemoryGovernanceSummary;
  summaryPath: string;
  reviewQueuePath: string;
  qualityScorePath: string;
  transitionReportPath: string;
  reportPath: string;
  keptMemoriesPath: string;
  appliedActionsPath: string;
  metricsPath: string;
  manifestPath: string;
  restorePath?: string;
  reviewQueue: MemoryGovernanceReviewQueueEntry[];
  proposedActions: MemoryGovernanceAppliedAction[];
  appliedActions: MemoryGovernanceAppliedAction[];
}

export interface RestoreMemoryGovernanceRunResult {
  runId: string;
  restoredActions: number;
  restorePath: string;
}

export interface RunMemoryGovernanceOptions {
  memoryDir: string;
  mode: MemoryGovernanceMode;
  now?: Date;
  maxMemories?: number;
  batchSize?: number;
  recentDays?: number;
}

export interface RestoreMemoryGovernanceRunOptions {
  memoryDir: string;
  runId: string;
  now?: Date;
}

export const RULE_VERSION = "memory-governance.v2";
const SEMANTIC_DUPLICATE_MIN_TOKENS = 6;
const SEMANTIC_DUPLICATE_MIN_JACCARD = 0.66;
const QUALITY_SCORE_WEIGHTS: Record<MemoryGovernanceReasonCode, number> = {
  exact_duplicate: 6,
  semantic_duplicate_candidate: 4,
  disputed_memory: 15,
  speculative_low_confidence: 8,
  archive_candidate: 2,
  explicit_capture_review: 5,
  malformed_import: 12,
};

function governanceRunsDir(memoryDir: string): string {
  return path.join(memoryDir, "state", "memory-governance", "runs");
}

function governanceRunDir(memoryDir: string, runId: string): string {
  return path.join(governanceRunsDir(memoryDir), runId);
}

function governanceRestorePath(memoryDir: string, runId: string): string {
  return path.join(governanceRunDir(memoryDir, runId), "restore.json");
}

function buildRunId(now: Date): string {
  return `gov-${now.toISOString().replace(/[:.]/g, "-")}`;
}

function plannedArchivePath(memoryDir: string, originalPath: string, now: Date): string {
  return path.join(
    memoryDir,
    "archive",
    now.toISOString().slice(0, 10),
    path.basename(originalPath),
  );
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

function statusOf(memory: MemoryFile): MemoryStatus {
  return memory.frontmatter.status ?? "active";
}

function parseIsoMs(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function daysSince(value: string | undefined, now: Date): number {
  const ts = parseIsoMs(value);
  if (ts === null) return 365;
  return Math.max(0, (now.getTime() - ts) / 86_400_000);
}

function compareCanonicalPreference(left: MemoryFile, right: MemoryFile): number {
  if (left.frontmatter.confidence !== right.frontmatter.confidence) {
    return (right.frontmatter.confidence ?? 0) - (left.frontmatter.confidence ?? 0);
  }
  return left.frontmatter.created.localeCompare(right.frontmatter.created);
}

function proposedStatusPriority(status: MemoryStatus): number {
  switch (status) {
    case "quarantined":
      return 4;
    case "rejected":
      return 3;
    case "archived":
      return 2;
    case "pending_review":
      return 1;
    default:
      return 0;
  }
}

function proposedActionPriority(action: MemoryGovernanceAppliedAction): number {
  if (action.action === "archive") {
    return proposedStatusPriority("archived");
  }
  return proposedStatusPriority(action.afterStatus ?? "active");
}

function tokenizeSemanticContent(content: string): string[] {
  return Array.from(
    new Set(
      normalizeContent(content)
        .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter((token) => token.length >= 4),
    ),
  );
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

function sameSemanticDuplicateScope(left: MemoryFile, right: MemoryFile): boolean {
  if (left.frontmatter.category !== right.frontmatter.category) return false;
  const leftEntityRef = left.frontmatter.entityRef?.trim();
  const rightEntityRef = right.frontmatter.entityRef?.trim();
  if (leftEntityRef && rightEntityRef && leftEntityRef !== rightEntityRef) return false;
  return true;
}

function buildSemanticDuplicateEntries(activeMemories: MemoryFile[]): MemoryGovernanceReviewQueueEntry[] {
  const reviewQueue: MemoryGovernanceReviewQueueEntry[] = [];
  const ordered = [...activeMemories].sort(compareCanonicalPreference);
  const tokensByMemoryId = new Map(
    ordered.map((memory) => [memory.frontmatter.id, tokenizeSemanticContent(memory.content)] as const),
  );
  const claimed = new Set<string>();

  for (let candidateIndex = 1; candidateIndex < ordered.length; candidateIndex += 1) {
    const candidate = ordered[candidateIndex];
    if (claimed.has(candidate.frontmatter.id)) continue;
    const candidateTokens = tokensByMemoryId.get(candidate.frontmatter.id) ?? [];
    if (candidateTokens.length < SEMANTIC_DUPLICATE_MIN_TOKENS) continue;
    const candidateNormalized = normalizeContent(candidate.content);

    for (let canonicalIndex = 0; canonicalIndex < candidateIndex; canonicalIndex += 1) {
      const canonical = ordered[canonicalIndex];
      if (!sameSemanticDuplicateScope(canonical, candidate)) continue;
      const canonicalNormalized = normalizeContent(canonical.content);
      if (canonicalNormalized === candidateNormalized) continue;
      const canonicalTokens = tokensByMemoryId.get(canonical.frontmatter.id) ?? [];
      if (canonicalTokens.length < SEMANTIC_DUPLICATE_MIN_TOKENS) continue;

      const shorter = Math.min(candidateTokens.length, canonicalTokens.length);
      const longer = Math.max(candidateTokens.length, canonicalTokens.length);
      if (shorter / longer < 0.6) continue;
      if (jaccardSimilarity(candidateTokens, canonicalTokens) < SEMANTIC_DUPLICATE_MIN_JACCARD) continue;

      reviewQueue.push({
        entryId: `review:${candidate.frontmatter.id}:semantic_duplicate_candidate`,
        memoryId: candidate.frontmatter.id,
        path: candidate.path,
        reasonCode: "semantic_duplicate_candidate",
        severity: "medium",
        suggestedAction: "set_status",
        suggestedStatus: "pending_review",
        relatedMemoryIds: [canonical.frontmatter.id],
      });
      claimed.add(candidate.frontmatter.id);
      break;
    }
  }

  return reviewQueue;
}

function buildExplicitCaptureReviewEntries(
  memories: MemoryFile[],
  lifecycleEvents: Array<{
    memoryId: string;
    eventType: string;
    reasonCode?: string;
  }>,
): MemoryGovernanceReviewQueueEntry[] {
  const explicitQueuedIds = new Set(
    lifecycleEvents
      .filter((event) => event.eventType === "explicit_capture_queued")
      .map((event) => event.memoryId),
  );

  return memories
    .filter((memory) => {
      if (statusOf(memory) !== "pending_review") return false;
      const tags = memory.frontmatter.tags ?? [];
      if (tags.includes("queued-review")) return true;
      if (explicitQueuedIds.has(memory.frontmatter.id)) return true;
      return memory.frontmatter.source === "explicit-review" || memory.frontmatter.source === "explicit-inline-review";
    })
    .map((memory) => ({
      entryId: `review:${memory.frontmatter.id}:explicit_capture_review`,
      memoryId: memory.frontmatter.id,
      path: memory.path,
      reasonCode: "explicit_capture_review" as const,
      severity: "medium" as const,
      suggestedAction: "set_status" as const,
      suggestedStatus: "pending_review" as const,
      relatedMemoryIds: [],
    }));
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(fullPath);
        }
      }
    } catch {
      // Directory may not exist yet.
    }
  };

  await walk(root);
  return files;
}

function malformedMemoryId(memoryDir: string, filePath: string): string {
  return `malformed:${path.relative(memoryDir, filePath).replaceAll(path.sep, "/")}`;
}

async function buildMalformedImportEntries(
  memoryDir: string,
  storage: StorageManager,
  parsedMemories: MemoryFile[],
  candidateFiles?: string[],
): Promise<MemoryGovernanceReviewQueueEntry[]> {
  const parsedPaths = new Set(parsedMemories.map((memory) => memory.path));
  const filesToInspect = candidateFiles ?? [
    ...await listMarkdownFiles(path.join(memoryDir, "facts")),
    ...await listMarkdownFiles(path.join(memoryDir, "corrections")),
  ];
  const entries: MemoryGovernanceReviewQueueEntry[] = [];

  for (const filePath of filesToInspect) {
    if (parsedPaths.has(filePath)) continue;
    const parsed = await storage.readMemoryByPath(filePath);
    if (parsed) continue;
    entries.push({
      entryId: `review:${malformedMemoryId(memoryDir, filePath)}:malformed_import`,
      memoryId: malformedMemoryId(memoryDir, filePath),
      path: filePath,
      reasonCode: "malformed_import",
      severity: "high",
      suggestedAction: "set_status",
      suggestedStatus: "quarantined",
      relatedMemoryIds: [],
    });
  }

  return entries;
}

async function buildReviewQueue(
  memoryDir: string,
  storage: StorageManager,
  memories: MemoryFile[],
  now: Date,
  options: {
    malformedCandidateFiles?: string[];
  } = {},
): Promise<MemoryGovernanceReviewQueueEntry[]> {
  const reviewQueue: MemoryGovernanceReviewQueueEntry[] = [];
  const activeMemories = memories.filter((memory) => statusOf(memory) === "active");
  const duplicateBuckets = new Map<string, MemoryFile[]>();

  for (const memory of activeMemories) {
    const key = `${memory.frontmatter.category}:${normalizeContent(memory.content)}`;
    const bucket = duplicateBuckets.get(key) ?? [];
    bucket.push(memory);
    duplicateBuckets.set(key, bucket);
  }

  for (const bucket of duplicateBuckets.values()) {
    if (bucket.length < 2) continue;
    const ordered = [...bucket].sort(compareCanonicalPreference);
    const canonical = ordered[0];
    for (const duplicate of ordered.slice(1)) {
      reviewQueue.push({
        entryId: `review:${duplicate.frontmatter.id}:exact_duplicate`,
        memoryId: duplicate.frontmatter.id,
        path: duplicate.path,
        reasonCode: "exact_duplicate",
        severity: "medium",
        suggestedAction: "set_status",
        suggestedStatus: "pending_review",
        relatedMemoryIds: canonical ? [canonical.frontmatter.id] : [],
      });
    }
  }

  reviewQueue.push(...buildSemanticDuplicateEntries(activeMemories));

  for (const memory of activeMemories) {
    if (memory.frontmatter.verificationState === "disputed") {
      reviewQueue.push({
        entryId: `review:${memory.frontmatter.id}:disputed_memory`,
        memoryId: memory.frontmatter.id,
        path: memory.path,
        reasonCode: "disputed_memory",
        severity: "high",
        suggestedAction: "set_status",
        suggestedStatus: "quarantined",
        relatedMemoryIds: [],
      });
    }

    if (
      memory.frontmatter.confidenceTier === "speculative"
      && (memory.frontmatter.confidence ?? 0) <= 0.25
    ) {
      reviewQueue.push({
        entryId: `review:${memory.frontmatter.id}:speculative_low_confidence`,
        memoryId: memory.frontmatter.id,
        path: memory.path,
        reasonCode: "speculative_low_confidence",
        severity: "medium",
        suggestedAction: "set_status",
        suggestedStatus: "pending_review",
        relatedMemoryIds: [],
      });
    }

    const lifecycle = decideLifecycleTransition(memory, {}, now);
    const staleForArchive = memory.frontmatter.lifecycleState === "stale"
      && daysSince(memory.frontmatter.updated ?? memory.frontmatter.created, now) >= 180;
    if ((lifecycle.nextState === "archived" && lifecycle.changed) || staleForArchive) {
      reviewQueue.push({
        entryId: `review:${memory.frontmatter.id}:archive_candidate`,
        memoryId: memory.frontmatter.id,
        path: memory.path,
        reasonCode: "archive_candidate",
        severity: "low",
        suggestedAction: "archive",
        relatedMemoryIds: [],
      });
    }
  }

  const lifecycleEvents = await storage.readMemoryLifecycleEvents(Number.MAX_SAFE_INTEGER);
  reviewQueue.push(...buildExplicitCaptureReviewEntries(memories, lifecycleEvents));
  reviewQueue.push(...await buildMalformedImportEntries(
    memoryDir,
    storage,
    memories,
    options.malformedCandidateFiles,
  ));

  return reviewQueue;
}

export function buildProposedActions(
  reviewQueue: MemoryGovernanceReviewQueueEntry[],
  memories: MemoryFile[],
): MemoryGovernanceAppliedAction[] {
  const byMemory = new Map(memories.map((memory) => [memory.frontmatter.id, memory]));
  const selected = new Map<string, MemoryGovernanceAppliedAction>();

  for (const entry of reviewQueue) {
    const memory = byMemory.get(entry.memoryId);
    if (!memory) continue;
    const currentStatus = statusOf(memory);
    if (
      entry.suggestedAction === "set_status"
      && entry.suggestedStatus
      && entry.suggestedStatus === currentStatus
    ) {
      continue;
    }
    const candidate: MemoryGovernanceAppliedAction = {
      action: entry.suggestedAction,
      memoryId: entry.memoryId,
      reasonCode: entry.reasonCode,
      beforeStatus: currentStatus,
      afterStatus: entry.suggestedStatus,
      originalPath: memory.path,
      currentPath: memory.path,
    };

    const existing = selected.get(entry.memoryId);
    if (!existing) {
      selected.set(entry.memoryId, candidate);
      continue;
    }

    const existingPriority = proposedActionPriority(existing);
    const candidatePriority = proposedActionPriority(candidate);
    if (candidatePriority > existingPriority) {
      selected.set(entry.memoryId, candidate);
    }
  }

  return [...selected.values()];
}

function buildMetrics(
  reviewQueue: MemoryGovernanceReviewQueueEntry[],
  proposedActions: MemoryGovernanceAppliedAction[],
  scannedMemories: number,
): MemoryGovernanceMetrics {
  const reviewReasons: MemoryGovernanceMetrics["reviewReasons"] = {
    exact_duplicate: 0,
    semantic_duplicate_candidate: 0,
    disputed_memory: 0,
    speculative_low_confidence: 0,
    archive_candidate: 0,
    explicit_capture_review: 0,
    malformed_import: 0,
  };
  const proposedStatuses: Record<string, number> = {};

  for (const entry of reviewQueue) {
    reviewReasons[entry.reasonCode] += 1;
  }

  for (const action of proposedActions) {
    const effectiveStatus = action.afterStatus ?? (action.action === "archive" ? "archived" : undefined);
    if (!effectiveStatus) continue;
    proposedStatuses[effectiveStatus] = (proposedStatuses[effectiveStatus] ?? 0) + 1;
  }

  return {
    reviewReasons,
    proposedStatuses,
    keptMemoryCount: Math.max(0, scannedMemories - proposedActions.length),
    qualityScore: buildQualityScore(reviewReasons),
  };
}

export function buildQualityScore(
  reviewReasons: Record<MemoryGovernanceReasonCode, number>,
): MemoryGovernanceQualityScore {
  const deductions = Object.entries(reviewReasons)
    .map(([reasonCode, count]) => ({
      reasonCode: reasonCode as MemoryGovernanceReasonCode,
      count,
      pointsLost: count * QUALITY_SCORE_WEIGHTS[reasonCode as MemoryGovernanceReasonCode],
    }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.pointsLost - left.pointsLost);
  const totalPointsLost = deductions.reduce((sum, entry) => sum + entry.pointsLost, 0);
  const score = Math.max(0, 100 - totalPointsLost);
  const grade = score >= 90 ? "excellent"
    : score >= 75 ? "good"
      : score >= 50 ? "fair"
        : "poor";
  return {
    score,
    maxScore: 100,
    grade,
    deductions,
  };
}

export function groupActionsByStatus(
  actions: MemoryGovernanceAppliedAction[],
): Record<string, MemoryGovernanceAppliedAction[]> {
  const grouped: Record<string, MemoryGovernanceAppliedAction[]> = {};
  for (const action of actions) {
    const status = action.afterStatus ?? (action.action === "archive" ? "archived" : "unchanged");
    const bucket = grouped[status] ?? [];
    bucket.push(action);
    grouped[status] = bucket;
  }
  return grouped;
}

async function safeRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function persistRestoreManifest(
  memoryDir: string,
  manifest: MemoryGovernanceRestoreManifest,
): Promise<string> {
  const restorePath = governanceRestorePath(memoryDir, manifest.runId);
  await mkdir(path.dirname(restorePath), { recursive: true });
  await writeFile(restorePath, JSON.stringify(manifest, null, 2), "utf-8");
  return restorePath;
}

async function writeGovernanceArtifacts(options: {
  memoryDir: string;
  runId: string;
  traceId: string;
  summary: MemoryGovernanceSummary;
  metrics: MemoryGovernanceMetrics;
  qualityScore: MemoryGovernanceQualityScore;
  transitionReport: MemoryGovernanceTransitionReport;
  keptMemoryIds: string[];
  reviewQueue: MemoryGovernanceReviewQueueEntry[];
  proposedActions: MemoryGovernanceAppliedAction[];
  appliedActions: MemoryGovernanceAppliedAction[];
  restoreManifest?: MemoryGovernanceRestoreManifest;
}): Promise<
  Pick<
    MemoryGovernanceRunResult,
    | "summaryPath"
    | "reviewQueuePath"
    | "qualityScorePath"
    | "transitionReportPath"
    | "reportPath"
    | "keptMemoriesPath"
    | "appliedActionsPath"
    | "metricsPath"
    | "manifestPath"
    | "restorePath"
  >
> {
  const runDir = governanceRunDir(options.memoryDir, options.runId);
  await mkdir(runDir, { recursive: true });

  const summaryPath = path.join(runDir, "summary.json");
  const reviewQueuePath = path.join(runDir, "review-queue.json");
  const qualityScorePath = path.join(runDir, "quality-score.json");
  const transitionReportPath = path.join(runDir, "status-transitions.json");
  const reportPath = path.join(runDir, "report.md");
  const keptMemoriesPath = path.join(runDir, "kept-memories.json");
  const appliedActionsPath = path.join(runDir, "applied-actions.json");
  const metricsPath = path.join(runDir, "metrics.json");
  const manifestPath = path.join(runDir, "manifest.json");
  const restorePath = options.restoreManifest ? governanceRestorePath(options.memoryDir, options.runId) : undefined;

  await writeFile(summaryPath, JSON.stringify(options.summary, null, 2), "utf-8");
  await writeFile(reviewQueuePath, JSON.stringify(options.reviewQueue, null, 2), "utf-8");
  await writeFile(qualityScorePath, JSON.stringify(options.qualityScore, null, 2), "utf-8");
  await writeFile(transitionReportPath, JSON.stringify(options.transitionReport, null, 2), "utf-8");
  await writeFile(keptMemoriesPath, JSON.stringify(options.keptMemoryIds, null, 2), "utf-8");
  await writeFile(appliedActionsPath, JSON.stringify(options.appliedActions, null, 2), "utf-8");
  await writeFile(metricsPath, JSON.stringify(options.metrics, null, 2), "utf-8");
  await writeFile(
    reportPath,
    [
      `# Memory Governance Run ${options.runId}`,
      "",
      `- Trace ID: ${options.traceId}`,
      `- Mode: ${options.summary.mode}`,
      `- Scanned memories: ${options.summary.scannedMemories}`,
      `- Kept memories: ${options.metrics.keptMemoryCount}`,
      `- Review queue entries: ${options.summary.reviewQueueCount}`,
      `- Proposed actions: ${options.summary.proposedActionCount}`,
      `- Applied actions: ${options.summary.appliedActionCount}`,
      `- Quality score: ${options.qualityScore.score}/${options.qualityScore.maxScore} (${options.qualityScore.grade})`,
      "",
      "## Metrics",
      ...Object.entries(options.metrics.reviewReasons).map(([reason, count]) => `- ${reason}: ${count}`),
      ...(Object.entries(options.metrics.proposedStatuses).length > 0
        ? Object.entries(options.metrics.proposedStatuses).map(([status, count]) => `- proposed ${status}: ${count}`)
        : ["- proposed statuses: (none)"]),
      "",
      "## Quality Score",
      ...(options.qualityScore.deductions.length > 0
        ? options.qualityScore.deductions.map((entry) => `- ${entry.reasonCode}: ${entry.count} -> -${entry.pointsLost}`)
        : ["- no deductions"]),
      "",
      "## Proposed Actions",
      ...(options.proposedActions.length > 0
        ? options.proposedActions.map((action) =>
            `- ${action.memoryId}: ${action.action}${action.afterStatus ? ` -> ${action.afterStatus}` : ""} [${action.reasonCode}]`,
          )
        : ["- (empty)"]),
      "",
      "## Applied Actions",
      ...(options.appliedActions.length > 0
        ? options.appliedActions.map((action) =>
            `- ${action.memoryId}: ${action.action}${action.afterStatus ? ` -> ${action.afterStatus}` : ""} [${action.reasonCode}]`,
          )
        : ["- (empty)"]),
      "",
      "## Review Queue",
      ...(options.reviewQueue.length > 0
        ? options.reviewQueue.map((entry) =>
            `- ${entry.memoryId}: ${entry.reasonCode} -> ${entry.suggestedAction}${entry.suggestedStatus ? ` (${entry.suggestedStatus})` : ""}`,
          )
        : ["- (empty)"]),
    ].join("\n"),
    "utf-8",
  );
  const manifest: MemoryGovernanceManifest = {
    schemaVersion: 1,
    runId: options.runId,
    traceId: options.traceId,
    mode: options.summary.mode,
    createdAt: options.summary.createdAt,
    ruleVersion: options.summary.ruleVersion,
    artifacts: {
      summary: summaryPath,
      reviewQueue: reviewQueuePath,
      qualityScore: qualityScorePath,
      transitionReport: transitionReportPath,
      report: reportPath,
      keptMemories: keptMemoriesPath,
      appliedActions: appliedActionsPath,
      metrics: metricsPath,
      ...(restorePath ? { restore: restorePath } : {}),
    },
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  if (restorePath && options.restoreManifest && await safeRead(restorePath) === null) {
    await writeFile(restorePath, JSON.stringify(options.restoreManifest, null, 2), "utf-8");
  }

  return {
    summaryPath,
    reviewQueuePath,
    qualityScorePath,
    transitionReportPath,
    reportPath,
    keptMemoriesPath,
    appliedActionsPath,
    metricsPath,
    manifestPath,
    restorePath,
  };
}

export async function runMemoryGovernance(
  options: RunMemoryGovernanceOptions,
): Promise<MemoryGovernanceRunResult> {
  const now = options.now ?? new Date();
  const runId = buildRunId(now);
  const traceId = runId;
  const storage = new StorageManager(options.memoryDir);
  const boundedScan =
    options.maxMemories !== undefined ||
    options.recentDays !== undefined ||
    options.batchSize !== undefined;
  const normalizedRecentDays = typeof options.recentDays === "number" && Number.isFinite(options.recentDays)
    ? Math.max(1, Math.floor(options.recentDays))
    : undefined;
  const updatedAfter = normalizedRecentDays !== undefined
    ? new Date(now.getTime() - normalizedRecentDays * 86_400_000)
    : undefined;
  const memoryWindow = boundedScan
    ? await storage.readMemoriesWindow({
        maxMemories: options.maxMemories,
        batchSize: options.batchSize,
        updatedAfter,
      })
    : undefined;
  const memories = memoryWindow?.memories ?? await storage.readAllMemories();
  const reviewQueue = await buildReviewQueue(options.memoryDir, storage, memories, now, {
    malformedCandidateFiles: memoryWindow?.filePaths,
  });
  const proposedActions = buildProposedActions(reviewQueue, memories);
  const reviewEntryByActionKey = new Map(
    reviewQueue.map((entry) => [`${entry.memoryId}:${entry.reasonCode}`, entry] as const),
  );
  const metrics = buildMetrics(reviewQueue, proposedActions, memories.length);
  const transitionReport: MemoryGovernanceTransitionReport = {
    proposed: groupActionsByStatus(proposedActions),
    applied: {},
  };
  const memoryPathById = new Map(memories.map((memory) => [memory.frontmatter.id, memory.path] as const));
  const targetedMemoryIds = new Set(proposedActions.map((action) => action.memoryId));
  const keptMemoryIds = memories
    .map((memory) => memory.frontmatter.id)
    .filter((memoryId) => !targetedMemoryIds.has(memoryId));
  const appliedActions: MemoryGovernanceAppliedAction[] = [];
  const restoreEntries: MemoryGovernanceRestoreEntry[] = [];
  const restoreEntryByMemoryId = new Map<string, MemoryGovernanceRestoreEntry>();

  if (options.mode === "apply") {
    for (const action of proposedActions) {
      const memoryPath = memoryPathById.get(action.memoryId) ?? null;
      if (!memoryPath) continue;
      const memory = await storage.readMemoryByPath(memoryPath);
      if (!memory) continue;
      if (memory.frontmatter.id !== action.memoryId) continue;
      const beforeRaw = await safeRead(memory.path);
      if (!beforeRaw) continue;
      const entry: MemoryGovernanceRestoreEntry = {
        action: action.action,
        memoryId: action.memoryId,
        reasonCode: action.reasonCode,
        originalPath: memory.path,
        currentPath: action.action === "archive"
          ? plannedArchivePath(options.memoryDir, memory.path, now)
          : memory.path,
        beforeRaw,
        applied: false,
      };
      restoreEntries.push(entry);
      restoreEntryByMemoryId.set(action.memoryId, entry);
    }

    const restoreManifest: MemoryGovernanceRestoreManifest = {
      runId,
      createdAt: now.toISOString(),
      entries: restoreEntries,
    };
    await persistRestoreManifest(options.memoryDir, restoreManifest);

    for (const action of proposedActions) {
      const memoryPath = memoryPathById.get(action.memoryId) ?? null;
      if (!memoryPath) continue;
      const memory = await storage.readMemoryByPath(memoryPath);
      if (!memory) continue;
      if (memory.frontmatter.id !== action.memoryId) continue;
      const restoreEntry = restoreEntryByMemoryId.get(action.memoryId);
      if (!restoreEntry) continue;

      if (action.action === "archive") {
        const reviewEntry = reviewEntryByActionKey.get(`${action.memoryId}:${action.reasonCode}`);
        const archivedPath = await storage.archiveMemory(memory, {
          at: now,
          actor: "memory-governance.apply",
          reasonCode: action.reasonCode,
          ruleVersion: RULE_VERSION,
          relatedMemoryIds: reviewEntry?.relatedMemoryIds ?? [],
          correlationId: traceId,
        });
        if (!archivedPath) {
          continue;
        }
        restoreEntry.applied = true;
        restoreEntry.currentPath = archivedPath;
        restoreEntry.expectedCurrentRaw = await safeRead(archivedPath) ?? undefined;
        await persistRestoreManifest(options.memoryDir, restoreManifest);
        appliedActions.push({
          ...action,
          currentPath: archivedPath,
          afterStatus: "archived",
        });
        continue;
      }

      if (!action.afterStatus || action.beforeStatus === action.afterStatus) continue;
      const reviewEntry = reviewEntryByActionKey.get(`${action.memoryId}:${action.reasonCode}`);
      const updated = await storage.writeMemoryFrontmatter(memory, {
        status: action.afterStatus,
        updated: now.toISOString(),
      }, {
        actor: "memory-governance.apply",
        reasonCode: action.reasonCode,
        ruleVersion: RULE_VERSION,
        relatedMemoryIds: reviewEntry?.relatedMemoryIds ?? [],
        correlationId: traceId,
      });
      if (!updated) {
        continue;
      }
      restoreEntry.applied = true;
      restoreEntry.expectedCurrentRaw = await safeRead(memory.path) ?? undefined;
      await persistRestoreManifest(options.memoryDir, restoreManifest);
      appliedActions.push({
        ...action,
        currentPath: memory.path,
      });
    }
  }

  const summary: MemoryGovernanceSummary = {
    schemaVersion: 1,
    runId,
    traceId,
    mode: options.mode,
    createdAt: now.toISOString(),
    scannedMemories: memories.length,
    reviewQueueCount: reviewQueue.length,
    proposedActionCount: proposedActions.length,
    appliedActionCount: appliedActions.length,
    ruleVersion: RULE_VERSION,
  };
  const restoreManifest = options.mode === "apply"
    ? {
        runId,
        createdAt: now.toISOString(),
        entries: restoreEntries,
      }
    : undefined;
  transitionReport.applied = groupActionsByStatus(appliedActions);
  const paths = await writeGovernanceArtifacts({
    memoryDir: options.memoryDir,
    runId,
    traceId,
    summary,
    metrics,
    qualityScore: metrics.qualityScore,
    transitionReport,
    keptMemoryIds,
    reviewQueue,
    proposedActions,
    appliedActions,
    restoreManifest,
  });

  return {
    runId,
    traceId,
    mode: options.mode,
    summary,
    ...paths,
    reviewQueue,
    proposedActions,
    appliedActions,
  };
}

export async function restoreMemoryGovernanceRun(
  options: RestoreMemoryGovernanceRunOptions,
): Promise<RestoreMemoryGovernanceRunResult> {
  void options.now;
  const restorePath = governanceRestorePath(options.memoryDir, options.runId);
  const raw = JSON.parse(await readFile(restorePath, "utf-8")) as MemoryGovernanceRestoreManifest;
  let restoredActions = 0;

  for (const entry of [...raw.entries].reverse()) {
    if (!entry.applied) {
      continue;
    }
    const currentRaw = await safeRead(entry.currentPath);
    if (entry.expectedCurrentRaw && currentRaw !== entry.expectedCurrentRaw) {
      throw new Error(`restore conflict for ${entry.memoryId}: current contents diverged from governance run`);
    }
    if (entry.action === "archive") {
      await rm(entry.currentPath, { force: true });
    }
    await mkdir(path.dirname(entry.originalPath), { recursive: true });
    await writeFile(entry.originalPath, entry.beforeRaw, "utf-8");
    restoredActions += 1;
  }

  return {
    runId: raw.runId,
    restoredActions,
    restorePath,
  };
}

export async function listMemoryGovernanceRuns(memoryDir: string): Promise<string[]> {
  try {
    return (await readdir(governanceRunsDir(memoryDir))).sort().reverse();
  } catch {
    return [];
  }
}

export async function readMemoryGovernanceRunArtifact(
  memoryDir: string,
  runId: string,
): Promise<{
  summary: MemoryGovernanceSummary;
  metrics: MemoryGovernanceMetrics;
  qualityScore: MemoryGovernanceQualityScore;
  keptMemoryIds: string[];
  reviewQueue: MemoryGovernanceReviewQueueEntry[];
  appliedActions: MemoryGovernanceAppliedAction[];
  transitionReport: MemoryGovernanceTransitionReport;
  report: string;
  manifest: MemoryGovernanceManifest;
  restore?: MemoryGovernanceRestoreManifest;
}> {
  const runDir = governanceRunDir(memoryDir, runId);
  const summary = JSON.parse(await readFile(path.join(runDir, "summary.json"), "utf-8")) as MemoryGovernanceSummary;
  const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf-8")) as MemoryGovernanceMetrics;
  metrics.qualityScore ??= buildQualityScore(metrics.reviewReasons);
  const keptMemoryIds = JSON.parse(await readFile(path.join(runDir, "kept-memories.json"), "utf-8")) as string[];
  const reviewQueue = JSON.parse(
    await readFile(path.join(runDir, "review-queue.json"), "utf-8"),
  ) as MemoryGovernanceReviewQueueEntry[];
  const appliedActions = JSON.parse(
    await readFile(path.join(runDir, "applied-actions.json"), "utf-8"),
  ) as MemoryGovernanceAppliedAction[];
  const qualityScoreRaw = await safeRead(path.join(runDir, "quality-score.json"));
  const transitionReportRaw = await safeRead(path.join(runDir, "status-transitions.json"));
  const manifest = JSON.parse(
    await readFile(path.join(runDir, "manifest.json"), "utf-8"),
  ) as MemoryGovernanceManifest;
  const report = await readFile(path.join(runDir, "report.md"), "utf-8");
  const restoreRaw = await safeRead(path.join(runDir, "restore.json"));
  const qualityScore = qualityScoreRaw
    ? JSON.parse(qualityScoreRaw) as MemoryGovernanceQualityScore
    : metrics.qualityScore ?? buildQualityScore(metrics.reviewReasons);
  const transitionReport = transitionReportRaw
    ? JSON.parse(transitionReportRaw) as MemoryGovernanceTransitionReport
    : {
        proposed: {},
        applied: groupActionsByStatus(appliedActions),
      };
  return {
    summary,
    metrics,
    qualityScore,
    keptMemoryIds,
    reviewQueue,
    appliedActions,
    transitionReport,
    report,
    manifest,
    restore: restoreRaw ? JSON.parse(restoreRaw) as MemoryGovernanceRestoreManifest : undefined,
  };
}
