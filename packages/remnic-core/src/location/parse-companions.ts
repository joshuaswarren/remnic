import { parseActivityConfig } from "../activity/config.js";
import { parseMeetingsConfig } from "../meetings/config.js";
import { parseProvenanceConfig } from "../provenance.js";
import { parseLocationConfig } from "./config.js";

/** Parse the capture-adjacent config blocks, including location (#2044). */
export function parseCaptureCompanionConfigs(cfg: Record<string, unknown>) {
  return {
    activity: parseActivityConfig(cfg.activity),
    meetings: parseMeetingsConfig(cfg.meetings),
    provenance: parseProvenanceConfig(cfg.provenance),
    location: parseLocationConfig(cfg.location),
  };
}
