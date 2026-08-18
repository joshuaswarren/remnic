/**
 * Shared-item authority envelope (issue #1957).
 *
 * First slice: parse + default + expiry only. Write-path wiring and
 * curation come later. Binding is never inferred.
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
  const requested = optionalString(input.authority);
  if (requested !== undefined && !isSharedAuthority(requested)) {
    throw new Error(
      `applyDefaultEnvelope: authority must be informational, advisory, or binding; got ${JSON.stringify(requested)}`,
    );
  }
  if (requested === "binding" && options.binding !== true) {
    throw new Error("applyDefaultEnvelope: authority \"binding\" requires an explicit binding flag");
  }
  return withOptionalFields(requested ?? "informational", input);
}

export function parseSharedEnvelope(raw: unknown): SharedEnvelope {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { authority: "informational" };
  }
  const record = raw as Record<string, unknown>;
  const requested = optionalString(record.authority);
  const authority = requested !== undefined && isSharedAuthority(requested) ? requested : "informational";
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
