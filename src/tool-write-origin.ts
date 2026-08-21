/**
 * Write origin for OpenClaw tool-surface shared-context writes (issue #1957
 * review round 2).
 *
 * The OpenClaw tool surface has exactly one authoritative identity: the
 * registration-scoped runtime agent (`api.runtime.agent.id`, read by
 * `getOpenClawRuntimeAgentId` in `src/index.ts`). It is host-native and
 * cannot be influenced by the model, so it — not `agentAccessHttp.principal`,
 * which belongs to the separate external HTTP bridge — is the envelope origin
 * for a tool write.
 *
 * When the host exposes no runtime agent id (older SDK shapes), the write is
 * REFUSED. The two rejected alternatives are both worse: falling back to the
 * model-supplied `agentId` is the provenance-spoofing hole this fixes, and
 * stamping a reserved placeholder origin would put an unattributable,
 * model-impersonable name into governance frontmatter that downstream
 * authority resolution then treats as a real agent. Refusing keeps the
 * failure loud, local, and least-privileged: nothing is written.
 */

/**
 * Resolve the envelope origin for an OpenClaw tool write, or throw.
 *
 * @param runtimeAgentId Registration-scoped host runtime agent id, if any.
 */
export function requireOpenClawToolWriteOrigin(runtimeAgentId: string | undefined): string {
  const origin = typeof runtimeAgentId === "string" ? runtimeAgentId.trim() : "";
  if (origin.length === 0) {
    throw new Error(
      "refusing the write: this host exposes no runtime agent id, so the shared-context origin cannot be attributed (the caller-supplied agentId is never trusted as provenance)",
    );
  }
  return origin;
}
