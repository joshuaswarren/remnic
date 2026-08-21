// ---------------------------------------------------------------------------
// Bulk-import — public surface
// ---------------------------------------------------------------------------

export {
  type BulkImportSource,
  type ImportTurn,
  type BulkImportOptions,
  type ImportSourceRole,
  type BulkImportResult,
  type BulkImportError,
  type BulkImportSourceAdapter,
  type ImportTurnValidationIssue,
  isImportRole,
  parseIsoTimestamp,
  validateImportTurn,
} from "./types.js";

export {
  registerBulkImportSource,
  getBulkImportSource,
  listBulkImportSources,
  clearBulkImportSources,
} from "./registry.js";

export {
  runBulkImportPipeline,
  formatBatchTranscript,
  validateBatchSize,
  resolveBulkImportContext,
  type ProcessBatchFn,
  type ProcessBatchContext,
  type ProcessBatchResult,
} from "./pipeline.js";
