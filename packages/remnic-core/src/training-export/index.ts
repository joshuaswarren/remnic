/**
 * Training-data export — public barrel.
 *
 * Re-exports types, adapter registry, and memory-to-record converter.
 */

export type {
  TrainingExportOptions,
  TrainingExportRecord,
  TrainingExportAdapter,
} from "./types.js";

export {
  registerTrainingExportAdapter,
  getTrainingExportAdapter,
  listTrainingExportAdapters,
  clearTrainingExportAdapters,
} from "./registry.js";

export { convertMemoriesToRecords } from "./converter.js";

export { parseStrictCliDate } from "./date-parse.js";
