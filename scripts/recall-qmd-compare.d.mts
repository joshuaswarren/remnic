export function spearman(xs: number[], ys: number[]): number;

export function compareRankedLists(
  before: Array<{ docid: string; score?: number }>,
  after: Array<{ docid: string; score?: number }>
): { top1Match: boolean; top10Overlap: number; spearman: number; unionSize: number };
