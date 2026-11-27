
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

try {
  ensureWecloneExportAdapterRegistered();
} catch {
  // Swallow — explicit callers can re-invoke ensureWecloneExportAdapterRegistered().
}
