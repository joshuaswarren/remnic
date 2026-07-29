import { createHash } from "node:crypto";
import path from "node:path";
import {
  readCausalTrajectoryRecordsStrict,
  readCausalTrajectoryRevisionToken,
  type ActionIntent,
  type ActionStrategyId,
  type CausalTrajectoryRecord,
  type CausalTrajectoryStrictReadResult,
  type EditKind,
} from "../causal-trajectory.js";
import type { CodingContext } from "../types.js";

export const PRE_ACTION_FINGERPRINT_VERSION = 1;
export const PRE_ACTION_WARNING_VERSION = 1;
export const PRE_ACTION_GATE_DEFAULT_TIMEOUT_MS = 50;

export type PreActionGateStatus = "NO_MATCH" | "MATCH_WARN" | "ERROR_FAIL_OPEN";

export interface PreActionGateRequest {
  sessionKey: string;
  strategyId: ActionStrategyId;
  intent: ActionIntent;
  codingContext: CodingContext;
  memoryDir?: string;
  causalTrajectoryStoreDir?: string;
  signal?: AbortSignal;
}

export interface PreActionGateResult {
  status: PreActionGateStatus;
  reason?: string;
  advisoryText?: string;
  fingerprint?: string;
  matchedTrajectoryId?: string;
  revision?: string;
}

export interface NormalizedActionIntent {
  kind: "command" | "edit";
  strategyId: ActionStrategyId;
  fingerprint: string;
}

export interface PreActionGateDependencies {
  readStrict?: (options: {
    memoryDir: string;
    causalTrajectoryStoreDir?: string;
    signal?: AbortSignal;
  }) => Promise<CausalTrajectoryStrictReadResult>;
  getRevision?: (options: {
    memoryDir: string;
    causalTrajectoryStoreDir?: string;
  }) => Promise<string>;
  clock?: () => number;
  maxCacheSize?: number;
  timeoutMs?: number;
}

const ACTION_STRATEGIES: ReadonlySet<ActionStrategyId> = new Set([
  "RUN_CHECK",
  "CHANGE_IMPLEMENTATION",
  "CHANGE_TEST",
  "CHANGE_CONFIGURATION",
  "CHANGE_DEPENDENCY",
  "INVALIDATE_CACHE",
  "RETRY_ACTION",
  "INSPECT_STATE",
]);
const EDIT_KINDS: ReadonlySet<EditKind> = new Set(["create", "update", "delete", "rename"]);
const MAX_COMMAND_CHARS = 128;
const MAX_ARGUMENTS = 32;
const MAX_ARGUMENT_CHARS = 128;
const MAX_PATH_CHARS = 512;
const MAX_SLOT_CHARS = 128;
const MAX_CITATION_CHARS = 180;

function bound(value: string, max: number, field: string): string {
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

export function sanitizePayloadString(input: string): string {
  return input
    .replace(/(?:\/home\/[^\s/]+|\/Users\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/g, "$HOME")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/g, "<secret>")
    .replace(/bearer\s+[a-zA-Z0-9._-]+/gi, "bearer <secret>")
    .trim();
}

function normalizeRepositoryPath(filePath: string, codingContext: CodingContext): string {
  const root = path.resolve(codingContext.rootPath);
  const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("edit path must be contained by codingContext.rootPath");
  }
  return bound(relative.split(path.sep).join("/"), MAX_PATH_CHARS, "repo-relative path");
}

function normalizeCommandArgument(
  argument: string,
  codingContext: CodingContext,
  secretValue: boolean,
): string {
  const value = bound(sanitizePayloadString(argument), MAX_ARGUMENT_CHARS, "command argument");
  if (secretValue || value.includes("<secret>")) return "<secret>";
  if (/^--(?:token|key|secret|password|authorization)=/i.test(value)) {
    return `${value.slice(0, value.indexOf("=") + 1)}<secret>`;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return "<uuid>";
  if (/^[0-9a-f]{7,64}$/i.test(value)) return "<sha>";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return "<timestamp>";
  if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(value)) return "<duration>";
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return "<number>";
  const pathLike = path.isAbsolute(value)
    || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && /[\\/]/.test(value) && !value.startsWith("--"));
  if (pathLike) {
    let relative: string;
    try {
      relative = normalizeRepositoryPath(value, codingContext);
    } catch {
      return "<external-path>";
    }
    return /(?:^|\/)(?:tmp|temp)(?:\/|$)|\.tmp$/i.test(relative)
      ? `<repo-temp-path:${relative}>`
      : `<repo-path:${relative}>`;
  }
  return value;
}

