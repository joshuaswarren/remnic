/**
 * Merge vault note frontmatter keys (issue #1985).
 *
 * Pure string helper. Empty updates leave the original YAML unchanged.
 * Listed keys stay. Output keys are sorted. Keys with newlines are rejected.
 */

function assertNoNewlineKey(key: string): void {
  if (key.includes("\n") || key.includes("\r")) {
    throw new RangeError("Vault frontmatter keys must not contain newlines.");
  }
}

export function applyVaultFrontmatter(
  existingYaml: string,
  updates: Readonly<Record<string, string>>,
): string {
  const entries = Object.entries(updates);
  if (entries.length === 0) return existingYaml;

  const merged = new Map<string, string>();
  for (const line of existingYaml.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (key.length === 0) continue;
    assertNoNewlineKey(key);
    merged.set(key, line.slice(idx + 1).trim());
  }
  for (const [key, value] of entries) {
    assertNoNewlineKey(key);
    merged.set(key, value);
  }

  return [...merged.keys()]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${key}: ${merged.get(key)}`)
    .join("\n");
}

/**
 * Frontmatter property boundary for the vault publisher (issue #2917).
 *
 * Property values written into note frontmatter must be single-line
 * plain YAML scalars (or lists of them) whose rendered `key: value` line
 * cannot change shape or inject keys when a YAML parser reads the note
 * back. Validation is pure and total; the publisher runs it before any
 * note byte is read or written, so a rejection can never leave a
 * half-merged note behind.
 */

/** A supported property value: one plain scalar, or a list of them. */
export type VaultPropertyValue = string | readonly string[];

export const VAULT_PROPERTY_KEY_MAX_CHARS = 64;
export const VAULT_PROPERTY_SCALAR_MAX_CHARS = 200;
export const VAULT_PROPERTY_LIST_MAX_ITEMS = 20;
export const VAULT_PROPERTY_TOTAL_MAX_CHARS = 2_000;

// C0 controls, DEL, and C1 controls. Covers \n, \r, \t — a newline is the
// frontmatter-injection primitive (`v\ninjected: yes` becomes a new key).
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Characters that make the first character a YAML indicator. `-`, `?`,
// and `:` only indicate when followed by a space, so `-5` stays a plain
// scalar while `- 5` does not.
const INDICATOR_CHARS = ",[]{}#&*!|>'\"%@`";
// Interior shapes that end a plain scalar or start a comment.
const INJECTION_RE = /: | #/;

export type ValidateVaultPropertyResult = { ok: true } | { ok: false; reason: string };

/** Render a validated value the way `mergeFrontmatterKeys` writes it. */
export function renderVaultPropertyValue(value: VaultPropertyValue): string {
  return typeof value === "string" ? value : `[${value.join(", ")}]`;
}

function validateScalar(value: string, label: string): ValidateVaultPropertyResult {
  if (value.length === 0) {
    return { ok: false, reason: `${label} must not be empty` };
  }
  if (value.length > VAULT_PROPERTY_SCALAR_MAX_CHARS) {
    return { ok: false, reason: `${label} exceeds ${VAULT_PROPERTY_SCALAR_MAX_CHARS} characters` };
  }
  if (CONTROL_RE.test(value)) {
    return { ok: false, reason: `${label} must not contain control characters or line breaks` };
  }
  if (value !== value.trim()) {
    return { ok: false, reason: `${label} must not carry leading or trailing whitespace` };
  }
  const first = value[0]!;
  const spacedIndicator = "-?:".includes(first) && value[1] === " ";
  if (INDICATOR_CHARS.includes(first) || spacedIndicator) {
    return { ok: false, reason: `${label} must be a plain scalar (leading "${first}" changes its YAML shape)` };
  }
  if (INJECTION_RE.test(value)) {
    return { ok: false, reason: `${label} must not contain ": " or " #"` };
  }
  if (value.endsWith(":")) {
    return { ok: false, reason: `${label} must not end with ":"` };
  }
  return { ok: true };
}

/**
 * Validate the final (already-prefixed) property set a publish would
 * write: key shape, per-value scalar/list shape, per-value bounds, and
 * the total rendered size across every entry.
 */
export function validateVaultProperties(
  entries: ReadonlyArray<{ key: string; value: VaultPropertyValue }>,
): ValidateVaultPropertyResult {
  let total = 0;
  for (const { key, value } of entries) {
    if (key.length === 0) {
      return { ok: false, reason: "property keys must not be empty" };
    }
    if (key.length > VAULT_PROPERTY_KEY_MAX_CHARS) {
      return { ok: false, reason: `property key exceeds ${VAULT_PROPERTY_KEY_MAX_CHARS} characters` };
    }
    if (CONTROL_RE.test(key) || key !== key.trim() || key.includes(":") || key.includes("#")) {
      return { ok: false, reason: `property key ${JSON.stringify(key)} is not a plain mapping key` };
    }
    if (typeof value === "string") {
      const scalar = validateScalar(value, `property ${key}`);
      if (!scalar.ok) return scalar;
    } else {
      if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, reason: `property ${key} must be a scalar string or a non-empty list of scalar strings` };
      }
      if (value.length > VAULT_PROPERTY_LIST_MAX_ITEMS) {
        return { ok: false, reason: `property ${key} exceeds ${VAULT_PROPERTY_LIST_MAX_ITEMS} list items` };
      }
      for (const item of value) {
        if (typeof item !== "string") {
          return { ok: false, reason: `property ${key} must be a scalar string or a list of scalar strings` };
        }
        const scalar = validateScalar(item, `property ${key} list item`);
        if (!scalar.ok) return scalar;
        // Lists render in flow form `[a, b]`; a bare separator inside an
        // item would split or close the sequence on re-read.
        if (/[[\],]/.test(item)) {
          return { ok: false, reason: `property ${key} list item must not contain "[", "]", or ","` };
        }
      }
    }
    total += key.length + 2 + renderVaultPropertyValue(value).length;
    if (total > VAULT_PROPERTY_TOTAL_MAX_CHARS) {
      return {
        ok: false,
        reason: `frontmatter properties exceed the ${VAULT_PROPERTY_TOTAL_MAX_CHARS}-character total`,
      };
    }
  }
  return { ok: true };
}
