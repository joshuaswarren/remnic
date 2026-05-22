import {
  parseIsoTimestamp,
  type ReplayNormalizer,
  type ReplayParseOptions,
  type ReplaySource,
  type ReplayTurn,
  type ReplayWarning,
  type ReplayValidationIssue,
  validateReplayTurn,
} from "./types.js";

export interface ReplayRunOptions extends ReplayParseOptions {
  dryRun?: boolean;
  startOffset?: number;
  maxTurns?: number;
  batchSize?: number;
}

export interface ReplayRunHandlers {
  onTurn?: (turn: ReplayTurn) => Promise<void> | void;
  onBatch?: (turns: ReplayTurn[]) => Promise<void> | void;
}

export interface ReplayRunSummary {
  source: ReplaySource;
  parsedTurns: number;
  validTurns: number;
  invalidTurns: number;
  filteredByDate: number;
  skippedByOffset: number;
  processedTurns: number;
  batchCount: number;
  dryRun: boolean;
  nextOffset: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  warnings: ReplayWarning[];
}

export type ReplayNormalizerRegistry = Record<ReplaySource, ReplayNormalizer>;

function clampNonNegativeInt(value: number | undefined, defaultValue: number): number {
  if (!Number.isFinite(value as number)) return defaultValue;
  return Math.max(0, Math.floor(value as number));
}

export function clampBatchSize(value: number | undefined): number {
  const parsed = clampNonNegativeInt(value, 100);
  if (parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

function toWarning(issue: ReplayValidationIssue): ReplayWarning {
  return {
    code: issue.code,
    message: issue.message,
    index: issue.index,
  };
}

function inDateRange(turn: ReplayTurn, fromTs: number | null, toTs: number | null): boolean {
  const turnTs = parseIsoTimestamp(turn.timestamp);
  if (turnTs === null) return false;
  if (fromTs !== null && turnTs < fromTs) return false;
  if (toTs !== null && turnTs >= toTs) return false;
  return true;
}

export function buildReplayNormalizerRegistry(normalizers: ReplayNormalizer[]): ReplayNormalizerRegistry {
  const registry = {} as ReplayNormalizerRegistry;
  for (const normalizer of normalizers) {
    if (!normalizer?.source) {
      throw new Error("replay normalizer source is required");
    }
    if (registry[normalizer.source]) {
      throw new Error(`duplicate replay normalizer for source '${normalizer.source}'`);
    }
    registry[normalizer.source] = normalizer;
  }
  return registry;
}

export async function runReplay(
  source: ReplaySource,
  input: unknown,
  registry: ReplayNormalizerRegistry,
  handlers: ReplayRunHandlers = {},
  options: ReplayRunOptions = {},
): Promise<ReplayRunSummary> {
  const normalizer = registry[source];
  if (!normalizer) {
    throw new Error(`missing replay normalizer for source '${source}'`);
  }
  return runReplayWithNormalizer(normalizer, input, handlers, options);
}

export async function runReplayWithNormalizer(
  normalizer: ReplayNormalizer,
  input: unknown,
  handlers: ReplayRunHandlers = {},
  options: ReplayRunOptions = {},
): Promise<ReplayRunSummary> {
  const parseResult = await normalizer.parse(input, options);
  if (!parseResult || typeof parseResult !== "object") {
    throw new Error(`replay normalizer '${normalizer.source}' returned invalid parse result object`);
  }
  if (!Array.isArray(parseResult.turns)) {
    throw new Error(`replay normalizer '${normalizer.source}' returned invalid parse result: turns must be an array`);
  }
  if (parseResult.warnings != null && !Array.isArray(parseResult.warnings)) {
    throw new Error(`replay normalizer '${normalizer.source}' returned invalid parse result: warnings must be an array`);
  }
  const warnings: ReplayWarning[] = [...(parseResult.warnings ?? [])];
  const parsedTurns = parseResult.turns;

  const validTurns: ReplayTurn[] = [];
  let invalidTurns = 0;
  for (let i = 0; i < parsedTurns.length; i += 1) {
    const turn = parsedTurns[i];
    const issues = validateReplayTurn(turn, i);
    if (issues.length === 0 && turn.source !== normalizer.source) {
      issues.push({
        code: "turn.source.mismatch",
        message: `Replay turn source '${turn.source}' does not match normalizer source '${normalizer.source}'.`,
        index: i,
      });
    }
    if (issues.length > 0) {
      invalidTurns += 1;
      for (const issue of issues) warnings.push(toWarning(issue));
      continue;
    }
    validTurns.push(turn);
  }

  const sorted = [...validTurns].sort((a, b) => {
    const left = parseIsoTimestamp(a.timestamp) ?? 0;
    const right = parseIsoTimestamp(b.timestamp) ?? 0;
    return left - right;
  });

  const fromTs = options.from ? parseIsoTimestamp(options.from) : null;
  const toTs = options.to ? parseIsoTimestamp(options.to) : null;
  if (options.from && fromTs === null) {
    throw new Error(`invalid replay --from timestamp '${options.from}'`);
  }
  if (options.to && toTs === null) {
    throw new Error(`invalid replay --to timestamp '${options.to}'`);
  }
  if (fromTs !== null && toTs !== null && fromTs > toTs) {
    throw new Error("invalid replay date range: --from is after --to");
  }

  const ranged = sorted.filter((turn) => inDateRange(turn, fromTs, toTs));
  const filteredByDate = sorted.length - ranged.length;

  const startOffset = clampNonNegativeInt(options.startOffset, 0);
  const skippedByOffset = Math.min(startOffset, ranged.length);
  const offsetApplied = ranged.slice(startOffset);

  const maxTurns = clampNonNegativeInt(options.maxTurns, offsetApplied.length);
  const selected = offsetApplied.slice(0, maxTurns);
  const dryRun = options.dryRun === true;
  const batchSize = clampBatchSize(options.batchSize);

  let batchCount = 0;
  if (!dryRun) {
    for (let i = 0; i < selected.length; i += batchSize) {
      const batch = selected.slice(i, i + batchSize);
      batchCount += 1;
      if (handlers.onBatch) await handlers.onBatch(batch);
      if (handlers.onTurn) {
        for (const turn of batch) {
          await handlers.onTurn(turn);
        }
      }
    }
  } else if (selected.length > 0) {
    batchCount = Math.ceil(selected.length / batchSize);
  }

  return {
    source: normalizer.source,
    parsedTurns: parsedTurns.length,
    validTurns: sorted.length,
    invalidTurns,
    filteredByDate,
    skippedByOffset,
    processedTurns: selected.length,
    batchCount,
    dryRun,
    nextOffset: startOffset + selected.length,
    firstTimestamp: selected[0]?.timestamp,
    lastTimestamp: selected[selected.length - 1]?.timestamp,
    warnings,
  };
}
