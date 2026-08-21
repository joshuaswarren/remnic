import type { QmdSearchResult } from "../types.js";
import type { GraphRecallExpandedEntry } from "../recall-state.js";

export interface GraphRecallExpansionOptions {
  memoryResults: QmdSearchResult[];
  recallNamespaces: string[];
  recallResultLimit: number;
  asOf?: string;
  asOfMs?: number;
  deadlineAtMs?: number | null;
  includeLowConfidence?: boolean;
}

export interface GraphRecallExpansionResult {
  merged: QmdSearchResult[];
  seedPaths: string[];
  expandedPaths: GraphRecallExpandedEntry[];
  seedResults: QmdSearchResult[];
}
