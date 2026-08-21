import fs from "node:fs";
import { parseConfig, resolveRemnicConfigRecord, drainPendingImpressionsForOfflineSync, type PluginConfig } from "@remnic/core";
import { LastRecallStore } from "@remnic/core/recall-state";

/**
 * Parse config with parseConfig's coercion diagnostics suppressed so a
 * secret-bearing config value (e.g. an API key placed where a number belongs)
 * cannot leak to stderr before a redacted throw (#2033). On the standalone CLI
 * path no logger is installed, so parseConfig's numeric/boolean coercion warns
 * the RAW value via `console.warn`; a redacted catch only sanitizes the thrown
 * error, not that warning. Silence `console.warn` across the parse and restore
 * it in `finally`. The parse is synchronous, so no interleaved caller loses a
 * warning.
 */
export function parseConfigQuietly(raw: unknown): PluginConfig {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return parseConfig(resolveRemnicConfigRecord(raw));
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * Config keys the offline-sync CLI actually consumes: push-side excludes, the
 * secure-store write policy, and the recall-impression rotation bounds. Nothing
 * else influences an offline command.
 */
const OFFLINE_CONFIG_KEYS = [
  "offlineSyncExcludes",
  "secureStoreEncryptOnWrite",
  "recallImpressionsRotateBytes",
  "recallImpressionsRotateKeep",
] as const;

/**
 * Reduce a raw config to ONLY the keys an offline command needs (#2033). Every
 * `remnic offline` subcommand previously ran full `parseConfig`, so an invalid
 * UNRELATED field (e.g. `correction.maxAffected`) both aborted offline work that
 * never touches it AND embedded the offending raw value in the thrown message,
 * leaking secrets. Picking the offline keys before parsing drops unrelated
 * fields entirely: they can neither throw nor leak, while the offline keys keep
 * parseConfig's exact validation/coercion/defaults (redacted by the caller when
 * an OFFLINE key is itself invalid). A structurally malformed wrapper is treated
 * as unrelated to offline settings and falls back to the flat record.
 */
export function pickOfflineConfigRecord(raw: unknown): Record<string, unknown> {
  let resolved: Record<string, unknown>;
  try {
    resolved = resolveRemnicConfigRecord(raw);
  } catch {
    resolved = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  }
  const picked: Record<string, unknown> = {};
  for (const key of OFFLINE_CONFIG_KEYS) {
    if (key in resolved) picked[key] = resolved[key];
  }
  return picked;
}

/**
 * Recall-impression rotation bounds the daemon writer uses (#2033). A standalone
 * CLI push drains pending impressions through its own `LastRecallStore`; passing
 * these bounds keeps that drain's rotation identical to the writer's instead of
 * silently reverting to `LastRecallStore` defaults.
 */
export interface OfflineImpressionRotation {
  impressionsRotateBytes: number;
  impressionsRotateKeep: number;
}

/**
 * Resolve the recall-impression rotation bounds the daemon writer uses so a
 * standalone CLI push drains through an identically-configured store (#2033).
 * Uses the same config parser as the writer, but a config read/parse or
 * validation failure aborts with a GENERIC, path-scoped error - never the
 * underlying error's message. Both `JSON.parse` (Node quotes surrounding input)
 * and `parseConfig` (embeds offending values, e.g. `got "<value>"`) can leak
 * raw config secrets such as API keys into a user-facing CLI error (#2033), so
 * the detail is dropped rather than surfaced.
 */
export function resolveOfflineImpressionRotation(configPath: string): OfflineImpressionRotation {
  let raw: unknown;
  try {
    raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
  } catch {
    throw new Error(
      `cannot read recall-impression rotation from ${configPath}: config file could not be read as JSON`,
    );
  }
  let config: PluginConfig;
  try {
    config = parseConfigQuietly(pickOfflineConfigRecord(raw));
  } catch {
    throw new Error(
      `cannot read recall-impression rotation from ${configPath}: config failed validation`,
    );
  }
  return {
    impressionsRotateBytes: config.recallImpressionsRotateBytes,
    impressionsRotateKeep: config.recallImpressionsRotateKeep,
  };
}

/**
 * Fold pending recall impressions through a rotation-configured `LastRecallStore`
 * before an offline-sync push, matching the daemon writer's rotation (#2033).
 */
export async function drainOfflineSyncImpressions(
  memoryDir: string,
  rotation: OfflineImpressionRotation,
): Promise<void> {
  await drainPendingImpressionsForOfflineSync(() =>
    new LastRecallStore(memoryDir, {
      impressionsRotateBytes: rotation.impressionsRotateBytes,
      impressionsRotateKeep: rotation.impressionsRotateKeep,
    }).drainPendingImpressions(),
  );
}
