export function parseMaxChildren(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `max children must be a non-negative integer; got ${JSON.stringify(value)}`,
    );
  }
  return value;
}
