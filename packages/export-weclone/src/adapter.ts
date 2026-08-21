/**
 * WeClone Alpaca-format training export adapter.
 *
 * Converts TrainingExportRecord[] into the JSON format that
 * WeClone / LLaMA Factory expects for fine-tuning:
 *
 *   [{ "instruction": "...", "input": "", "output": "..." }, ...]
 *
 * Only the three Alpaca fields are emitted; Remnic-specific
 * metadata (category, confidence, sourceIds) is stripped.
 */

import type { TrainingExportAdapter, TrainingExportRecord } from "@remnic/core";

export const wecloneExportAdapter: TrainingExportAdapter = {
  name: "weclone",
  fileExtension: ".json",

  formatRecords(records: TrainingExportRecord[]): string {
    const alpacaRecords = records.map((r) => ({
      instruction: r.instruction,
      input: r.input,
      output: r.output,
    }));
    return JSON.stringify(alpacaRecords, null, 2);
  },
};
