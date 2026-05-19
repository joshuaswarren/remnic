/**
 * Pure CLI argument helpers.
 *
 * Extracted from index.ts so tests can import them without triggering the
 * CLI entry's transitive dependency on `@remnic/core/dist/index.js`, which
 * may not be built when running root-level `tsx --test` in CI.
 *
 * No external dependencies — safe to import anywhere.
 */

/**
 * Returns the trailing value after `flag` in `args`, or `undefined` if the
 * flag is absent or appears as the last token (no trailing value).
 */
export function resolveFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  return isOptionToken(value) ? undefined : value;
}

function isOptionToken(value: string): boolean {
  if (!value.startsWith("-")) return false;
  if (/^-\d/.test(value) || /^-\.\d/.test(value)) return false;
  return true;
}

/**
 * Returns true if `flag` appears anywhere in `args`, regardless of whether
 * it has a trailing value.
 */
export function hasFlag(args: string[], flag: string): boolean {
  return args.indexOf(flag) !== -1;
}

/**
 * Flag spec for `taxonomy resolve`.
 */
export const TAXONOMY_RESOLVE_BOOLEAN_FLAGS = new Set(["--json"]);
export const TAXONOMY_RESOLVE_VALUE_FLAGS = new Set(["--category"]);

export interface TaxonomyResolveArgs {
  textParts: string[];
  values: Record<string, string>;
  booleans: Set<string>;
}

/**
 * Strip CLI flags from `taxonomy resolve` argument tokens, returning only
 * the text parts. Boolean flags (e.g. `--json`) skip only the flag itself;
 * key-value flags (e.g. `--category preference`) skip the flag and its
 * following value token.
 *
 * Use `--` before literal text that starts with `--`.
 */
export function stripResolveFlags(
  args: string[],
  booleanFlags: ReadonlySet<string> = TAXONOMY_RESOLVE_BOOLEAN_FLAGS,
  valueFlags: ReadonlySet<string> = TAXONOMY_RESOLVE_VALUE_FLAGS,
): string[] {
  return parseTaxonomyResolveArgs(args, booleanFlags, valueFlags).textParts;
}

export function parseTaxonomyResolveArgs(
  args: string[],
  booleanFlags: ReadonlySet<string> = TAXONOMY_RESOLVE_BOOLEAN_FLAGS,
  valueFlags: ReadonlySet<string> = TAXONOMY_RESOLVE_VALUE_FLAGS,
): TaxonomyResolveArgs {
  const textParts: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  let literalText = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (literalText) {
      textParts.push(arg);
      continue;
    }

    if (arg === "--") {
      literalText = true;
      continue;
    }

    if (arg.startsWith("--")) {
      if (booleanFlags.has(arg)) {
        booleans.add(arg);
        continue;
      }

      if (valueFlags.has(arg)) {
        const value = args[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${arg} requires a value`);
        }
        values[arg] = value;
        i++;
        continue;
      }

      throw new Error(`Unknown flag: ${arg}`);
    }

    textParts.push(arg);
  }

  return { textParts, values, booleans };
}
