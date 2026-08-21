export interface SyntheticCorrectionReplacement {
  oldValue: string;
  newValue: string;
}

/**
 * Parse only the deterministic correction forms emitted by the synthetic
 * MemCorrect corpus, plus the adapter conformance canary. This is deliberately
 * not a general natural-language parser: the demo server should exercise the
 * benchmark protocol without pretending to be a production memory engine.
 */
export function parseSyntheticCorrection(content: string): SyntheticCorrectionReplacement | undefined {
  const trimmed = content.trim();
  const patterns: ReadonlyArray<{
    expression: RegExp;
    oldValueIndex: number;
    newValueIndex: number;
  }> = [
    {
      expression: /^Correction: replace (.+) with (.+)\.$/s,
      oldValueIndex: 1,
      newValueIndex: 2,
    },
    {
      expression: /^Correction: my .+? record saying (.+?) is wrong\. It is now (.+)\.$/s,
      oldValueIndex: 1,
      newValueIndex: 2,
    },
    {
      expression: /^Oh by the way, we switched .+? from (.+?) to (.+) last month\.$/s,
      oldValueIndex: 1,
      newValueIndex: 2,
    },
    {
      expression: /^For this project, .+? is (.+?) now, not (.+)\.$/s,
      oldValueIndex: 2,
      newValueIndex: 1,
    },
    {
      expression: /^Update: .+? is (.+?) going forward instead of (.+)\.$/s,
      oldValueIndex: 2,
      newValueIndex: 1,
    },
  ];

  for (const pattern of patterns) {
    const match = pattern.expression.exec(trimmed);
    const oldValue = match?.[pattern.oldValueIndex];
    const newValue = match?.[pattern.newValueIndex];
    if (oldValue !== undefined && newValue !== undefined) return { oldValue, newValue };
  }
  return undefined;
}
