/**
 * Shared-item authority envelope (issue #1957).
 *
 * Pure parse/default/expiry helpers over the authority classes. Binding is
 * never inferred, and the authority token is validated exactly as supplied
 * or stored — a padded value never resolves to a privileged class.
 */

export const SHARED_AUTHORITIES = ["informational", "advisory", "binding"] as const;
export type SharedAuthority = (typeof SHARED_AUTHORITIES)[number];

export interface SharedEnvelope {
  sharedBy?: string;
  authority: SharedAuthority;
  expiresAt?: string;
  supersedes?: string;
}

export interface SharedEnvelopeInput {
  sharedBy?: string;
  authority?: string;
  expiresAt?: string;
  supersedes?: string;
}

export interface ApplyDefaultEnvelopeOptions {
  binding?: boolean;
}

function isSharedAuthority(value: string): value is SharedAuthority {
  return (SHARED_AUTHORITIES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type AuthorityToken =
  | { kind: "absent" }
  | { kind: "invalid"; raw: string }
  | { kind: "valid"; authority: SharedAuthority };

/**
 * Read the authority token EXACTLY as supplied or stored. A padded value
 * such as `" binding "` is malformed data, never a normalized match for a
 * privileged class: trimming first would let stored whitespace resolve as
 * binding/advisory (AGENTS.md rule 45). Only the empty string counts as
 * "unspecified"; whitespace-only is invalid.
 */
function readExactAuthority(value: unknown): AuthorityToken {
  if (typeof value !== "string" || value.length === 0) return { kind: "absent" };
  if (!isSharedAuthority(value)) return { kind: "invalid", raw: value };
  return { kind: "valid", authority: value };
}

function withOptionalFields(
  authority: SharedAuthority,
  source: { sharedBy?: unknown; expiresAt?: unknown; supersedes?: unknown },
): SharedEnvelope {
  const envelope: SharedEnvelope = { authority };
  const sharedBy = optionalString(source.sharedBy);
  const expiresAt = optionalString(source.expiresAt);
  const supersedes = optionalString(source.supersedes);
  if (sharedBy) envelope.sharedBy = sharedBy;
  if (expiresAt) envelope.expiresAt = expiresAt;
  if (supersedes) envelope.supersedes = supersedes;
  return envelope;
}

export function applyDefaultEnvelope(
  input: SharedEnvelopeInput = {},
  options: ApplyDefaultEnvelopeOptions = {},
): SharedEnvelope {
  const requested = readExactAuthority(input.authority);
  if (requested.kind === "invalid") {
    throw new Error(
      `applyDefaultEnvelope: authority must be informational, advisory, or binding; got ${JSON.stringify(requested.raw)}`,
    );
  }
  if (requested.kind === "valid" && requested.authority === "binding" && options.binding !== true) {
    throw new Error("applyDefaultEnvelope: authority \"binding\" requires an explicit binding flag");
  }
  return withOptionalFields(requested.kind === "valid" ? requested.authority : "informational", input);
}

export function parseSharedEnvelope(raw: unknown): SharedEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { authority: "informational" };
  }
  const record = raw as Record<string, unknown>;
  const requested = readExactAuthority(record.authority);
  const authority = requested.kind === "valid" ? requested.authority : "informational";
  return withOptionalFields(authority, record);
}

export function isExpired(envelope: Pick<SharedEnvelope, "expiresAt">, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const expiresAt = envelope.expiresAt?.trim();
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return expiresAtMs <= nowMs;
}
