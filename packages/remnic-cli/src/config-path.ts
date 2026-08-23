/**
 * CLI config-path resolution (issue #2796).
 *
 * Thin wrapper over the shared core discovery so commands can resolve the
 * config file without importing the full CLI index module.
 */

import { discoverConfigPath } from "@remnic/core";

export function resolveConfigPath(cliPath?: string): string {
  return discoverConfigPath(cliPath).path;
}
