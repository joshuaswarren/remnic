import os from "node:os";
import path from "node:path";

import { expandTildePath } from "@remnic/core";

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
 * Resolve the omp (oh-my-pi) agent home directory.
 *
 * Mirrors omp's own `getAgentDir()` resolution (docs/config-usage.md):
 *   1. `PI_CODING_AGENT_DIR` is an explicit override shared with upstream Pi.
 *   2. A named profile (`OMP_PROFILE`, falling back to `PI_PROFILE`) resolves to
 *      `~/.omp/profiles/<name>/agent`. The reserved name "default" is the base.
 *   3. Otherwise the base agent dir is `~/.omp/agent`.
 */
export function resolveOmpAgentHome(env: NodeJS.ProcessEnv): string {
  const explicitCodingAgentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (explicitCodingAgentDir) return path.resolve(expandTildePath(explicitCodingAgentDir));

  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const ompHome = path.join(home, ".omp");

  const profile = (env.OMP_PROFILE ?? env.PI_PROFILE)?.trim();
  if (profile && profile !== "default") {
    return path.join(ompHome, "profiles", profile, "agent");
  }

  return path.join(ompHome, "agent");
}

export function resolveOmpExtensionRoot(env: NodeJS.ProcessEnv): string {
  return path.join(resolveOmpAgentHome(env), "extensions", REMNIC_PI_EXTENSION_DIR_NAME);
}
