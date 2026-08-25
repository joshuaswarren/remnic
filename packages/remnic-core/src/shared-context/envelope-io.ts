/**
 * Shared-item envelope wiring (issue #1957, control 1: origin + authority).
 *
 * Bridges the pure envelope helpers onto the markdown frontmatter the
 * shared-context manager reads and writes.
 *
 * Write side rejects invalid input (an unrecognized authority or a binding
 * request without the config opt-in throws — never silently reinterpreted).
 * Read side resolves least privilege: a missing, malformed, or unrecognized
 * authority never resolves above informational, and stored binding
 * downgrades to advisory unless config opted in.
 */

import { applyDefaultEnvelope, parseSharedEnvelope, type SharedEnvelope } from "./governance.js";
import { resolveSharedAuthority } from "./authority-precedence.js";
import type { SharedAuthority } from "./governance.js";
import { parseEnvelopeActor } from "./envelope-actor.js";
import { parseEnvelopeAt } from "./envelope-at.js";
import { parseEnvelopeId } from "./envelope-id.js";

export interface ComposeWriteEnvelopeInput {
  /** Governance origin. Becomes the envelope's `sharedBy`. */
  origin: string;
  /** Requested authority class. Unrecognized values throw. */
  authority?: string;
  /** Optional ISO-8601 expiry. Invalid timestamps throw. */
  expiresAt?: string;
  /** Optional id of the item this one supersedes. */
  supersedes?: string;
  /** Config opt-in (`sharedContextAllowBindingAuthority`). Binding throws without it. */
  allowBinding: boolean;
  /**
   * Write instant for the expiry TTL policy (issue #2920). When finite, an
   * `expiresAt` must land strictly after it and within the maximum TTL —
   * a past or effectively-immortal expiry is a client input error, never a
   * silently accepted stamp.
   */
  nowMs?: number;
}

function requireEnvelopeActor(agentId: string): string {
  const parsed = parseEnvelopeActor(agentId);
  if (!parsed.ok) {
    throw new Error(`composeWriteEnvelope: agentId must be a non-blank single-line string (${parsed.error})`);
  }
  return parsed.actor;
}

function optionalEnvelopeAt(expiresAt: string | undefined): string | undefined {
  if (expiresAt === undefined) return undefined;
  const parsed = parseEnvelopeAt(expiresAt);
  if (!parsed.ok) {
    throw new Error(`composeWriteEnvelope: expiresAt must be a valid ISO-8601 timestamp (${parsed.error})`);
  }
  return parsed.at;
}

/** Maximum write-side TTL: 10 years. A farther `expiresAt` is rejected. */
export const MAX_WRITE_EXPIRES_AT_TTL_MS = 3650 * 24 * 60 * 60 * 1000;

function assertBoundedFutureExpiry(expiresAt: string, nowMs: number): void {
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= nowMs) {
    throw new Error("composeWriteEnvelope: expiresAt must be an instant strictly after the write time");
  }
  if (expiresAtMs - nowMs > MAX_WRITE_EXPIRES_AT_TTL_MS) {
    throw new Error(
      `composeWriteEnvelope: expiresAt exceeds the maximum TTL of ${MAX_WRITE_EXPIRES_AT_TTL_MS}ms`,
    );
  }
}

function optionalEnvelopeId(supersedes: string | undefined): string | undefined {
  if (supersedes === undefined) return undefined;
  const parsed = parseEnvelopeId(supersedes);
  if (!parsed.ok) {
    throw new Error(`composeWriteEnvelope: supersedes must be a non-blank single-line id (${parsed.error})`);
  }
  return parsed.id;
}

/**
 * Reserved governance origin for an authenticated external access write that
 * resolved no principal (`agentAccessHttp.principal` unset, no adapter
 * identity). Server-owned: the caller cannot mint or influence it, and the
 * caller-supplied `agentId` never becomes audit metadata on that path.
 */
export const UNATTRIBUTED_ACCESS_WRITE_ORIGIN = "unattributed:access-surface";

export interface ResolvedWriteIdentity {
  /**
   * Producer identity: frontmatter `agent`, on-disk segment, and the
   * cross-signals grouping key. Self-declared by the caller only on
   * surfaces that resolved no server identity; never decides authority.
   */
  agent: string;
  /** Governance origin stamped as the envelope's `sharedBy`. */
  origin: string;
}

