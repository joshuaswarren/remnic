import fs from "node:fs";
import path from "node:path";

import { readEnvVar, resolveHomeDir } from "../runtime/env.js";

/**
 * Connector registry directory name. Kept under the legacy `engram` config
 * root for backward compatibility with existing installs; the rename to a
 * `remnic` path (with a legacy read-fallback) is tracked in #1518.
 */
export const REGISTRY_DIR_NAME = ".engram-connectors";

/**
 * Single source of truth for the connectors config root
 * (`$XDG_CONFIG_HOME/engram` or `~/.config/engram`). Issue #1527 flagged this
 * derivation as previously duplicated across call sites — add new callers
 * here, never re-derive the path inline.
 */
export function getConnectorsConfigRoot(): string {
  const xdgConfigHome = readEnvVar("XDG_CONFIG_HOME");
  return xdgConfigHome
    ? path.join(xdgConfigHome, "engram")
    : path.join(resolveHomeDir(), ".config", "engram");
}

/** Path of the connector registry manifest file. */
export function getRegistryPath(): string {
  return path.join(getConnectorsConfigRoot(), REGISTRY_DIR_NAME, "registry.json");
}

/** Directory holding one `<connector-id>.json` per installed connector. */
export function getConnectorsDir(): string {
  return path.join(getConnectorsConfigRoot(), REGISTRY_DIR_NAME, "connectors");
}

/**
 * Sticky-legacy evidence for `emitLegacyTools` (issue #1550): any persisted
 * connector entry under the legacy engram connectors dir means an existing
 * install whose clients may still address engram_* aliases. Missing or
 * unreadable dir means fresh install — no evidence, no aliases.
 */
export function hasLegacyConnectorEntries(): boolean {
  try {
    return fs
      .readdirSync(getConnectorsDir())
      .some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}
