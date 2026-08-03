/**
 * Installed daemon service units: where they live, and what they say.
 *
 * Split from `bridge.ts` so the endpoint DISCOVERY (filesystem walk, load-path
 * precedence, drop-in merge) stays separate from the mode resolution that
 * consumes it. The pure directive PARSING lives in `bridge-service-units.ts`,
 * which this module drives.
 */

import fs from "node:fs";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

import { resolveSystemUnitSources, resolveUnitEndpoint } from "./bridge-service-units.js";

function resolveHomeDir(): string {
  const env = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)?.["env"];
  const home = env?.["HOME"] ?? env?.["USERPROFILE"];
  return home !== undefined && home.trim() !== "" ? expandTildePath(home) : "";
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

const LAUNCHD_SERVICE_PATHS = [
  ["Library", "LaunchAgents", "ai.remnic.daemon.plist"],
  ["Library", "LaunchAgents", "ai.remnic.server.plist"],
  ["Library", "LaunchAgents", "ai.engram.daemon.plist"],
] as const;
const SYSTEMD_UNIT_NAMES = ["remnic.service", "engram.service"] as const;

/**
 * The USER unit search path (systemd.unit(5), `systemd-analyze unit-paths
 * --user`), in ASCENDING precedence. A unit installed system-wide for user
 * managers — `/usr/lib/systemd/user` and friends — is run by systemd exactly
 * like a per-user one, so omitting those directories hid the daemon's endpoint
 * from detection entirely.
 */
export function systemdUserUnitDirs(homeDir: string): string[] {
  const env = (globalThis.process as { env?: Record<string, string | undefined> } | undefined)?.["env"];
  const xdgConfig = env?.["XDG_CONFIG_HOME"];
  const xdgData = env?.["XDG_DATA_HOME"];
  const underHome = (...segments: string[]): string => path.join(homeDir, ...segments);
  // systemd.unit's user search path, LOWEST precedence first. The data
  // directory sits BELOW `/run` and `/etc`, not above them: `/etc/systemd/user`
  // is an administrator override and outranks anything a package dropped in
  // `~/.local/share`.
  return [
    "/usr/lib/systemd/user",
    "/usr/local/lib/systemd/user",
    xdgData !== undefined && xdgData.trim() !== ""
      ? path.join(expandTildePath(xdgData), "systemd", "user")
      : underHome(".local", "share", "systemd", "user"),
    "/run/systemd/user",
    "/etc/systemd/user",
    xdgConfig !== undefined && xdgConfig.trim() !== ""
      ? path.join(expandTildePath(xdgConfig), "systemd", "user")
      : underHome(".config", "systemd", "user"),
  ];
}
// A packaged fleet install commonly runs the daemon as a SYSTEM unit rather
// than a per-user one, so a home-relative scan alone misses it and auto mode
// would never probe (issue #2120).
// systemd's unit load path for SYSTEM units, in ASCENDING precedence. The base
// unit is the highest-precedence file that exists; drop-ins are collected from
// every directory, because `systemctl edit` writes its override under `/etc`
// even when the packaged unit lives under `/usr/lib`.
// The system unit search path from systemd.unit(5), in ASCENDING precedence.
// `systemd-analyze unit-paths` on a current release lists all of these; the
// `/usr/local` pair in particular is where a locally built daemon lands, and
// skipping it left `auto` unable to see a running same-corpus service.
// `/lib/...` is the merged-/usr symlink of `/usr/lib/...` on most systems and
// is kept for distributions where it is not.
export const SYSTEMD_SYSTEM_UNIT_DIRS = [
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
  "/usr/local/lib/systemd/system",
  "/run/systemd/system",
  "/etc/systemd/system",
] as const;
const SYSTEMD_SYSTEM_UNIT_NAMES = SYSTEMD_UNIT_NAMES;

/**
 * Drop-in fragments for a unit, in systemd's own lexical order.
 *
 * Appended AFTER the base so a later assignment wins, which matches how
 * systemd merges them for the directives read here (`Environment=`,
 * `ExecStart=`, `WorkingDirectory=`) — the parsers already take the last
 * occurrence. A drop-in that RESETS a directive (`Environment=` with no
 * value, `ExecStart=` empty) lands as a blank assignment, which the parsers
 * already treat as present-but-empty.
 */
function readUnitDropIns(dropInDirs: readonly string[]): string[] {
  // A drop-in NAME is applied once: when the same filename exists in several
  // load-path directories, the highest-precedence copy replaces the others
  // rather than adding a second fragment. `dropInDirs` is in ascending
  // precedence, so a later directory simply overwrites the entry.
  const byName = new Map<string, string>();
  for (const dropInDir of dropInDirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dropInDir);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.endsWith(".conf"))) {
      try {
        byName.set(entry, fs.readFileSync(path.join(dropInDir, entry), "utf8"));
      } catch {
        // An unreadable fragment contributes nothing; the base still applies.
      }
    }
  }
  // `readdir` order is not guaranteed; systemd applies drop-ins by sorted name.
  return [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, body]) => body);
}

/** Enough to resolve a unit's EFFECTIVE contents again, later. */
export interface DaemonUnitSource {
  unitPath: string;
  dropInDirs: readonly string[];
  userScoped: boolean;
}

