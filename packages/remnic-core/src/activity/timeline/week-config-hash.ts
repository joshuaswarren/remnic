/**
 * Weekly snapshot config hash (issue #2052).
 *
 * `persistWeeklySnapshot` keys each snapshot file by a `configHash`; this
 * computes that digest deterministically from the weekly config so every
 * caller derives the same value for the same inputs. Stable across category
 * order and key insertion order; any semantic change produces a new digest,
 * which keys a new snapshot file instead of mutating an unrelated period.
 */
import { hashActivityBody } from "../digest.js";

export interface WeeklyConfigInput {
  timezone: string;
  weekStartsOn: string;
  /** Category definitions that shape the snapshot. */
  categories: readonly { id: string; name: string }[];
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RangeError(`${field} must be a non-blank string`);
  }
  return value;
}

export function computeWeeklyConfigHash(input: WeeklyConfigInput): string {
  if (typeof input !== "object" || input === null) {
    throw new RangeError("input must be a WeeklyConfigInput object");
  }
  const timezone = requireNonBlank(input.timezone, "timezone");
  const weekStartsOn = requireNonBlank(input.weekStartsOn, "weekStartsOn");
  if (!Array.isArray(input.categories)) {
    throw new RangeError("categories must be an array of category definitions");
  }
  // Copy + sort: never sort the caller's array in place, and hash category
  // order-independently so a harmless reorder cannot orphan stored snapshots.
  const sorted = input.categories
    .map((category, index) => ({
      id: requireNonBlank(category?.id, `categories[${index}].id`),
      name: requireNonBlank(category?.name, `categories[${index}].name`),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].id === sorted[index - 1].id) {
      throw new RangeError(`duplicate category id: ${sorted[index].id}`);
    }
  }
  // Fixed field order; JSON.stringify each part so no separator can collide
  // with category content.
  const body = [
    JSON.stringify(timezone),
    JSON.stringify(weekStartsOn),
    ...sorted.map((category) => JSON.stringify([category.id, category.name])),
  ].join("\n");
  return hashActivityBody(body);
}
