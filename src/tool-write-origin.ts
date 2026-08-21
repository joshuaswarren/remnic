/**
 * Write origin for OpenClaw tool-surface shared-context writes (issue #1957
 * review rounds 2-4).
 *
 * The OpenClaw tool surface has exactly one authoritative identity: the
 * registration-scoped runtime agent (`api.runtime.agent.id`, read by
 * `getOpenClawRuntimeAgentId` in `src/index.ts`). It is host-native and
 * cannot be influenced by the model, so it — not `agentAccessHttp.principal`,
 * which belongs to the separate external HTTP bridge — is the envelope origin
 * for a tool write.
 *
 * `runtime` is optional in the SDK declaration and absent on older hosts
 * inside the supported compatibility window. There the origin is
 * `UNATTRIBUTED_TOOL_WRITE_ORIGIN`: a reserved class token, not a claim about
 * any agent. It is least-privileged because it names no agent that could be
 * impersonated and carries no privilege — authority resolution reads only the
 * envelope's `authority` field, never its origin.
 *
 * Origin and producer are DIFFERENT fields (round 4). The token is stamped
 * only as the governance origin (`sharedBy`). The model-supplied `agentId`
 * stays the producer identity — the `agent` frontmatter, the on-disk
 * segment, and the cross-signals grouping key. Collapsing the producer onto
 * the token instead assigned every writer the same agent, so
 * `synthesizeCrossSignals` saw one producer and multi-agent overlaps
 * (agentCount >= 2) vanished.
 *
 * The token can only ever be stamped as an origin by this path. When the host
 * DOES expose a runtime agent id, a caller passing the token is a mismatch
 * and `resolveWriteOrigin` rejects it like any other foreign agent id.
 */

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
