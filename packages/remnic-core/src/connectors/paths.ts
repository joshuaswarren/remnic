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
 *   1. Canonical `remnic/` root when its `.remnic-connectors` registry dir
 *      already exists (post-migration, or a fresh install that has already
 *      written its first connector).
 *   2. Legacy `engram/` root when ONLY its `.engram-connectors` registry dir
 *      exists — an existing install we keep reading in place until the user
 *      runs `remnic migrate`.
 *   3. Canonical `remnic/` root otherwise (fresh install with no registry on
 *      disk yet) so the first write lands at the new path.
 *
 * The probe looks for the REGISTRY SUBDIR (`.remnic-connectors` /
 * `.engram-connectors`), not the bare config root. The config root
 * `~/.config/remnic/` is created by unrelated daemon setup (e.g. the daemon's
 * own `config.json`), so probing the bare root would falsely resolve to
 * remnic and hide connector data that still lives under
 * `~/.config/engram/.engram-connectors/` (cursor review round 1, #1620).
 *
 * This is a READ-time fallback. Writes go to whichever root this returns, so
 * a legacy install keeps its data colocated for the active session; a fresh
 * install writes straight to `remnic/`.
 */
export function getActiveConnectorsConfigRoot(): string {
  const canonical = getConnectorsConfigRoot();
  if (fs.existsSync(path.join(canonical, REGISTRY_DIR_NAME))) return canonical;
  const legacy = getLegacyConnectorsConfigRoot();
  if (fs.existsSync(path.join(legacy, LEGACY_REGISTRY_DIR_NAME))) return legacy;
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
 * connector entry under the LEGACY engram registry means an existing install
 * whose clients may still address engram_* aliases. Missing or unreadable
 * legacy dir means fresh install — no evidence, no aliases.
 *
 * Probes ONLY the legacy engram registry (`$XDG_CONFIG_HOME/engram/.engram-connectors`),
 * never the active/canonical root. A fresh post-rename install that just
 * wrote its first connector under `remnic/.remnic-connectors/` is NOT legacy
 * evidence — counting it would flip `resolveEmitLegacyTools` to true and
 * advertise deprecated `engram.*` aliases to users who never had them
 * (#1620 review, codex P2). An unmigrated install still reports its entries
 * here because its data lives under the engram tree.
 */
export function hasLegacyConnectorEntries(): boolean {
  try {
    const legacyDir = path.join(
      getLegacyConnectorsConfigRoot(),
      LEGACY_REGISTRY_DIR_NAME,
      "connectors",
    );
    return fs.readdirSync(legacyDir).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}
