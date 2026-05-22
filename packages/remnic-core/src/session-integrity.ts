import path from "node:path";
import { lstat, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import type { Checkpoint, TranscriptEntry } from "./types.js";

export type SessionIntegrityIssueCode =
  | "transcript_malformed_line"
  | "transcript_invalid_entry"
  | "transcript_duplicate_turn_id"
  | "transcript_broken_chain"
  | "transcript_incomplete_turn"
  | "checkpoint_missing"
  | "checkpoint_invalid_json"
  | "checkpoint_invalid_metadata"
  | "checkpoint_expired";

export interface SessionIntegrityIssue {
  code: SessionIntegrityIssueCode;
  severity: "info" | "warn" | "error";
  message: string;
  filePath?: string;
  line?: number;
  sessionKey?: string;
}

export interface SessionTranscriptStats {
  sessionKey: string;
  entries: number;
  malformedLines: number;
  invalidEntries: number;
  duplicateTurnIds: number;
  brokenChains: number;
  incompleteTurns: number;
}

export interface SessionIntegrityReport {
  generatedAt: string;
  memoryDir: string;
  healthy: boolean;
  sessions: SessionTranscriptStats[];
  checkpoint: {
    present: boolean;
    healthy: boolean;
    path: string;
    sessionKey?: string;
    expiresAt?: string;
  };
  issues: SessionIntegrityIssue[];
}

type SessionEntryRef = {
  filePath: string;
  lineNumber: number;
  entry: TranscriptEntry;
};

type FileSessionParse = {
  bySession: Map<string, SessionEntryRef[]>;
  malformed: SessionIntegrityIssue[];
  invalid: SessionIntegrityIssue[];
  invalidBySession: Map<string, number>;
};

export interface SessionRepairAction {
  kind: "rewrite_transcript" | "remove_checkpoint" | "repair_session_files";
  description: string;
  targetPath: string;
  details?: string;
}

export interface SessionRepairPlan {
  generatedAt: string;
  dryRun: boolean;
  memoryDir: string;
  allowSessionFileRepair: boolean;
  actions: SessionRepairAction[];
}

export interface SessionRepairApplyResult {
  applied: boolean;
  actionsAttempted: number;
  actionsApplied: number;
  errors: string[];
}

export interface AnalyzeSessionIntegrityOptions {
  memoryDir: string;
}

export interface PlanSessionRepairOptions {
  report: SessionIntegrityReport;
  dryRun: boolean;
  allowSessionFileRepair?: boolean;
  sessionFilesDir?: string;
}

export interface ApplySessionRepairOptions {
  plan: SessionRepairPlan;
}

function isObjectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object";
}

function isTranscriptEntry(raw: unknown): raw is TranscriptEntry {
  if (!isObjectRecord(raw)) return false;
  if (raw.role !== "user" && raw.role !== "assistant") return false;
  return (
    typeof raw.timestamp === "string" &&
    raw.timestamp.length > 0 &&
    typeof raw.content === "string" &&
    typeof raw.sessionKey === "string" &&
    raw.sessionKey.length > 0 &&
    typeof raw.turnId === "string" &&
    raw.turnId.length > 0
  );
}

async function listTranscriptFiles(memoryDir: string): Promise<string[]> {
  const transcriptsDir = path.join(memoryDir, "transcripts");
  const out: string[] = [];
  const stack = [transcriptsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(fullPath);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function parseTranscriptFile(filePath: string): Promise<FileSessionParse> {
  const bySession = new Map<string, SessionEntryRef[]>();
  const malformed: SessionIntegrityIssue[] = [];
  const invalid: SessionIntegrityIssue[] = [];
  const invalidBySession = new Map<string, number>();

  let raw = "";
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return { bySession, malformed, invalid, invalidBySession };
  }

  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed.push({
        code: "transcript_malformed_line",
        severity: "warn",
        message: "Transcript line is not valid JSON.",
        filePath,
        line: index + 1,
      });
      continue;
    }
    if (!isTranscriptEntry(parsed)) {
      const sessionKey =
        isObjectRecord(parsed) &&
        typeof parsed.sessionKey === "string" &&
        parsed.sessionKey.length > 0
          ? parsed.sessionKey
          : undefined;
      invalid.push({
        code: "transcript_invalid_entry",
        severity: "warn",
        message: "Transcript entry is missing required fields.",
        filePath,
        line: index + 1,
        sessionKey,
      });
      if (sessionKey) {
        invalidBySession.set(sessionKey, (invalidBySession.get(sessionKey) ?? 0) + 1);
      }
      continue;
    }

    const list = bySession.get(parsed.sessionKey) ?? [];
    list.push({ filePath, lineNumber: index + 1, entry: parsed });
    bySession.set(parsed.sessionKey, list);
  }
  return { bySession, malformed, invalid, invalidBySession };
}

