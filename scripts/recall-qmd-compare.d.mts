export function spearman(xs: number[], ys: number[]): number | null;

export function compareRankedLists(
  before: Array<{ docid: string; score?: number }>,
  after: Array<{ docid: string; score?: number }>
): { top1Match: boolean; top10Overlap: number; spearman: number | null; unionSize: number };

export type ComparisonRow = {
  name: string;
  beforeMs: number | null;
  afterMs: number | null;
  /** True when the counterpart file is absent or unreadable; the other fields are then absent. */
  missing?: boolean;
  /** True when exactly one of the two rankings is empty; the CLI exits 1. */
  oneSidedEmpty?: boolean;
  top1Match?: boolean;
  top10Overlap?: number;
  spearman?: number | null;
  unionSize?: number;
};

export function compareDirectories(beforeDir: string, afterDir: string): ComparisonRow[];

export function compareRerankOff(dir: string): ComparisonRow[];

export function formatComparison(rows: ComparisonRow[]): string;
