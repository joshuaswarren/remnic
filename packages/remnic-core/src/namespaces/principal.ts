import { resolveNamespaceCapabilities } from "../capabilities.js";
import type { PluginConfig } from "../types.js";
import { isLikelyUnsafeRegex } from "../routing/engine.js";
import { normalizeNamespaceIdentity } from "./identity.js";
const MAX_REGEX_SESSION_KEY_LENGTH = 512;

function compileSafePrincipalRegex(pattern: string): RegExp | null {
  if (isLikelyUnsafeRegex(pattern)) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

export function resolvePrincipal(sessionKey: string | undefined, config: PluginConfig): string | undefined {
  if (!resolveNamespaceCapabilities(config).namespaces) return "default";
  const sk = typeof sessionKey === "string" && sessionKey.trim().length > 0
    ? sessionKey
    : "";
  const mode = config.principalFromSessionKeyMode;
  const rules = config.principalFromSessionKeyRules ?? [];

  if (!sk) return undefined;

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

export function canReadNamespace(principal: string | undefined, namespace: string, config: PluginConfig): boolean {
  if (!resolveNamespaceCapabilities(config).namespaces) return true;
  if (!principal) return false;
  const identity = normalizeNamespaceIdentity(namespace);
  const policy = config.namespacePolicies.find((p) => normalizeNamespaceIdentity(p.name) === identity);
  if (!policy) {
    return identity === normalizeNamespaceIdentity(config.defaultNamespace) ||
      identity === normalizeNamespaceIdentity(config.sharedNamespace);
  }
  return policy.readPrincipals.includes(principal) || policy.readPrincipals.includes("*");
}

export function canWriteNamespace(principal: string | undefined, namespace: string, config: PluginConfig): boolean {
  if (!resolveNamespaceCapabilities(config).namespaces) return true;
  if (!principal) return false;
  const identity = normalizeNamespaceIdentity(namespace);
  const policy = config.namespacePolicies.find((p) => normalizeNamespaceIdentity(p.name) === identity);
  if (!policy) return identity === normalizeNamespaceIdentity(config.defaultNamespace);
  return policy.writePrincipals.includes(principal) || policy.writePrincipals.includes("*");
}

/**
 * Config-time namespace-policy lint (issue #1888 improvement 3). Principal-
 * agnostic mirror of {@link canWriteNamespace}: true when the namespace is
 * writable by AT LEAST ONE principal. When namespace enforcement is off every
 * write is allowed. Otherwise an explicit `namespacePolicies` entry takes
 * precedence (exactly as `canWriteNamespace`): with a matching policy the
 * namespace is covered only if that policy grants at least one non-blank
 * writer — even when the name equals `defaultNamespace`; without a policy it
 * is covered only if it IS the `defaultNamespace`. The `sharedNamespace` is
 * NOT implicitly writable (matching
 * `canWriteNamespace`), and a policy entry with no `writePrincipals` grants
 * nobody. A configured namespace that is NOT covered is writable for no one,
 * so every write to it is rejected by the ACL and dead-lettered — `remnic
 * doctor` warns on that before a session silently loses memory.
 */
export function isNamespacePolicyCovered(namespace: string, config: PluginConfig): boolean {
  if (!resolveNamespaceCapabilities(config).namespaces) return true;
  // An explicit policy wins over the default fallback (exactly as
  // canWriteNamespace), so a policy naming the default with no writers is NOT
  // covered. Only fall back to defaultNamespace when no policy matches.
  const identity = normalizeNamespaceIdentity(namespace);
  const policy = config.namespacePolicies.find((p) => normalizeNamespaceIdentity(p.name) === identity);
  if (!policy) return identity === normalizeNamespaceIdentity(config.defaultNamespace);
  return policy.writePrincipals.some((w) => w.trim().length > 0);
}

/**
 * Default "self" namespace for a principal.
 *
 * Heuristic:
 * - If there's a namespace policy with the same name as the principal, use it.
 * - Otherwise use config.defaultNamespace.
 */
export function defaultNamespaceForPrincipal(principal: string | undefined, config: PluginConfig): string {
  if (!resolveNamespaceCapabilities(config).namespaces) return config.defaultNamespace;
  if (!principal) return config.defaultNamespace;
  const exists = config.namespacePolicies.some(
    (p) => normalizeNamespaceIdentity(p.name) === normalizeNamespaceIdentity(principal),
  );
  return exists ? principal : config.defaultNamespace;
}
export function recallNamespacesForPrincipal(principal: string | undefined, config: PluginConfig): string[] {
  const out: string[] = [];
  if (!resolveNamespaceCapabilities(config).namespaces) return [config.defaultNamespace];
  if (!principal) return out;

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

/**
 * Namespaces a principal may attribute a citation to: the default-recall
 * namespaces, every readable policy namespace, and the readable built-in
 * default/shared namespaces — which `defaultRecallNamespaces` can omit even
 * though `canReadNamespace` grants access (#2020).
 */
export function citationAuthorizedNamespaces(
  principal: string | undefined,
  config: PluginConfig,
): string[] {
  return Array.from(
    new Set([
      ...recallNamespacesForPrincipal(principal, config),
      ...config.namespacePolicies
        .filter((p) => canReadNamespace(principal, p.name, config))
        .map((p) => p.name),
      ...[config.defaultNamespace, config.sharedNamespace].filter((ns) =>
        canReadNamespace(principal, ns, config),
      ),
    ]),
  );
}
