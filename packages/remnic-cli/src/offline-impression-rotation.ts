import fs from "node:fs";
import { parseConfig, resolveRemnicConfigRecord, drainPendingImpressionsForOfflineSync } from "@remnic/core";
import { LastRecallStore } from "@remnic/core/recall-state";

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
 * Uses the same config parser as the writer; unparseable config surfaces loudly
 * rather than silently falling back to LastRecallStore defaults.
 */
export function resolveOfflineImpressionRotation(configPath: string): OfflineImpressionRotation {
  let raw: unknown;
  try {
    raw = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`cannot read recall-impression rotation from ${configPath}: ${error.message}`);
    }
    throw error;
  }
  const config = parseConfig(resolveRemnicConfigRecord(raw));
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
