import os from "node:os";
import path from "node:path";

// Leaf submodule (not the `@remnic/core` barrel) so the omp pre-bundle's
// `bun build` does not pull the rest of core into the extension bundle.
import { expandTildePath } from "@remnic/core/utils/path";

export const REMNIC_PI_EXTENSION_DIR_NAME = "remnic";

export function resolvePiAgentHome(env: NodeJS.ProcessEnv): string {
  const explicitCodingAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (explicitCodingAgentDir) return path.resolve(expandTildePath(explicitCodingAgentDir));

  const explicitAgentHome = env.PI_AGENT_HOME?.trim();
  if (explicitAgentHome) return path.resolve(expandTildePath(explicitAgentHome));

  const explicitPiHome = env.PI_HOME?.trim();
  if (explicitPiHome) return path.join(path.resolve(expandTildePath(explicitPiHome)), "agent");

  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".pi", "agent");
}

export function resolvePiExtensionRoot(env: NodeJS.ProcessEnv): string {
  return path.join(resolvePiAgentHome(env), "extensions", REMNIC_PI_EXTENSION_DIR_NAME);
}

/**
 * Resolve the active omp profile from the environment, mirroring omp's
 * `resolveProfileEnv`: `OMP_PROFILE` is authoritative, and `PI_PROFILE` is a
 * compatibility fallback consulted **only** when `OMP_PROFILE` is undefined
 * (an explicitly-empty `OMP_PROFILE` therefore selects the default profile).
 * The reserved name "default" and blank values resolve to the base (no profile).
 */
function resolveOmpProfile(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  return trimmed;
}

/**
 * Resolve the omp (oh-my-pi) agent home directory that omp auto-discovers
 * extensions from. Mirrors omp's `DirResolver` (packages/utils/src/dirs.ts):
 *
 *   - The config dir name is `PI_CONFIG_DIR` (default `.omp`).
 *   - When a profile (`OMP_PROFILE`, falling back to `PI_PROFILE`) is active it
 *     wins and resolves to `<configRoot>/profiles/<name>/agent`; omp discards
 *     the `PI_CODING_AGENT_DIR` override while a profile is active.
 *   - Otherwise `PI_CODING_AGENT_DIR` overrides the whole agent dir.
 *   - Otherwise the base agent dir is `<configRoot>/agent`.
 *
 * Note: omp's XDG redirection (`XDG_DATA_HOME`, etc.) applies to the `data`,
 * `state`, and `cache` categories (sessions/state/cache) — NOT to the base
 * agent dir that extensions are discovered from — so it is intentionally not
 * consulted here.
 */
/**
 * The omp config root (`~/<PI_CONFIG_DIR or .omp>`), which contains the base
 * `agent/` dir and any `profiles/<name>/agent/` dirs.
 */
export function resolveOmpConfigRoot(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const configDirName = env.PI_CONFIG_DIR?.trim() || ".omp";
  return path.join(home, configDirName);
}

export function resolveOmpAgentHome(env: NodeJS.ProcessEnv): string {
  const configRoot = resolveOmpConfigRoot(env);

  const profile = resolveOmpProfile(env);
  if (profile) {
    return path.join(configRoot, "profiles", profile, "agent");
  }

  const explicitCodingAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (explicitCodingAgentDir) return path.resolve(expandTildePath(explicitCodingAgentDir));

  return path.join(configRoot, "agent");
}

export function resolveOmpExtensionRoot(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOmpAgentHome(env), "extensions", REMNIC_PI_EXTENSION_DIR_NAME);
}

/**
 * Prime Agent agent home (a Pi-fork coding agent). Honors only
 * `PRIME_AGENT_CODING_AGENT_DIR`; the Pi-family env vars (`PI_CODING_AGENT_DIR`,
 * `PI_CONFIG_DIR`, …) deliberately do NOT apply — Prime Agent is a separate
 * install tree at `~/.prime/agent`.
 */
export function resolvePrimeAgentAgentHome(env: NodeJS.ProcessEnv): string {
  const explicitCodingAgentDir = env.PRIME_AGENT_CODING_AGENT_DIR?.trim();
  if (explicitCodingAgentDir) {
    return path.resolve(expandTildePath(explicitCodingAgentDir));
  }
  return path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".prime", "agent");
}

export function resolvePrimeAgentExtensionRoot(env: NodeJS.ProcessEnv): string {
  return path.join(resolvePrimeAgentAgentHome(env), "extensions", REMNIC_PI_EXTENSION_DIR_NAME);
}
