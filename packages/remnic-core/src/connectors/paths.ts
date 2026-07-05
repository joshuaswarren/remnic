import fs from "node:fs";
import path from "node:path";

import { readEnvVar, resolveHomeDir } from "../runtime/env.js";

/**
 * Connector registry directory name. Kept under the canonical `remnic` config
 * root for new installs; legacy installs that still live under `engram` are
 * read-transparent via {@link getActiveConnectorsConfigRoot} (issue #1518).
 */
export const REGISTRY_DIR_NAME = ".remnic-connectors";

/**
 * Legacy registry directory name from the engram era. Used only for the
 * read-fallback so existing installs keep resolving until the user migrates.
 */
export const LEGACY_REGISTRY_DIR_NAME = ".engram-connectors";

/**
 * Config-root segment for the canonical (post-rename) layout. Issue #1518
 * point 6: the path `~/.config/engram/...` is confusing when the product is
 * called Remnic, so new writes land under `remnic/`.
 */
const CONFIG_ROOT_SEGMENT = "remnic";

/**
 * Config-root segment for the legacy engram-era layout. Read-fallback only.
 */
const LEGACY_CONFIG_ROOT_SEGMENT = "engram";

/**
 * Single source of truth for the canonical connectors config root
 * (`$XDG_CONFIG_HOME/remnic` or `~/.config/remnic`). New writes ALWAYS go
 * here. Issue #1527 flagged this derivation as previously duplicated across
 * call sites — add new callers here, never re-derive the path inline.
 */
export function getConnectorsConfigRoot(): string {
  const xdgConfigHome = readEnvVar("XDG_CONFIG_HOME");
  return xdgConfigHome
    ? path.join(xdgConfigHome, CONFIG_ROOT_SEGMENT)
    : path.join(resolveHomeDir(), ".config", CONFIG_ROOT_SEGMENT);
}

/**
 * Legacy config root from the engram era (`$XDG_CONFIG_HOME/engram` or
 * `~/.config/engram`). Exposed for tests and the migration path only —
 * production code should call {@link getActiveConnectorsConfigRoot} so the
 * read-fallback is applied uniformly.
 */
export function getLegacyConnectorsConfigRoot(): string {
  const xdgConfigHome = readEnvVar("XDG_CONFIG_HOME");
  return xdgConfigHome
    ? path.join(xdgConfigHome, LEGACY_CONFIG_ROOT_SEGMENT)
    : path.join(resolveHomeDir(), ".config", LEGACY_CONFIG_ROOT_SEGMENT);
}

/**
 * Read-time fallback: pick the config root that actually holds (or will hold)
 * the connector registry.
 *
 *   1. Canonical `remnic/` root when it already exists (post-migration, or a
 *      fresh install that has already written its first connector).
 *   2. Legacy `engram/` root when ONLY that exists — an existing install we
 *      keep reading in place until the user runs `remnic migrate`.
 *   3. Canonical `remnic/` root otherwise (fresh install with nothing on
 *      disk yet) so the first write lands at the new path.
 *
 * This is a READ-time fallback. Writes go to whichever root this returns, so
 * a legacy install keeps its data colocated for the active session; a fresh
 * install writes straight to `remnic/`.
 */
export function getActiveConnectorsConfigRoot(): string {
  const canonical = getConnectorsConfigRoot();
  if (fs.existsSync(canonical)) return canonical;
  const legacy = getLegacyConnectorsConfigRoot();
  if (fs.existsSync(legacy)) return legacy;
  return canonical;
}

/**
 * Path of the connector registry manifest file. The registry subdir name
 * (`.remnic-connectors` vs the legacy `.engram-connectors`) is chosen from the
 * active root so a pre-rename install reads its existing files without a
 * rename-side migration step (#1518).
 */
export function getRegistryPath(): string {
  const root = getActiveConnectorsConfigRoot();
  const dirName = root === getConnectorsConfigRoot() ? REGISTRY_DIR_NAME : LEGACY_REGISTRY_DIR_NAME;
  return path.join(root, dirName, "registry.json");
}

/**
 * Directory holding one `<connector-id>.json` per installed connector. The
 * registry subdir name follows the active root (see {@link getRegistryPath}).
 */
export function getConnectorsDir(): string {
  const root = getActiveConnectorsConfigRoot();
  const dirName = root === getConnectorsConfigRoot() ? REGISTRY_DIR_NAME : LEGACY_REGISTRY_DIR_NAME;
  return path.join(root, dirName, "connectors");
}

/**
 * Sticky-legacy evidence for `emitLegacyTools` (issue #1550): any persisted
 * connector entry under the active connectors dir means an existing install
 * whose clients may still address engram_* aliases. Missing or unreadable dir
 * means fresh install — no evidence, no aliases.
 *
 * Because {@link getConnectorsDir} applies the engram read-fallback, an
 * unmigrated install still reports its legacy entries here.
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
