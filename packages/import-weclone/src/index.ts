// ---------------------------------------------------------------------------
// @remnic/import-weclone — public surface
// ---------------------------------------------------------------------------

import {
  getBulkImportSource,
  registerBulkImportSource,
} from "@remnic/core";

import { wecloneImportAdapter } from "./adapter.js";

export { wecloneImportAdapter } from "./adapter.js";

export {
  parseWeCloneExport,
  type WeCloneImportTurn,
  type WeClonePlatform,
  type WeClonePreprocessedMessage,
  type WeClonePreprocessedExport,
  type ParseOptions,
} from "./parser.js";

export {
  groupIntoThreads,
  type ThreadGroup,
  type ThreaderOptions,
} from "./threader.js";

export {
  mapParticipants,
  type ParticipantEntity,
} from "./participant.js";

export {
  chunkThreads,
  type ChunkOptions,
} from "./chunker.js";

export {
  createProgressTracker,
  type ImportProgress,
  type ProgressCallback,
} from "./progress.js";

/**
 * Idempotently register the WeClone adapter with the core bulk-import
 * registry. Callable multiple times without throwing (CLAUDE.md #13:
 * secondary calls must not crash host processes that pre-register the
 * adapter for test fixtures).
 *
 * Returns true when the adapter was newly registered, false when an adapter
 * with the same name already exists.
 */
export function ensureWecloneImportAdapterRegistered(): boolean {
  if (getBulkImportSource(wecloneImportAdapter.name) !== undefined) {
    return false;
  }
  registerBulkImportSource(wecloneImportAdapter);
  return true;
}

// Side-effect registration: importing this module registers the adapter.
// Callers that need to manage registration manually (e.g. tests that call
// `clearBulkImportSources()`) can re-invoke
// `ensureWecloneImportAdapterRegistered()` after clearing.
//
// Let unexpected registry failures surface at import time so the public
// "import registers the adapter" contract cannot silently become false.
ensureWecloneImportAdapterRegistered();
