import type { ImportTurn } from "@remnic/core/bulk-import";
import type {
  OpenClawFlushPlanIngestor,
  OpenClawFlushPlanIngestResult,
} from "./openclaw-flush-plan-lifecycle.js";

export function isFailedIngestResult(
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
  if (!error || typeof error !== "object" || !("partialResult" in error)) {
    return undefined;
  }
  const partialResult = error.partialResult;
  if (!partialResult || typeof partialResult !== "object") return undefined;
  return partialResult as OpenClawFlushPlanIngestResult;
}

const INGEST_RESULT_COUNTER_KEYS = [
  "attemptedTurnCount",
  "extractionCount",
  "persistedCount",
  "durableOutputCount",
  "skippedCount",
  "failedCount",
  "postPersistMetadataFailureCount",
  "processedTurnCount",
] as const;

type IngestResultCounterKey = (typeof INGEST_RESULT_COUNTER_KEYS)[number];
type IngestResultCounters = Record<IngestResultCounterKey, number>;

function emptyIngestResultCounters(): IngestResultCounters {
  return {
    attemptedTurnCount: 0,
    extractionCount: 0,
    persistedCount: 0,
    durableOutputCount: 0,
    skippedCount: 0,
    failedCount: 0,
    postPersistMetadataFailureCount: 0,
    processedTurnCount: 0,
  };
}

function mergeIngestResultCounters(
  aggregate: IngestResultCounters,
  result: void | OpenClawFlushPlanIngestResult,
): void {
  if (!result || typeof result !== "object") return;
  for (const key of INGEST_RESULT_COUNTER_KEYS) {
    const value = result[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      aggregate[key] += value;
    }
  }
}

export async function ingestFlushPlanImportTurns(params: {
  ingestor: OpenClawFlushPlanIngestor;
  importTurns: ImportTurn[];
  deadlineMs?: number;
}): Promise<void | OpenClawFlushPlanIngestResult> {
  const aggregate = emptyIngestResultCounters();

  for (const turn of params.importTurns) {
    let result: void | OpenClawFlushPlanIngestResult;
    try {
      result = await params.ingestor.ingestBulkImportBatch([turn], {
        ...(params.deadlineMs === undefined
          ? {}
          : { deadlineMs: params.deadlineMs }),
        failOnExtractionFailure: true,
        includeSourceValidAtContext: false,
      });
    } catch (error) {
      mergeIngestResultCounters(aggregate, partialIngestResultFromError(error));
      if (aggregate.failedCount <= 0) aggregate.failedCount += 1;
      if (aggregate.processedTurnCount > 0) return aggregate;
      throw error;
    }

    mergeIngestResultCounters(aggregate, result);
    if (isFailedIngestResult(result)) return aggregate;
    if (
      !(
        typeof result?.processedTurnCount === "number" &&
        result.processedTurnCount > 0
      )
    ) {
      aggregate.processedTurnCount += 1;
    }
  }

  return aggregate;
}