function analyzeSessionEntries(
  sessionKey: string,
  refs: SessionEntryRef[],
): { stats: SessionTranscriptStats; issues: SessionIntegrityIssue[] } {
  function parseTimestampForSort(timestamp: string): number {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
    return Number.MAX_SAFE_INTEGER;
  }

  const issues: SessionIntegrityIssue[] = [];
  const sorted = [...refs].sort((a, b) => {
    const tsA = parseTimestampForSort(a.entry.timestamp);
    const tsB = parseTimestampForSort(b.entry.timestamp);
    if (tsA !== tsB) return tsA - tsB;
    const rawTimestampCmp = a.entry.timestamp.localeCompare(b.entry.timestamp);
    if (rawTimestampCmp !== 0) return rawTimestampCmp;
    return a.entry.turnId.localeCompare(b.entry.turnId);
  });
  const turnIdSeen = new Set<string>();
  let duplicateTurnIds = 0;
  let brokenChains = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (turnIdSeen.has(current.entry.turnId)) {
      duplicateTurnIds += 1;
      issues.push({
        code: "transcript_duplicate_turn_id",
        severity: "warn",
        message: `Duplicate turnId detected: ${current.entry.turnId}`,
        sessionKey,
        filePath: current.filePath,
        line: current.lineNumber,
      });
    } else {
      turnIdSeen.add(current.entry.turnId);
    }

    if (i > 0) {
      const previous = sorted[i - 1];
      if (previous && previous.entry.role === current.entry.role) {
        brokenChains += 1;
        issues.push({
          code: "transcript_broken_chain",
          severity: "warn",
          message: `Adjacent turns have the same role (${current.entry.role}).`,
          sessionKey,
          filePath: current.filePath,
          line: current.lineNumber,
        });
      }
    }
  }

  let incompleteTurns = 0;
  if (sorted.length > 0 && sorted[sorted.length - 1]?.entry.role === "user") {
    incompleteTurns = 1;
    const last = sorted[sorted.length - 1];
    issues.push({
      code: "transcript_incomplete_turn",
      severity: "warn",
      message: "Session ends on a user turn without assistant response.",
      sessionKey,
      filePath: last?.filePath,
      line: last?.lineNumber,
    });
  }

  return {
    stats: {
      sessionKey,
      entries: sorted.length,
      malformedLines: 0,
      invalidEntries: 0,
      duplicateTurnIds,
      brokenChains,
      incompleteTurns,
    },
    issues,
  };
}

function validateCheckpointRaw(checkpoint: unknown): checkpoint is Checkpoint {
  if (!isObjectRecord(checkpoint)) return false;
  return (
    typeof checkpoint.sessionKey === "string" &&
    checkpoint.sessionKey.length > 0 &&
    typeof checkpoint.capturedAt === "string" &&
    typeof checkpoint.ttl === "string" &&
    Array.isArray(checkpoint.turns)
  );
}

