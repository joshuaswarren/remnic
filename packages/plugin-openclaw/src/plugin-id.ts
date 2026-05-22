import { resolvePluginEntry } from "@remnic/core/plugin-entry-resolver";

export const REMNIC_OPENCLAW_PLUGIN_ID = "openclaw-remnic" as const;
export const REMNIC_OPENCLAW_LEGACY_PLUGIN_ID = "openclaw-engram" as const;

export const REMNIC_OPENCLAW_PLUGIN_IDS = [
  REMNIC_OPENCLAW_PLUGIN_ID,
  REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
] as const;

function getOpenClawPluginEntries(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const entries =
    plugins && plugins["entries"] && typeof plugins["entries"] === "object" && !Array.isArray(plugins["entries"])
      ? (plugins["entries"] as Record<string, unknown>)
      : undefined;
  return entries;
}

function getOpenClawMemorySlotId(raw: Record<string, unknown>): string | undefined {
  const plugins =
    raw["plugins"] && typeof raw["plugins"] === "object" && !Array.isArray(raw["plugins"])
      ? (raw["plugins"] as Record<string, unknown>)
      : undefined;
  const slots =
    plugins && plugins["slots"] && typeof plugins["slots"] === "object" && !Array.isArray(plugins["slots"])
      ? (plugins["slots"] as Record<string, unknown>)
      : undefined;
  const slotId = slots?.["memory"];
  return typeof slotId === "string" ? slotId : undefined;
}

export function resolveRemnicOpenClawPluginEntry(
  raw: unknown,
  preferredId?: string,
): Record<string, unknown> | undefined {
  return resolvePluginEntry(raw, {
    candidateIds: REMNIC_OPENCLAW_PLUGIN_IDS,
    preferredId,
    getEntries: getOpenClawPluginEntries,
    getSlotId: getOpenClawMemorySlotId,
  });
}
