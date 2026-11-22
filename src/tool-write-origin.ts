
/** Reserved origin for a host that exposes no runtime agent id. Names no agent. */
export const UNATTRIBUTED_TOOL_WRITE_ORIGIN = "unattributed:openclaw-host";

/**
 * Resolve the producer identity and envelope origin for an OpenClaw tool
 * write.
 *
 * @param runtimeAgentId Registration-scoped host runtime agent id, if any.
 * @param requestedAgentId The model-supplied `agentId`. With a runtime id it
 *   must match (or be blank); without one it is kept as the producer label
 *   and never becomes the origin.
 */
export function openClawToolWriteOrigin(
  runtimeAgentId: string | undefined,
  requestedAgentId: string,
): { agentId: string; authenticatedIdentity?: string; unattributedOrigin?: string } {
  const hostAgentId = typeof runtimeAgentId === "string" ? runtimeAgentId.trim() : "";
  if (hostAgentId.length > 0) {
    return { agentId: requestedAgentId, authenticatedIdentity: hostAgentId };
  }
  return { agentId: requestedAgentId, unattributedOrigin: UNATTRIBUTED_TOOL_WRITE_ORIGIN };
}
