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

// `parseStrictCliDate` is the only public surface; `isCalendarDateValid`
// is an internal helper (not re-exported). Exposing it as a public API
// would commit to maintaining it indefinitely for no external caller
// (Cursor review follow-up to PR #509).
export { parseStrictCliDate } from "./date-parse.js";