async function analyzeCheckpoint(memoryDir: string): Promise<{
  checkpoint: SessionIntegrityReport["checkpoint"];
  issues: SessionIntegrityIssue[];
}> {
  const checkpointPath = path.join(memoryDir, "state", "checkpoint.json");
  const issues: SessionIntegrityIssue[] = [];
  const checkpoint: SessionIntegrityReport["checkpoint"] = {
    present: false,
    healthy: true,
    path: checkpointPath,
  };

  let raw = "";
  try {
    raw = await readFile(checkpointPath, "utf-8");
  } catch {
    issues.push({
      code: "checkpoint_missing",
      severity: "info",
      message: "No checkpoint file present.",
      filePath: checkpointPath,
    });
    return { checkpoint, issues };
  }

  checkpoint.present = true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    checkpoint.healthy = false;
    issues.push({
      code: "checkpoint_invalid_json",
      severity: "error",
      message: "Checkpoint file is invalid JSON.",
      filePath: checkpointPath,
    });
    return { checkpoint, issues };
  }

  if (!validateCheckpointRaw(parsed)) {
    checkpoint.healthy = false;
    issues.push({
      code: "checkpoint_invalid_metadata",
      severity: "error",
      message: "Checkpoint file is missing required metadata fields.",
      filePath: checkpointPath,
    });
    return { checkpoint, issues };
  }

  checkpoint.sessionKey = parsed.sessionKey;
  checkpoint.expiresAt = parsed.ttl;

  const ttlMs = Date.parse(parsed.ttl);
  const capturedAtMs = Date.parse(parsed.capturedAt);
  if (!Number.isFinite(ttlMs) || !Number.isFinite(capturedAtMs) || ttlMs <= capturedAtMs) {
    checkpoint.healthy = false;
    issues.push({
      code: "checkpoint_invalid_metadata",
      severity: "error",
      message: "Checkpoint timestamps are invalid or inconsistent.",
      filePath: checkpointPath,
      sessionKey: parsed.sessionKey,
    });
    return { checkpoint, issues };
  }

  if (ttlMs < Date.now()) {
    checkpoint.healthy = false;
    issues.push({
      code: "checkpoint_expired",
      severity: "warn",
      message: "Checkpoint TTL has expired.",
      filePath: checkpointPath,
      sessionKey: parsed.sessionKey,
    });
  }

  for (const turn of parsed.turns) {
    if (!isTranscriptEntry(turn)) {
      checkpoint.healthy = false;
      issues.push({
        code: "checkpoint_invalid_metadata",
        severity: "error",
        message: "Checkpoint contains invalid turn entries.",
        filePath: checkpointPath,
        sessionKey: parsed.sessionKey,
      });
      break;
    }
  }

  return { checkpoint, issues };
}

export async function analyzeSessionIntegrity(
  options: AnalyzeSessionIntegrityOptions,
): Promise<SessionIntegrityReport> {
  const memoryDir = options.memoryDir;
  const reportIssues: SessionIntegrityIssue[] = [];
  const allSessionRefs = new Map<string, SessionEntryRef[]>();
  const invalidBySession = new Map<string, number>();
  const sessions = new Map<string, SessionTranscriptStats>();

  const files = await listTranscriptFiles(memoryDir);
  for (const filePath of files) {
    const parsed = await parseTranscriptFile(filePath);
    reportIssues.push(...parsed.malformed, ...parsed.invalid);
    for (const [sessionKey, count] of parsed.invalidBySession.entries()) {
      invalidBySession.set(sessionKey, (invalidBySession.get(sessionKey) ?? 0) + count);
    }

    for (const [sessionKey, refs] of parsed.bySession.entries()) {
      const existing = allSessionRefs.get(sessionKey) ?? [];
      existing.push(...refs);
      allSessionRefs.set(sessionKey, existing);
    }
  }

  for (const [sessionKey, refs] of allSessionRefs.entries()) {
    const analyzed = analyzeSessionEntries(sessionKey, refs);
    reportIssues.push(...analyzed.issues);
    sessions.set(sessionKey, {
      ...analyzed.stats,
      malformedLines: 0,
      invalidEntries: invalidBySession.get(sessionKey) ?? 0,
    });
  }

  const checkpoint = await analyzeCheckpoint(memoryDir);
  reportIssues.push(...checkpoint.issues);

  const severeIssueCount = reportIssues.filter((issue) => issue.severity !== "info").length;

  return {
    generatedAt: new Date().toISOString(),
    memoryDir,
    healthy: severeIssueCount === 0,
    sessions: [...sessions.values()].sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)),
    checkpoint: checkpoint.checkpoint,
    issues: reportIssues,
  };
}

