/**
 * Session-namespace resolution for the delegate hook paths (issue #2120).
 *
 * Recall, observe, and the lifecycle flushes all have to answer the same
 * question — "which namespace is this session bound to?" — from a host event
 * that may or may not carry one, a durable binding history, and the daemon's
 * own default. Keeping that in one module is what stops the three paths from
 * drifting apart, and from drifting away from the memory-slot search that
 * resolves the same way.
 */

import {
  SESSION_NAMESPACE_BINDING_MAX_NAMESPACE_LENGTH,
  SESSION_NAMESPACE_BINDING_MAX_NAMESPACES,
  type SessionNamespaceBindingStore,
} from "@remnic/core/session-namespace-bindings";
import { log } from "@remnic/core/logger";

export async function withNamespace(
  namespace: string | undefined,
  body: Record<string, unknown>,
  daemonDefaultNamespace: () => Promise<string | undefined>,
): Promise<Record<string, unknown>> {
  // An ABSENT namespace is a principal-wide fan-out to the daemon, not "the
  // default scope", so fall back to the daemon's concrete default exactly as
  // the memory-slot search does. Otherwise prompt recall would range wider
  // than tool search on the same session.
  const scoped = namespace || (await daemonDefaultNamespace());
  return scoped === undefined ? body : { ...body, namespace: scoped };
}

interface ExplicitSessionNamespace {
  namespace: string | undefined;
}

export function explicitSessionNamespaceFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): ExplicitSessionNamespace | undefined {
  const eventSessionKey = typeof event.sessionKey === "string" ? event.sessionKey : undefined;
  const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
  const sources =
    eventSessionKey === sessionKey
      ? [event, ctx]
      : ctxSessionKey === sessionKey
        ? [ctx, event]
        : [ctx, event];
  for (const source of sources) {
    const sourceSessionKey = typeof source.sessionKey === "string" ? source.sessionKey : undefined;
    if (sourceSessionKey !== sessionKey) continue;
    const runtime = source.runtime;
    if (typeof runtime !== "object" || runtime === null) continue;
    const agent = (runtime as Record<string, unknown>).agent;
    if (typeof agent !== "object" || agent === null) continue;
    const session = (agent as Record<string, unknown>).session;
    if (typeof session !== "object" || session === null) continue;
    const namespace = (session as Record<string, unknown>).namespace;
    if (namespace !== undefined && typeof namespace !== "string") {
      throw new Error("delegate session namespace metadata must be a string");
    }
    return { namespace: typeof namespace === "string" ? namespace.trim() || undefined : undefined };
  }
  return undefined;
}

export async function rememberedNamespacesFor(
  sessionKey: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<string[]> {
  return namespaceBindings.namespacesFor(sessionKey);
}

export async function rememberNamespace(
  sessionKey: string,
  namespace: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<void> {
  if (namespace.length > SESSION_NAMESPACE_BINDING_MAX_NAMESPACE_LENGTH) {
    throw new Error(
      `delegate session namespace exceeds the daemon limit of ${SESSION_NAMESPACE_BINDING_MAX_NAMESPACE_LENGTH} characters`,
    );
  }
  try {
    await namespaceBindings.remember(sessionKey, namespace);
  } catch (err) {
    log.warn(`delegate namespace binding persistence failed: ${String(err)}`);
    throw err;
  }
}

export async function sessionNamespaceFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  fallback: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<string | undefined> {
  const explicit = explicitSessionNamespaceFrom(sessionKey, event, ctx);
  if (explicit !== undefined) {
    await rememberNamespace(sessionKey, explicit.namespace ?? "", namespaceBindings);
    return explicit.namespace;
  }
  const remembered = await rememberedNamespacesFor(sessionKey, namespaceBindings);
  return remembered.length > 0 ? remembered.at(-1) || undefined : fallback.trim() || undefined;
}

export async function lifecycleSessionNamespacesFrom(
  sessionKey: string,
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  fallback: string,
  namespaceBindings: SessionNamespaceBindingStore,
): Promise<Array<string | undefined>> {
  const explicit = explicitSessionNamespaceFrom(sessionKey, event, ctx);
  if (explicit !== undefined) {
    await rememberNamespace(sessionKey, explicit.namespace ?? "", namespaceBindings);
  }
  const remembered = await rememberedNamespacesFor(sessionKey, namespaceBindings);
  if (explicit !== undefined) {
    const explicitNamespace = explicit.namespace ?? "";
    const namespaces = remembered.includes(explicitNamespace)
      ? remembered
      : [...remembered, explicitNamespace];
    return namespaces.map((namespace) => namespace || undefined);
  }
  if (remembered.length > 0) return remembered.map((namespace) => namespace || undefined);
  return [fallback.trim() || undefined];
}
