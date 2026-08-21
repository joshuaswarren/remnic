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
  /** Acting agent id. Becomes the envelope origin (`sharedBy`). */
  agentId: string;
  /** Requested authority class. Unrecognized values throw. */
  authority?: string;
  /** Optional ISO-8601 expiry. Invalid timestamps throw. */
  expiresAt?: string;
  /** Optional id of the item this one supersedes. */
  supersedes?: string;
  /** Config opt-in (`sharedContextAllowBindingAuthority`). Binding throws without it. */
  allowBinding: boolean;
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

function optionalEnvelopeId(supersedes: string | undefined): string | undefined {
  if (supersedes === undefined) return undefined;
  const parsed = parseEnvelopeId(supersedes);
  if (!parsed.ok) {
    throw new Error(`composeWriteEnvelope: supersedes must be a non-blank single-line id (${parsed.error})`);
  }
  return parsed.id;
}

/**
 * Validate and compose the envelope for a shared-context write.
 * `sharedBy` is stamped from the acting agent id — provenance is derived
 * by the manager, never injected through item content.
 */
export function composeWriteEnvelope(input: ComposeWriteEnvelopeInput): SharedEnvelope {
  const sharedBy = requireEnvelopeActor(input.agentId);
  const expiresAt = optionalEnvelopeAt(input.expiresAt);
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
