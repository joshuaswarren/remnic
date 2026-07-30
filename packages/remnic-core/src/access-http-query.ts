import { EngramAccessInputError } from "./access-service.js";

/** Optional string field from a JSON body: absent/null/"" → undefined. */
export function optionalQueryString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new EngramAccessInputError(`${label} must be a string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Optional non-empty query param: null/"" → undefined. */
export function nonEmptyQueryParam(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

/** Optional positive-integer query param; rejects invalid values. */
export function positiveIntQueryParam(value: string | null, label: string): number | undefined {
  if (value === null || value.length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new EngramAccessInputError(`${label} expects a positive integer`);
  }
  return parsed;
}
