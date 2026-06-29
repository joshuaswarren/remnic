import path from "node:path";
import {
  encodeStoragePathSegment,
  encodeStoragePathSegmentWithHash,
  isSafeLegacyPathSegment,
  storagePathHash,
} from "./storage-paths.js";

/**
 * Shared session-identity / transcript-pathing layer (issue #1496).
 *
 * This module is the SINGLE source of truth for turning a `sessionKey` into a
 * channel identity and a set of deterministic, collision-resistant storage
 * paths. Every subsystem that previously re-parsed session keys (transcript
 * pathing, tool-usage pathing, hourly summaries, session auditing, conversation
 * indexing) MUST route through `parseSessionIdentity()` / `sessionStoragePaths()`
 * so behavior stays identical across paths (rule #22, #39).
 *
 * Two shapes are recognized:
 *
 *   1. Legacy `agent:<agentId>:<channelType>:...` keys keep their existing
 *      readable channel identity:
 *        - agent:<id>:main                      → type="main",    id="default"
 *        - agent:<id>:discord:channel:<chanId>  → type="discord", id="<chanId>"
 *        - agent:<id>:slack:channel:<chanId>    → type="slack",   id="<chanId>"
 *        - agent:<id>:cron:<jobId>              → type="cron",    id="<jobId>"
 *        - agent:<id>:<other>[:<id>]            → type="<other>", id="<id?>"
 *
 *   2. Arbitrary / non-legacy keys (e.g. `pi-geek:abc123`) become first-class
 *      from the FIRST write — they NEVER start life under `other/default`:
 *        channelType = "session"
 *        channelId   = storagePathHash(sessionKey)   (collision-resistant)
 *      yielding `transcripts/session/<hash>/YYYY-MM-DD.jsonl`.
 *
 * The reserved `"session"` channel type is what makes arbitrary keys isolated
 * and auditable. Legacy data under `other/default` (and any legacy channel
 * directory) remains READABLE via `legacyDir` / `alternateDir` candidates.
 */

/** Channel type reserved for first-class arbitrary (non-legacy) session keys. */
export const SESSION_CHANNEL_TYPE = "session";

/** Legacy fallback channel identity for un-parseable keys (read-back only). */
export const LEGACY_FALLBACK_CHANNEL_TYPE = "other";
export const LEGACY_FALLBACK_CHANNEL_ID = "default";

/** Max characters of the raw session key kept in a human-readable display label. */
const DISPLAY_LABEL_MAX_LENGTH = 64;

export interface SessionIdentity {
  /** Channel type — legacy channel type for known shapes, else `"session"`. */
  channelType: string;
  /** Channel id — legacy channel id for known shapes, else the key hash. */
  channelId: string;
  /** Human-readable, non-authoritative label derived from the raw key. */
  displayLabel: string;
  /** The original session key, unchanged. */
  canonicalSessionKey: string;
  /** True when the key matched a known legacy `agent:<id>:...` shape. */
  legacy: boolean;
}

export interface SessionStoragePaths {
  /** Channel type (mirrors {@link SessionIdentity.channelType}). */
  channelType: string;
  /** Channel id (mirrors {@link SessionIdentity.channelId}). */
  channelId: string;
  /** Primary encoded storage subdirectory: `<encodedType>/<encodedId>`. */
  dir: string;
  /**
   * Collision-resistant alternate subdirectory that always embeds the full
   * session-key hash. Used both as a write-time collision escape hatch and as a
   * read-back candidate for data written before this layer existed.
   */
  alternateDir: string;
  /**
   * Un-encoded `<type>/<id>` directory for reading data written by older
   * builds that did not URL-encode path segments. Undefined when it would be
   * identical to `dir` or when either segment is path-unsafe.
   */
  legacyDir?: string;
}

/**
 * Parse a session key into a stable channel identity.
 *
 * Pure and deterministic — no filesystem access. Same input always yields the
 * same identity, which is what makes arbitrary keys collision-resistant from
 * the first write.
 */
