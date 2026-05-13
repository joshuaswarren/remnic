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
