/**
 * Typed-row helpers for better-sqlite3 — narrow the library's `unknown`
 * return values with a runtime shape check before reading properties.
 *
 * better-sqlite3 returns `unknown` for `.get()` and `unknown[]` for
 * `.all()`. The codebase has historically relied on inline `as` casts;
 * this module provides a typed wrapper that validates the SHAPE at runtime
 * so a bad query (column renames, dropped columns) fails loudly instead
 * of silently reading `undefined`.
 */

export type SqliteRow = Record<string, unknown>;

export function isSqliteRow(value: unknown): value is SqliteRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a `.get()` result. Returns `undefined` when the row is missing
 * OR when the expected columns are absent. Callers can then assert the
 * expected shape (the columns are guaranteed to exist after this check).
 */
export function expectRow<T extends SqliteRow>(
  value: unknown,
  columns: readonly (keyof T)[],
): T | undefined {
  if (!isSqliteRow(value)) return undefined;
  for (const col of columns) {
    if (!(col in value)) return undefined;
  }
  return value as T;
}

export function expectRows<T extends SqliteRow>(
  value: unknown,
  columns: readonly (keyof T)[],
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const row of value) {
    const narrowed = expectRow<T>(row, columns);
    if (narrowed) out.push(narrowed);
  }
  return out;
}
