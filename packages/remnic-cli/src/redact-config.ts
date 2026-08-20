/**
 * Key-based secret redaction for operator-facing config diagnostics
 * (CodeQL js/clear-text-logging on the codegraph/export-okf commands).
 *
 * Redaction is by KEY NAME, applied recursively: any field whose name matches
 * the secret-bearing pattern is replaced with a marker before the value can
 * reach console output. A newly added key (e.g. `anthropicApiKey`) is covered
 * by construction — the pattern matches key names, never serialized values,
 * so there is no per-key literal to forget. The pattern mirrors
 * SENSITIVE_KEY_RE in @remnic/core admin-surfaces (the reviewed in-repo
 * convention for credential-bearing field names).
 *
 * Input must be JSON-serializable; both call sites pass JSON.parse output, so
 * it is acyclic by construction.
 */
const SECRET_KEY_RE =
  /(token|secret|password|api[_-]?key|bearer|authorization|credential|private[_-]?key)/i;

const REDACTED_VALUE = "[redacted]";

export function redactConfigForLog<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value !== "object" || value === null) return value;
  // Object.create(null): a JSON-parsed `__proto__` key must stay an own
  // property instead of reassigning the prototype during the copy.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, nested] of Object.entries(value)) {
    out[key] = SECRET_KEY_RE.test(key) ? REDACTED_VALUE : redact(nested);
  }
  return out;
}