/**
 * Resolve the producer identity and governance origin for a shared-context
 * write. They are different fields with different trust requirements:
 *
 * - The origin (`sharedBy`) is audit metadata and is always server-derived.
 *   When the surface resolved an authenticated identity, that identity IS the
 *   origin; when it resolved none but the write crosses an external
 *   boundary, the caller-supplied `unattributedOrigin` token is stamped
 *   instead — never the caller's value. Only a trusted in-process caller
 *   (no identity, no token) may stamp its own id as the origin.
 * - The producer (`agent`) drives grouping and display only. When an
 *   authenticated identity exists it is also the producer, and a
 *   caller-supplied `agentId` naming a different agent is REJECTED, so a
 *   caller can never publish an item attributed to another agent. Without a
 *   server identity the caller's label stands as the producer — collapsing
 *   it instead would merge every writer into one agent and erase
 *   multi-agent overlaps from `synthesizeCrossSignals`.
 */
export function resolveWriteOrigin(input: {
  agentId: string;
  authenticatedIdentity?: string;
  unattributedOrigin?: string;
}): ResolvedWriteIdentity {
  const identity = input.authenticatedIdentity?.trim() ?? "";
  if (identity.length > 0) {
    const requested = input.agentId.trim();
    if (requested.length > 0 && requested !== identity) {
      throw new Error(
        `shared-context write origin mismatch: authenticated identity ${JSON.stringify(identity)} cannot publish as ${JSON.stringify(requested)}`,
      );
    }
    return { agent: identity, origin: identity };
  }
  const unattributed = input.unattributedOrigin?.trim() ?? "";
  if (unattributed.length > 0) {
    const label = input.agentId.trim();
    return {
      agent: label.length > 0 ? requireProducer(label) : requireProducer(unattributed),
      origin: requireProducer(unattributed),
    };
  }
  const actor = requireProducer(input.agentId);
  return { agent: actor, origin: actor };
}

function requireProducer(value: string): string {
  const parsed = parseEnvelopeActor(value);
  if (!parsed.ok) {
    throw new Error(`shared-context write producer must be a non-blank single-line string (${parsed.error})`);
  }
  return parsed.actor;
}

/**
 * Validate and compose the envelope for a shared-context write.
 * `sharedBy` is stamped from the server-derived origin — provenance is
 * never injected through item content or the caller's producer label.
 */
export function composeWriteEnvelope(input: ComposeWriteEnvelopeInput): SharedEnvelope {
  const sharedBy = requireEnvelopeActor(input.origin);
  const expiresAt = optionalEnvelopeAt(input.expiresAt);
  if (expiresAt !== undefined && Number.isFinite(input.nowMs ?? Number.NaN)) {
    assertBoundedFutureExpiry(expiresAt, input.nowMs as number);
  }
  const supersedes = optionalEnvelopeId(input.supersedes);
  return applyDefaultEnvelope(
    { sharedBy, authority: input.authority, expiresAt, supersedes },
    { binding: input.allowBinding },
  );
}

/** Serialize an envelope into frontmatter lines (caller adds the `---` fences). */
export function envelopeToFrontmatterLines(envelope: SharedEnvelope): string[] {
  const line = (key: string, value: string) => `${key}: ${JSON.stringify(value)}`;
  const lines = [line("sharedBy", envelope.sharedBy ?? ""), line("authority", envelope.authority)];
  if (envelope.expiresAt !== undefined) lines.push(line("expiresAt", envelope.expiresAt));
  if (envelope.supersedes !== undefined) lines.push(line("supersedes", envelope.supersedes));
  return lines;
}

/**
 * Build an envelope from frontmatter scalars already read off a stored item.
 * Missing scalars (legacy items) compose to informational with no expiry.
 */
export function envelopeFromScalars(scalars: {
  sharedBy: string | null;
  authority: string | null;
  expiresAt: string | null;
  supersedes: string | null;
}): SharedEnvelope {
  const record: Record<string, string> = {};
  if (scalars.sharedBy !== null) record.sharedBy = scalars.sharedBy;
  if (scalars.authority !== null) record.authority = scalars.authority;
  if (scalars.expiresAt !== null) record.expiresAt = scalars.expiresAt;
  if (scalars.supersedes !== null) record.supersedes = scalars.supersedes;
  return parseSharedEnvelope(record);
}

/**
 * Resolve a stored envelope's authority for read-side consumption.
 * Least privilege: unrecognized/missing stays informational; binding
 * requires the config opt-in or downgrades to advisory.
 */
export function resolveReadAuthority(
  envelope: Pick<SharedEnvelope, "authority">,
  allowBinding: boolean,
): SharedAuthority {
  return resolveSharedAuthority({ authority: envelope.authority, allowBinding });
}