export function normalizeActionIntent(
  intent: ActionIntent,
  strategyId: ActionStrategyId,
  codingContext: CodingContext,
): NormalizedActionIntent {
  if (!ACTION_STRATEGIES.has(strategyId)) throw new Error(`unsupported action strategy: ${strategyId}`);

  let payload: string;
  if (intent.kind === "command") {
    const command = bound(sanitizePayloadString(intent.command), MAX_COMMAND_CHARS, "command");
    const args = intent.args ?? [];
    if (args.length > MAX_ARGUMENTS) throw new Error(`command args exceed ${MAX_ARGUMENTS} entries`);
    const normalizedArgs = args.map((argument, index) => {
      const prior = index > 0 ? args[index - 1] : undefined;
      const secretValue = prior !== undefined
        && /^--(?:token|key|secret|password|authorization)$/i.test(prior);
      return normalizeCommandArgument(argument, codingContext, secretValue);
    });
    payload = JSON.stringify({ kind: "command", strategyId, command, args: normalizedArgs });
  } else if (intent.kind === "edit") {
    if (!EDIT_KINDS.has(intent.editKind)) throw new Error(`unsupported edit kind: ${intent.editKind}`);
    const relativePath = normalizeRepositoryPath(intent.filePath, codingContext);
    payload = JSON.stringify({
      kind: "edit",
      strategyId,
      filePath: relativePath,
      editKind: intent.editKind,
      symbol: intent.symbol ? bound(intent.symbol, MAX_SLOT_CHARS, "symbol") : undefined,
      range: intent.range ? bound(intent.range, MAX_SLOT_CHARS, "range") : undefined,
      diffShape: intent.diffShape ? bound(intent.diffShape, MAX_SLOT_CHARS, "diffShape") : undefined,
    });
  } else {
    throw new Error("action intent kind must be command or edit");
  }

  return {
    kind: intent.kind,
    strategyId,
    fingerprint: `v1:sha256:${createHash("sha256").update(payload).digest("hex")}`,
  };
}

function matchTrajectory(
  record: CausalTrajectoryRecord,
  projectId: string,
  normalized: NormalizedActionIntent,
): boolean {
  const identity = record.actionIdentity;
  return record.outcomeKind === "failure"
    && record.codingContext?.projectId === projectId
    && identity?.fingerprintVersion === PRE_ACTION_FINGERPRINT_VERSION
    && identity.strategyId === normalized.strategyId
    && identity.fingerprint === normalized.fingerprint;
}

function boundedCitation(value: string | undefined, fallback: string): string {
  const sanitized = sanitizePayloadString(value ?? fallback).replace(/\s+/g, " ");
  return sanitized.slice(0, MAX_CITATION_CHARS);
}

export class PreActionFailureGate {
  private readonly cache = new Map<string, PreActionGateResult>();
  private readonly maxCacheSize: number;
  private readonly readStrict: NonNullable<PreActionGateDependencies["readStrict"]>;
  private readonly getRevision: NonNullable<PreActionGateDependencies["getRevision"]>;
  private readonly clock: () => number;
  private readonly timeoutMs: number;

