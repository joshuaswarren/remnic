import { parseActivityConfig } from "../activity/config.js";
import { parseMeetingsConfig } from "../meetings/config.js";
import { parseProvenanceConfig } from "../provenance.js";

/** Parse capture-adjacent config blocks without location (#2044). */
export function parseCaptureCompanionConfigs(cfg: Record<string, unknown>) {
  return {
    activity: parseActivityConfig(cfg.activity),
    meetings: parseMeetingsConfig(cfg.meetings),
    provenance: parseProvenanceConfig(cfg.provenance),
  };
}
