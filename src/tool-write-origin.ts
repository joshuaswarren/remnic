/**
 * Write origin for OpenClaw tool-surface shared-context writes (issue #1957
 * review rounds 2 and 3).
 *
 * The OpenClaw tool surface has exactly one authoritative identity: the
 * registration-scoped runtime agent (`api.runtime.agent.id`, read by
 * `getOpenClawRuntimeAgentId` in `src/index.ts`). It is host-native and
 * cannot be influenced by the model, so it — not `agentAccessHttp.principal`,
 * which belongs to the separate external HTTP bridge — is the envelope origin
 * for a tool write.
 *
 * `runtime` is optional in the SDK declaration and absent on older hosts
 * inside the supported compatibility window, so round 2's refusal turned a
 * working tool into a permanent error on those hosts. Round 3 stamps
 * `UNATTRIBUTED_TOOL_WRITE_ORIGIN` instead: a reserved class token, not a
 * claim about any agent. It is least-privileged because the model's
 * `agentId` is discarded rather than believed, the token names no agent that
 * could be impersonated, and it carries no privilege — authority resolution
 * reads only the envelope's `authority` field, never its origin.
 *
 * The token can only ever be stamped by this function. When the host DOES
 * expose a runtime agent id, a caller passing the token is a mismatch and
 * `resolveWriteOrigin` rejects it like any other foreign agent id.
 */

/** Reserved origin for a host that exposes no runtime agent id. Names no agent. */
export const UNATTRIBUTED_TOOL_WRITE_ORIGIN = "unattributed:openclaw-host";

/**
 * Resolve the acting agent id and envelope origin for an OpenClaw tool write.
 *
 * @param runtimeAgentId Registration-scoped host runtime agent id, if any.
 * @param requestedAgentId The model-supplied `agentId`. Forwarded only so the
 *   manager can reject a mismatch; never used as the origin.
 */
export function openClawToolWriteOrigin(
  runtimeAgentId: string | undefined,
  requestedAgentId: string,
): { agentId: string; authenticatedIdentity: string } {
  const hostAgentId = typeof runtimeAgentId === "string" ? runtimeAgentId.trim() : "";
  if (hostAgentId.length > 0) {
    return { agentId: requestedAgentId, authenticatedIdentity: hostAgentId };
  }
  return {
    agentId: UNATTRIBUTED_TOOL_WRITE_ORIGIN,
    authenticatedIdentity: UNATTRIBUTED_TOOL_WRITE_ORIGIN,
  };
}
