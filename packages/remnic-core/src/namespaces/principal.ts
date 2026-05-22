import type { PluginConfig } from "../types.js";
import { isLikelyUnsafeRegex } from "../routing/engine.js";

const MAX_REGEX_SESSION_KEY_LENGTH = 512;

function compileSafePrincipalRegex(pattern: string): RegExp | null {
  if (isLikelyUnsafeRegex(pattern)) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function resolvePrincipal(sessionKey: string | undefined, config: PluginConfig): string {
  if (!config.namespacesEnabled) return "default";
  const sk = sessionKey ?? "";
  const mode = config.principalFromSessionKeyMode;
  const rules = config.principalFromSessionKeyRules ?? [];

  if (!sk) return "default";

  if (mode === "prefix") {
    for (const r of rules) {
      if (sk.startsWith(r.match)) return r.principal;
    }
  } else if (mode === "map") {
    for (const r of rules) {
      if (sk === r.match) return r.principal;
    }
  } else if (mode === "regex") {
    if (sk.length <= MAX_REGEX_SESSION_KEY_LENGTH) {
      for (const r of rules) {
        const re = compileSafePrincipalRegex(r.match);
        if (re?.test(sk)) {
          return r.principal;
        }
      }
    }
  }

  // Fallback heuristic: "agent:<agentId>:<channelType>:..."
  const parts = sk.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    const agentId = parts[1];
    if (agentId && agentId.length > 0) return agentId;
  }
  return "default";
}

export function canReadNamespace(principal: string, namespace: string, config: PluginConfig): boolean {
  if (!config.namespacesEnabled) return true;
  const policy = config.namespacePolicies.find((p) => p.name === namespace);
  if (!policy) return namespace === config.defaultNamespace || namespace === config.sharedNamespace;
  return policy.readPrincipals.includes(principal) || policy.readPrincipals.includes("*");
}

export function canWriteNamespace(principal: string, namespace: string, config: PluginConfig): boolean {
  if (!config.namespacesEnabled) return true;
  const policy = config.namespacePolicies.find((p) => p.name === namespace);
  if (!policy) return namespace === config.defaultNamespace;
  return policy.writePrincipals.includes(principal) || policy.writePrincipals.includes("*");
}

/**
 * Default "self" namespace for a principal.
 *
 * Heuristic:
 * - If there's a namespace policy with the same name as the principal, use it.
 * - Otherwise use config.defaultNamespace.
 */
export function defaultNamespaceForPrincipal(principal: string, config: PluginConfig): string {
  if (!config.namespacesEnabled) return config.defaultNamespace;
  const exists = config.namespacePolicies.some((p) => p.name === principal);
  return exists ? principal : config.defaultNamespace;
}

export function recallNamespacesForPrincipal(principal: string, config: PluginConfig): string[] {
  const out: string[] = [];
  if (!config.namespacesEnabled) return [config.defaultNamespace];

  const selfNs = defaultNamespaceForPrincipal(principal, config);
  if (config.defaultRecallNamespaces.includes("self") && canReadNamespace(principal, selfNs, config)) {
    out.push(selfNs);
  }
  if (config.defaultRecallNamespaces.includes("shared") && canReadNamespace(principal, config.sharedNamespace, config)) {
    out.push(config.sharedNamespace);
  }

  for (const p of config.namespacePolicies) {
    if (p.includeInRecallByDefault && canReadNamespace(principal, p.name, config)) {
      if (!out.includes(p.name)) out.push(p.name);
    }
  }

  return out;
}