function collectTranscriptRewriteTargets(report: SessionIntegrityReport): string[] {
  const set = new Set<string>();
  for (const issue of report.issues) {
    if (!issue.filePath) continue;
    if (
      issue.code === "transcript_malformed_line" ||
      issue.code === "transcript_invalid_entry"
    ) {
      set.add(issue.filePath);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function planSessionRepair(options: PlanSessionRepairOptions): SessionRepairPlan {
  const actions: SessionRepairAction[] = [];
  const transcriptTargets = collectTranscriptRewriteTargets(options.report);
  for (const targetPath of transcriptTargets) {
    actions.push({
      kind: "rewrite_transcript",
      targetPath,
      description: "Rewrite transcript file with only valid JSON transcript entries.",
    });
  }

  const checkpointNeedsRepair = options.report.issues.some((issue) =>
    issue.code === "checkpoint_invalid_json" ||
    issue.code === "checkpoint_invalid_metadata" ||
    issue.code === "checkpoint_expired"
  );
  if (checkpointNeedsRepair && options.report.checkpoint.present) {
    actions.push({
      kind: "remove_checkpoint",
      targetPath: options.report.checkpoint.path,
      description: "Remove invalid or expired checkpoint file.",
    });
  }

  if (options.sessionFilesDir && options.allowSessionFileRepair === true) {
    actions.push({
      kind: "repair_session_files",
      targetPath: options.sessionFilesDir,
      description: "Session file repair was requested; no automatic rewiring is performed.",
      details: "No-op by design. OpenClaw session files require explicit manual review.",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    memoryDir: options.report.memoryDir,
    allowSessionFileRepair: options.allowSessionFileRepair === true,
    actions,
  };
}

async function rewriteTranscriptFile(targetPath: string): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(targetPath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n");
  const validLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isTranscriptEntry(parsed)) continue;
      validLines.push(JSON.stringify(parsed));
    } catch {
      // drop malformed lines
    }
  }
  const body = validLines.length > 0 ? `${validLines.join("\n")}\n` : "";
  await writeFile(targetPath, body, "utf-8");
}

export async function applySessionRepair(
  options: ApplySessionRepairOptions,
): Promise<SessionRepairApplyResult> {
  const { plan } = options;
  if (plan.dryRun) {
    return {
      applied: false,
      actionsAttempted: plan.actions.length,
      actionsApplied: 0,
      errors: [],
    };
  }

  let actionsApplied = 0;
  const errors: string[] = [];

  for (const action of plan.actions) {
    try {
      if (action.kind === "rewrite_transcript") {
        await assertRepairTargetAllowed(plan.memoryDir, action);
        await rewriteTranscriptFile(action.targetPath);
        actionsApplied += 1;
        continue;
      }
      if (action.kind === "remove_checkpoint") {
        await assertRepairTargetAllowed(plan.memoryDir, action);
        try {
          await unlink(action.targetPath);
        } catch (err) {
          const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
          if (code !== "ENOENT") {
            throw err;
          }
        }
        actionsApplied += 1;
        continue;
      }
      if (action.kind === "repair_session_files") {
        // intentionally no-op; pointer/session rewiring is explicitly forbidden here.
        actionsApplied += 1;
      }
    } catch (err) {
      errors.push(`Failed ${action.kind} ${action.targetPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    applied: true,
    actionsAttempted: plan.actions.length,
    actionsApplied,
    errors,
  };
}

async function assertRepairTargetAllowed(memoryDir: string, action: SessionRepairAction): Promise<void> {
  const root = path.resolve(memoryDir);
  const target = path.resolve(action.targetPath);
  if (action.kind === "rewrite_transcript") {
    const transcriptsRoot = path.join(root, "transcripts");
    if (!target.endsWith(".jsonl")) {
      throw new Error("transcript repair target must end in .jsonl");
    }
    await assertNoSymlinkPath(transcriptsRoot, target);
    return;
  }
  if (action.kind === "remove_checkpoint") {
    const checkpointPath = path.join(root, "state", "checkpoint.json");
    if (target !== checkpointPath) {
      throw new Error("checkpoint repair target must be the configured checkpoint.json");
    }
    await assertNoSymlinkPath(root, target);
  }
}

async function assertNoSymlinkPath(root: string, target: string): Promise<void> {
  const rootReal = await realpath(root);
  const targetDir = path.dirname(target);
  const targetDirReal = await realpath(targetDir);
  const relative = path.relative(rootReal, targetDirReal);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    let current = rootReal;
    for (const segment of path.relative(rootReal, target).split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`repair target crosses symlink: ${current}`);
        }
      } catch (err) {
        const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
        if (code !== "ENOENT") throw err;
      }
    }
    return;
  }
  throw new Error("repair target escapes configured memoryDir");
}
