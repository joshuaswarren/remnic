export function parseNavigateCost(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `navigate cost must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
