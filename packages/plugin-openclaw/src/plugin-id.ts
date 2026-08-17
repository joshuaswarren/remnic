import { LEGACY_PLUGIN_ID, PLUGIN_ID } from "@remnic/core/plugin-id";

export { PLUGIN_ID, LEGACY_PLUGIN_ID } from "@remnic/core/plugin-id";
export {
  resolveRemnicPluginEntry as resolveRemnicOpenClawPluginEntry,
} from "@remnic/core/plugin-id";

export const REMNIC_OPENCLAW_PLUGIN_ID = PLUGIN_ID;
export const REMNIC_OPENCLAW_LEGACY_PLUGIN_ID = LEGACY_PLUGIN_ID;
export const REMNIC_OPENCLAW_PLUGIN_IDS = [
  REMNIC_OPENCLAW_PLUGIN_ID,
  REMNIC_OPENCLAW_LEGACY_PLUGIN_ID,
] as const;

