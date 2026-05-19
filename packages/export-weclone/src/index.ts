/**
 * @remnic/export-weclone
 *
 * WeClone-specific training-data export adapter that converts
 * Remnic memories into Alpaca-format fine-tuning datasets
 * compatible with WeClone / LLaMA Factory.
 */

import {
  getTrainingExportAdapter,
  registerTrainingExportAdapter,
  type TrainingExportAdapter,
} from "@remnic/core";

import { wecloneExportAdapter } from "./adapter.js";

export { wecloneExportAdapter } from "./adapter.js";
export { synthesizeTrainingPairs, type SynthesizerOptions } from "./synthesizer.js";
export { extractStyleMarkers, type StyleMarkers } from "./style-extractor.js";
export { sweepPii, type PrivacySweepResult } from "./privacy.js";

export interface TrainingExportRegistry {
  getTrainingExportAdapter(name: string): TrainingExportAdapter | undefined;
  registerTrainingExportAdapter(adapter: TrainingExportAdapter): void;
}

/**
 * Idempotently register the WeClone adapter with the core training-export
 * registry. Callable multiple times without throwing (CLAUDE.md #13:
 * secondary calls must not crash host processes that pre-register the
 * adapter for test fixtures).
 *
 * Returns true when the adapter was newly registered, false when an adapter
 * with the same name already exists.
 */
export function ensureWecloneExportAdapterRegistered(
  registry: TrainingExportRegistry = {
    getTrainingExportAdapter,
    registerTrainingExportAdapter,
  },
): boolean {
  if (registry.getTrainingExportAdapter(wecloneExportAdapter.name) !== undefined) {
    return false;
  }
  registry.registerTrainingExportAdapter(wecloneExportAdapter);
  return true;
}

// Side-effect registration: importing this module registers the adapter.
// Callers that need to manage registration manually (e.g. tests that call
// `clearTrainingExportAdapters()`) can re-invoke
// `ensureWecloneExportAdapterRegistered()` after clearing.
//
// The try/catch keeps import-time errors from breaking unrelated callers —
// the adapter surfaces `formatRecords` purely, so a failure here would be
// surprising, but defensive coding keeps CLI startup resilient.
try {
  ensureWecloneExportAdapterRegistered();
} catch {
  // Swallow — explicit callers can re-invoke ensureWecloneExportAdapterRegistered().
}
