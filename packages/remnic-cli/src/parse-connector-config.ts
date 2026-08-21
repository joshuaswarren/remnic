/**
 * Pure helper for parsing connector --config flags.
 *
 * Extracted from index.ts so tests can import it without triggering the
 * CLI entry's transitive dependency on `@remnic/core/dist/index.js`, which
 * may not be built when running root-level `tsx --test` in CI.
 *
 * Accepts two forms:
 *   --config=key=value   (joined)
 *   --config key=value   (split)
 *
 * Values may themselves contain "=", so we split on the first "=" only.
 */
function parseConfigAssignment(raw: string, flag: string): [string, string] {
  const eqIdx = raw.indexOf("=");
  if (eqIdx === -1) {
    throw new Error(`${flag} requires key=value`);
  }
  const key = raw.slice(0, eqIdx);
  if (!key) {
    throw new Error(`${flag} requires a non-empty key`);
  }
  return [key, raw.slice(eqIdx + 1)];
}

export function parseConnectorConfig(args: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--config=")) {
      // Joined form: --config=key=value  (value may itself contain "=")
      const rest = arg.slice("--config=".length);
      const [key, value] = parseConfigAssignment(rest, "--config");
      config[key] = value;
    } else if (arg === "--config") {
      // Split form: --config key=value
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--config requires key=value");
      }
      const [key, value] = parseConfigAssignment(next, "--config");
      config[key] = value;
      i++; // consume the next token
    }
  }
  return config;
}

/**
 * Strip the argv tokens that are consumed by `--config` flags from the given
 * args array, returning a new array with those tokens removed.
 *
 * This is used by `cmdConnectors` to compute the connector ID from the
 * remaining positional arguments without accidentally picking up the value
 * token of a split-form `--config key=value`.
 *
 * Examples (tokens removed shown with strikethrough in comments):
 *   ["--config", "installExtension=false", "codex-cli"]
 *     → ["codex-cli"]
 *   ["--config=installExtension=false", "codex-cli"]
 *     → ["codex-cli"]   (joined form: only the one token is removed)
 *   ["--force", "codex-cli"]
 *     → ["--force", "codex-cli"]   (no --config: nothing removed)
 */
export function stripConfigArgv(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--config=")) {
      // Joined form: the flag+value is a single token - validate then skip it.
      parseConfigAssignment(arg.slice("--config=".length), "--config");
      continue;
    } else if (arg === "--config") {
      // Split form: validate and skip both the flag and its value.
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--config requires key=value");
      }
      parseConfigAssignment(next, "--config");
      i++; // skip value token too
      continue;
    }
    result.push(arg);
  }
  return result;
}
