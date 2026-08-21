// ---------------------------------------------------------------------------
// Bulk-import batch processing pipeline
// ---------------------------------------------------------------------------

import {
  validateImportTurn,
  type BulkImportError,
  type BulkImportOptions,
  type BulkImportResult,
  type BulkImportSource,
  type ImportTurn,
} from "./types.js";

const DEFAULT_BATCH_SIZE = 20;
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 1000;

export interface ProcessBatchResult {
  memoriesCreated: number;
  duplicatesSkipped: number;
  /**
   * Number of entities created by the batch. Optional so Phase-1 stubs that
   * only count memories can omit it; when absent it is treated as 0.
   */
  entitiesCreated?: number;
}

export interface ProcessBatchContext {
  dedup: boolean;
  trustLevel: "import";
  namespace?: string;
}

export type ProcessBatchFn = (
  turns: ImportTurn[],
  context: ProcessBatchContext,
) => Promise<ProcessBatchResult>;

export function validateBatchSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_BATCH_SIZE;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `batchSize must be a finite number, received ${String(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new Error(
      `batchSize must be an integer, received ${value}`,
    );
  }
  if (value < MIN_BATCH_SIZE || value > MAX_BATCH_SIZE) {
    throw new Error(
      `batchSize must be between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}, received ${value}`,
    );
  }
  return value;
}

export function resolveBulkImportContext(
  options: BulkImportOptions,
): ProcessBatchContext {
  if (options.dedup !== undefined && typeof options.dedup !== "boolean") {
    throw new Error(
      `dedup must be a boolean when provided, received ${String(options.dedup)}`,
    );
  }
  if (options.trustLevel !== undefined && options.trustLevel !== "import") {
    throw new Error(
      `trustLevel must be 'import' when provided, received ${String(options.trustLevel)}`,
    );
  }
  if (options.namespace !== undefined) {
    if (typeof options.namespace !== "string" || options.namespace.trim().length === 0) {
      throw new Error(
        `namespace must be a non-empty string when provided, received ${String(options.namespace)}`,
      );
    }
  }

  return {
    dedup: options.dedup !== false,
    trustLevel: options.trustLevel ?? "import",
    ...(options.namespace !== undefined
      ? { namespace: options.namespace }
      : {}),
  };
}

/**
 * Format a batch of turns into a conversation transcript string.
 */
export function formatBatchTranscript(turns: ImportTurn[]): string {
  return turns
    .map((t) => {
      const prefix =
        t.participantName ?? t.participantId ?? t.role;
      return `[${t.timestamp}] ${prefix}: ${t.content}`;
    })
    .join("\n");
}

/**
 * Run the bulk-import pipeline over a parsed source.
 *
 * Splits turns into batches and delegates each to `processBatch`.
 * In dryRun mode, validates and counts without calling `processBatch`.
 */
export async function runBulkImportPipeline(
  source: BulkImportSource,
  options: BulkImportOptions = {},
  processBatch: ProcessBatchFn,
): Promise<BulkImportResult> {
  const batchSize = validateBatchSize(options.batchSize);
  const dryRun = options.dryRun === true;
  const batchContext = resolveBulkImportContext(options);

  const result: BulkImportResult = {
    memoriesCreated: 0,
    duplicatesSkipped: 0,
    entitiesCreated: 0,
    turnsProcessed: 0,
    batchesProcessed: 0,
    errors: [],
  };

  const turns = source.turns;

  if (!turns || turns.length === 0) {
    return result;
  }

  // Validate all turns upfront; collect validation errors
  const validTurns: ImportTurn[] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const issues = validateImportTurn(turns[i], i);
    if (issues.length > 0) {
      const error: BulkImportError = {
        batchIndex: -1,
        message: issues.map((iss) => iss.message).join("; "),
      };
      result.errors.push(error);
    } else {
      validTurns.push(turns[i]);
    }
  }

  if (dryRun) {
    result.turnsProcessed = validTurns.length;
    result.batchesProcessed =
      validTurns.length > 0
        ? Math.ceil(validTurns.length / batchSize)
        : 0;
    return result;
  }

  // Process in batches
  let batchIndex = 0;
  for (let i = 0; i < validTurns.length; i += batchSize) {
    const batch = validTurns.slice(i, i + batchSize);
    try {
      const batchResult = await processBatch(batch, batchContext);
      result.memoriesCreated += batchResult.memoriesCreated;
      result.duplicatesSkipped += batchResult.duplicatesSkipped;
      if (typeof batchResult.entitiesCreated === "number") {
        result.entitiesCreated += batchResult.entitiesCreated;
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      result.errors.push({ batchIndex, message });
    }
    result.turnsProcessed += batch.length;
    result.batchesProcessed += 1;
    batchIndex += 1;
  }

  return result;
}