  constructor(deps: PreActionGateDependencies = {}) {
    this.readStrict = deps.readStrict ?? readCausalTrajectoryRecordsStrict;
    this.getRevision = deps.getRevision ?? readCausalTrajectoryRevisionToken;
    this.clock = deps.clock ?? Date.now;
    this.maxCacheSize = deps.maxCacheSize ?? 500;
    this.timeoutMs = Math.max(1, deps.timeoutMs ?? PRE_ACTION_GATE_DEFAULT_TIMEOUT_MS);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  async evaluate(request: PreActionGateRequest): Promise<PreActionGateResult> {
    const deadline = this.clock() + this.timeoutMs;
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort();
    request.signal?.addEventListener("abort", abortFromExternal, { once: true });
    if (request.signal?.aborted) controller.abort();

    let resolveTimeout!: (result: PreActionGateResult) => void;
    const timeoutPromise = new Promise<PreActionGateResult>((resolve) => {
      resolveTimeout = resolve;
    });
    const timer = setTimeout(() => {
      controller.abort();
      resolveTimeout({ status: "ERROR_FAIL_OPEN", reason: `PreActionFailureGate timed out after ${this.timeoutMs}ms` });
    }, this.timeoutMs);
    timer.unref();

    try {
      return await Promise.race([
        this.evaluateInternal(request, controller.signal, deadline),
        timeoutPromise,
      ]);
    } catch (error) {
      return { status: "ERROR_FAIL_OPEN", reason: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortFromExternal);
    }
  }

  private async evaluateInternal(
    request: PreActionGateRequest,
    signal: AbortSignal,
    deadline: number,
  ): Promise<PreActionGateResult> {
    if (!request.memoryDir?.trim()) return { status: "ERROR_FAIL_OPEN", reason: "memoryDir is required" };
    if (!request.sessionKey?.trim()) return { status: "ERROR_FAIL_OPEN", reason: "sessionKey is required" };
    if (!request.codingContext?.projectId?.trim() || !request.codingContext.rootPath?.trim()) {
      return { status: "ERROR_FAIL_OPEN", reason: "codingContext with projectId and rootPath is required" };
    }

    let normalized: NormalizedActionIntent;
    try {
      normalized = normalizeActionIntent(request.intent, request.strategyId, request.codingContext);
    } catch (error) {
      return { status: "ERROR_FAIL_OPEN", reason: error instanceof Error ? error.message : String(error) };
    }

    const revisionOptions = {
      memoryDir: request.memoryDir,
      causalTrajectoryStoreDir: request.causalTrajectoryStoreDir,
    };
    const preRevision = await this.getRevision(revisionOptions);
    const branch = request.codingContext.branch ?? "";
    const storeId = createHash("sha256")
      .update(request.causalTrajectoryStoreDir ?? request.memoryDir)
      .digest("hex");
    const cacheKey = createHash("sha256").update(JSON.stringify([
      request.codingContext.projectId,
      branch,
      request.sessionKey,
      PRE_ACTION_FINGERPRINT_VERSION,
      preRevision,
      normalized.fingerprint,
      storeId,
    ])).digest("hex");
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    if (signal.aborted || this.clock() >= deadline) return { status: "ERROR_FAIL_OPEN", reason: "deadline exceeded" };
    const scan = await this.readStrict({ ...revisionOptions, signal });
    if (signal.aborted || this.clock() >= deadline) return { status: "ERROR_FAIL_OPEN", reason: "deadline exceeded" };
    if (scan.invalidTrajectories.length > 0) {
      return { status: "ERROR_FAIL_OPEN", reason: `store contains ${scan.invalidTrajectories.length} invalid record(s)` };
    }

    const postRevision = await this.getRevision(revisionOptions);
    const stableRevision = preRevision === postRevision;
    const match = scan.trajectories
      .filter((record) => matchTrajectory(record, request.codingContext.projectId, normalized))
      .sort((left, right) => {
        const recordedAtOrder = right.recordedAt.localeCompare(left.recordedAt);
        return recordedAtOrder !== 0
          ? recordedAtOrder
          : left.trajectoryId.localeCompare(right.trajectoryId);
      })[0];
    const result: PreActionGateResult = match
      ? {
          status: "MATCH_WARN",
          advisoryText: `[PreActionFailureGate ${PRE_ACTION_WARNING_VERSION}] A similar action failed before. Prior act: "${boundedCitation(match.actionSummary, "recorded action")}". Failure: "${boundedCitation(match.outcomeSummary, "recorded failure")}". Next safe check: "${boundedCitation(match.followUpSummary, "verify prerequisites before retrying")}".`,
          fingerprint: normalized.fingerprint,
          matchedTrajectoryId: match.trajectoryId,
          revision: postRevision,
        }
      : { status: "NO_MATCH", fingerprint: normalized.fingerprint, revision: postRevision };

    if (stableRevision && !signal.aborted && this.clock() < deadline) this.setCache(cacheKey, result);
    return result;
  }

  private setCache(key: string, result: PreActionGateResult): void {
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, result);
  }
}