/** A unit's effective text: base plus every applicable drop-in, merged. */
function readUnitText(source: DaemonUnitSource): string | undefined {
  if (!fileExists(source.unitPath)) return undefined;
  let unit: string;
  try {
    unit = fs.readFileSync(source.unitPath, "utf8");
  } catch {
    return undefined;
  }
  // `systemctl edit` puts overrides in `<unit>.d/*.conf`, and the EFFECTIVE
  // configuration is the base plus those drop-ins. Reading only the base
  // would probe a stale endpoint on any unit an administrator customized.
  return [unit, ...readUnitDropIns(source.dropInDirs)].join("\n");
}

/**
 * A unit's credential, read FRESH.
 *
 * Delegate requests call this per request rather than reusing the value
 * detection succeeded with: an administrator who rotates the token in the
 * unit (or its drop-in, or its `EnvironmentFile=`) and restarts the daemon
 * would otherwise 401 every delegated route until the gateway restarted too.
 */
export function readUnitAuthToken(
  source: DaemonUnitSource,
): { readable: true; token: string | undefined } | { readable: false } {
  const unit = readUnitText(source);
  // The two outcomes are NOT the same. A unit this process can no longer read
  // proves nothing, so the caller keeps the credential that last worked. A
  // readable unit that supplies no token is a deliberate removal: the daemon
  // has fallen back to its config or token store, and so must the caller.
  if (unit === undefined) return { readable: false };
  return {
    readable: true,
    token: resolveUnitEndpoint(unit, {
      userScoped: source.userScoped,
      homeDir: resolveHomeDir(),
    }).authToken,
  };
}

/** Every installed unit's endpoint hints, in discovery order. */
export function readServiceEndpoints(): Array<{
  configPath?: string;
  host?: string;
  port?: number;
  authToken?: string;
  authTokenUnit?: DaemonUnitSource;
}> {
  const homeDir = resolveHomeDir();
  const unitPaths: Array<{
    unitPath: string;
    dropInDirs: readonly string[];
    userScoped: boolean;
  }> = [
    ...LAUNCHD_SERVICE_PATHS.map((segments) => {
      const unitPath = path.join(homeDir, ...segments);
      return { unitPath, dropInDirs: [`${unitPath}.d`], userScoped: true };
    }),
    // User units follow the same load-path rules as system ones: highest
    // precedence file wins, drop-ins collected from every directory.
    ...resolveSystemUnitSources(
      systemdUserUnitDirs(homeDir),
      SYSTEMD_UNIT_NAMES,
      fileExists,
    ).map((source) => ({ ...source, userScoped: true })),
    // For a SYSTEM unit the base file and its overrides can live in different
    // load-path directories: a packaged unit under `/usr/lib` customized by
    // `systemctl edit`, which writes `/etc/systemd/system/<unit>.d/*.conf`.
    ...resolveSystemUnitSources(SYSTEMD_SYSTEM_UNIT_DIRS, SYSTEMD_SYSTEM_UNIT_NAMES, fileExists).map(
      (source) => ({ ...source, userScoped: false }),
    ),
  ];
  // EVERY distinct unit, not the first: canonical and legacy units coexist
  // during migration, and the inactive one can sort first. Stopping there
  // would hide the running daemon's endpoint from the candidate walk.
  const endpoints: Array<{
    configPath?: string;
    host?: string;
    port?: number;
    authToken?: string;
    authTokenUnit?: DaemonUnitSource;
  }> = [];
  for (const source of unitPaths) {
    const { userScoped } = source;
    const unit = readUnitText(source);
    if (unit === undefined) continue;
    const resolved = resolveUnitEndpoint(unit, { userScoped, homeDir });
    if (
      resolved.configPath === undefined &&
      resolved.host === undefined &&
      resolved.port === undefined &&
      resolved.authToken === undefined
    ) {
      continue;
    }
    const seen = endpoints.some(
      (entry) =>
        entry.configPath === resolved.configPath &&
        entry.host === resolved.host &&
        entry.port === resolved.port &&
        entry.authToken === resolved.authToken &&
        // The UNIT is part of the identity now that credentials are re-read
        // from it per request. Canonical and legacy units can start out
        // identical while either is the active service; dropping the second
        // would pin refresh to a unit that may never change again while the
        // active one rotates its token.
        entry.authTokenUnit?.unitPath === source.unitPath,
    );
    if (!seen) {
      endpoints.push(
        // The unit is remembered ONLY when it is the credential's source, so a
        // rotation can be re-read from the same file per request.
        resolved.authToken === undefined
          ? resolved
          : { ...resolved, authTokenUnit: { ...source, dropInDirs: [...source.dropInDirs] } },
      );
    }
  }
  return endpoints;
}

/** Whether ANY daemon service unit is installed for this account or host. */
export function isDaemonServiceConfigured(): boolean {
  const homeDir = resolveHomeDir();
  for (const segments of LAUNCHD_SERVICE_PATHS) {
    if (fileExists(path.join(homeDir, ...segments))) return true;
  }
  return [...systemdUserUnitDirs(homeDir), ...SYSTEMD_SYSTEM_UNIT_DIRS].some((dir) =>
    SYSTEMD_UNIT_NAMES.some((name) => fileExists(path.join(dir, name))),
  );
}

