
const CHARS_PER_TOKEN = 4;

export function estimateGeneratedTokens(charCount: number): number {
  if (!Number.isInteger(charCount) || charCount < 0) {
    throw new RangeError(`charCount must be a non-negative integer, got ${charCount}`);
  }
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

export function estimateOffsetTokens(start: number, end: number): number {
  if (!Number.isInteger(start)) {
    throw new RangeError(`start must be a finite integer, got ${start}`);
  }
  if (!Number.isInteger(end)) {
    throw new RangeError(`end must be a finite integer, got ${end}`);
  }
  if (start > end) {
    throw new RangeError(`reversed span: start ${start} > end ${end}`);
  }
  return offsetTokens(start) + offsetTokens(end);
}

export function spanModeSavesTokens(input: {
  generatedCharCount: number;
  start: number;
  end: number;
}): boolean {
  return (
    estimateOffsetTokens(input.start, input.end) <
    estimateGeneratedTokens(input.generatedCharCount)
  );
}

function offsetTokens(offset: number): number {
  return Math.ceil(String(offset).length / CHARS_PER_TOKEN);
}