export function parseSessionIdentity(sessionKey: string): SessionIdentity {
  const canonicalSessionKey = typeof sessionKey === "string" ? sessionKey : "";
  const legacy = parseLegacyChannelIdentity(canonicalSessionKey);
  if (legacy) {
    return {
      channelType: legacy.channelType,
      channelId: legacy.channelId,
      displayLabel: safeDisplayLabel(canonicalSessionKey),
      canonicalSessionKey,
      legacy: true,
    };
  }

  return {
    channelType: SESSION_CHANNEL_TYPE,
    channelId: storagePathHash(canonicalSessionKey),
    displayLabel: safeDisplayLabel(canonicalSessionKey),
    canonicalSessionKey,
    legacy: false,
  };
}

/**
 * Resolve the storage path pieces for a session key. Wraps
 * {@link parseSessionIdentity} so transcript, tool-usage, and summary writers
 * share one implementation (rule #22).
 */
export function sessionStoragePaths(sessionKey: string): SessionStoragePaths {
  const identity = parseSessionIdentity(sessionKey);
  const { channelType, channelId, canonicalSessionKey } = identity;

  const dir = path.join(encodeStoragePathSegment(channelType), encodeStoragePathSegment(channelId));

  const alternateDir = path.join(
    encodeStoragePathSegmentWithHash(channelType),
    `${encodeStoragePathSegmentWithHash(channelId)}--session-${storagePathHash(canonicalSessionKey)}`
  );

  let legacyDir: string | undefined;
  if (isSafeLegacyPathSegment(channelType) && isSafeLegacyPathSegment(channelId)) {
    const candidate = path.join(channelType, channelId);
    if (candidate !== dir) {
      legacyDir = candidate;
    }
  }

  return { channelType, channelId, dir, alternateDir, legacyDir };
}

/**
 * Parse the legacy `agent:<agentId>:<channelType>:...` shape. Returns
 * `undefined` for anything that is not a recognized legacy key, so the caller
 * can route it to a first-class `session/<hash>` identity instead.
 *
 * A legacy key must start with the literal `agent` segment and a non-empty
 * agent id; otherwise an arbitrary key like `pi-geek:abc123` would be
 * misread as `channelType = "abc123"`.
 */
function parseLegacyChannelIdentity(sessionKey: string): { channelType: string; channelId: string } | undefined {
  if (sessionKey.length === 0) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length < 3) return undefined;
  if (parts[0] !== "agent") return undefined;
  if (!parts[1] || parts[1].length === 0) return undefined;

  const channelType = parts[2];
  if (!channelType || channelType.length === 0) return undefined;

  let channelId = LEGACY_FALLBACK_CHANNEL_ID;
  if (channelType === "main") {
    channelId = "default";
  } else if (channelType === "discord" && parts.length >= 5 && parts[3] === "channel") {
    channelId = parts[4];
  } else if (channelType === "slack" && parts.length >= 5 && parts[3] === "channel") {
    channelId = parts[4];
  } else if (channelType === "cron" && parts.length >= 4) {
    channelId = parts[3];
  } else if (parts.length >= 4) {
    channelId = parts[3];
  }

  if (!channelId || channelId.length === 0) {
    channelId = LEGACY_FALLBACK_CHANNEL_ID;
  }

  return { channelType, channelId };
}

/**
 * A short, human-readable label for dashboards/audits. Never used for storage
 * routing — `channelId` (the hash) owns isolation. Control characters and path
 * separators are stripped so the label is safe to render.
 */
function safeDisplayLabel(sessionKey: string): string {
  if (sessionKey.length === 0) return "(empty)";
  let out = "";
  for (const char of sessionKey) {
    const code = char.codePointAt(0) ?? 0;
    // Drop ASCII control characters (0x00-0x1F) and DEL (0x7F).
    if (code <= 0x1f || code === 0x7f) continue;
    if (char === "/" || char === "\\") {
      out += "_";
      continue;
    }
    out += char;
  }
  const trimmed = out.trim();
  if (trimmed.length === 0) return "(empty)";
  return trimmed.length > DISPLAY_LABEL_MAX_LENGTH ? `${trimmed.slice(0, DISPLAY_LABEL_MAX_LENGTH - 1)}…` : trimmed;
}
