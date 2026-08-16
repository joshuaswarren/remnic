import { namespaceIdentityToken } from "../namespaces/identity.js";
import type { MemoryCategory } from "../types.js";

export type RoutePatternType = "regex" | "keyword";

export interface RouteTarget {
  category?: MemoryCategory;
  namespace?: string;
}

export interface RouteRule {
  id: string;
  patternType: RoutePatternType;
  pattern: string;
  priority: number;
  target: RouteTarget;
  enabled?: boolean;
}

export interface RoutingEngineOptions {
  allowedNamespaces?: string[];
  allowedCategories?: MemoryCategory[];
}

export interface RouteSelection {
  rule: RouteRule;
  target: RouteTarget;
}

const DEFAULT_CATEGORIES: readonly MemoryCategory[] = [
  "fact",
  "preference",
  "correction",
  "entity",
  "decision",
  "relationship",
  "principle",
  "commitment",
  "moment",
  "skill",
  "rule",
  "procedure",
  "reasoning_trace",
] as const;

function normalizeNamespace(namespace: string): string {
  return namespace.normalize("NFC");
}

const SAFE_ROUTE_NAMESPACE_CHARS = /^[\p{L}\p{M}\p{N}._-]+$/u;

export function isLikelyUnsafeRegex(pattern: string): boolean {
  const value = pattern.trim();
  if (value.length === 0) return true;
  if (value.length > 120) return true;
  if (/\\[1-9]/.test(value)) return true; // backreferences
  if (/\(\?<?[=!]/.test(value)) return true; // lookaround assertions
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(value)) return true; // nested quantifiers
  // Conservative fail-closed guardrail: grouped/alternation regexes are user-configurable and can be expensive.
  if (/(^|[^\\])[()|]/.test(value)) return true;
  // Multiple quantifiers in one user pattern are high risk for catastrophic backtracking on non-matches.
  const quantifierCount =
    (value.match(/(^|[^\\])[*+?]/g)?.length ?? 0) +
    (value.match(/(^|[^\\])\{/g)?.length ?? 0);
  if (quantifierCount > 1) return true;
  return false;
}

export function isSafeRouteNamespace(namespace: string): boolean {
  const value = normalizeNamespace(namespace);
  // The route limit is 64 Unicode code points. On-disk identity tokens may
  // exceed 64 characters because namespaceIdentityToken hex-encodes UTF-8.
  // A route can use at most 64 code points, but the reversible on-disk token
  // must also fit one filesystem component (255 characters).
  if (value.length === 0) return false;
  if (Array.from(value).length > 64) return false;
  if (namespaceIdentityToken(value).length > 255) return false;
  if (value === ".") return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (value.includes("..")) return false;
  return SAFE_ROUTE_NAMESPACE_CHARS.test(value);
}

export function validateRouteTarget(target: RouteTarget | null | undefined, options?: RoutingEngineOptions): {
  ok: boolean;
  error?: string;
  target?: RouteTarget;
} {
  if (!target || typeof target !== "object") {
    return { ok: false, error: "target must be an object" };
  }

  const allowedCategories = new Set(options?.allowedCategories ?? DEFAULT_CATEGORIES);
  const allowedNamespaces = options?.allowedNamespaces
    ? new Set(options.allowedNamespaces.map((v) => normalizeNamespace(v.trim())).filter((v) => v.length > 0))
    : null;

  const normalized: RouteTarget = {};

  if (typeof target.category === "string") {
    if (!allowedCategories.has(target.category)) {
      return { ok: false, error: `invalid category: ${target.category}` };
    }
    normalized.category = target.category;
  }

  if (typeof target.namespace === "string") {
    const namespace = normalizeNamespace(target.namespace);
    if (!isSafeRouteNamespace(namespace)) {
      return { ok: false, error: `invalid namespace: ${target.namespace}` };
    }
    if (allowedNamespaces && !allowedNamespaces.has(namespace)) {
      return { ok: false, error: `namespace not allowed: ${namespace}` };
    }
    normalized.namespace = namespace;
  }

  if (!normalized.category && !normalized.namespace) {
    return { ok: false, error: "target must include category or namespace" };
  }

  return { ok: true, target: normalized };
}

export function doesRuleMatch(rule: RouteRule, text: string): boolean {
  if (!rule || typeof rule !== "object") return false;
  if (rule.enabled === false) return false;
  if (typeof rule.pattern !== "string") return false;
  const pattern = rule.pattern.trim();
  if (pattern.length === 0) return false;

  if (rule.patternType === "keyword") {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
  if (rule.patternType !== "regex") {
    return false;
  }

  if (isLikelyUnsafeRegex(pattern)) {
    return false;
  }

  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

export function selectRouteRule(text: string, rules: RouteRule[], options?: RoutingEngineOptions): RouteSelection | null {
  const ranked = rules
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
      return a.index - b.index;
    });

  for (const entry of ranked) {
    if (!doesRuleMatch(entry.rule, text)) continue;

    const validation = validateRouteTarget(entry.rule.target, options);
    if (!validation.ok || !validation.target) continue;

    return {
      rule: entry.rule,
      target: validation.target,
    };
  }

  return null;
}
