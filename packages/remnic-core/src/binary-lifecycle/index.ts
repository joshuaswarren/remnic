/**
 * Binary file lifecycle management — barrel export.
 *
 * Three-stage pipeline: mirror, redirect, clean.
 */

export type {
  BinaryLifecycleConfig,
  BinaryStorageBackendConfig,
  BinaryAssetRecord,
  BinaryAssetStatus,
  BinaryLifecycleManifest,
  PipelineResult,
} from "./types.js";

export {
  DEFAULT_SCAN_PATTERNS,
  DEFAULT_MAX_BINARY_SIZE_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
} from "./types.js";

export type { BinaryStorageBackend } from "./backend.js";
export { FilesystemBackend, NoneBackend, createBackend } from "./backend.js";

export { scanForBinaries, matchesPatterns } from "./scanner.js";

export {
  readManifest,
  writeManifest,
  manifestPath,
  manifestDir,
  emptyManifest,
} from "./manifest.js";

export { runBinaryLifecyclePipeline } from "./pipeline.js";
