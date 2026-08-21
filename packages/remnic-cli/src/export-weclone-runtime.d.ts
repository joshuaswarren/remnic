import type { TrainingExportAdapter } from "@remnic/core";

declare module "@remnic/export-weclone" {
  export const wecloneExportAdapter: TrainingExportAdapter;
  export function ensureWecloneExportAdapterRegistered(registry?: {
    getTrainingExportAdapter(name: string): unknown;
    registerTrainingExportAdapter(adapter: TrainingExportAdapter): void;
  }): boolean;
  export function synthesizeTrainingPairs(
    records: Array<Record<string, unknown>>,
    options?: { maxPairsPerRecord?: number; styleMarkers?: unknown },
  ): Array<Record<string, unknown>>;
  export function sweepPii(
    records: Array<Record<string, unknown>>,
  ): {
    cleanRecords: Array<Record<string, unknown>>;
    redactedCount: number;
  };
}
