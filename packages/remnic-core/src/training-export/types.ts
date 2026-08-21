/**
 * Training-data export types.
 *
 * Defines the generic interface that format-specific adapters
 * (WeClone, Axolotl, MLX, etc.) implement to convert Remnic
 * memories into fine-tuning datasets.
 */

export interface TrainingExportOptions {
  memoryDir: string;
  since?: Date;
  until?: Date;
  minConfidence?: number;
  categories?: string[];
  includeEntities?: boolean;
}

export interface TrainingExportRecord {
  instruction: string;
  input: string;
  output: string;
  category?: string;
  confidence?: number;
  sourceIds?: string[];
}

export interface TrainingExportAdapter {
  name: string;
  formatRecords(records: TrainingExportRecord[]): string;
  fileExtension: string;
}
