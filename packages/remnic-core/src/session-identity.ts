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
  /**
   * Ordered, de-duplicated list of READ-BACK-ONLY directories where an older
   * build may have stranded this key's data. NEW writes never target these —
   * they exist purely so pre-#1496 transcripts/tool-usage stay discoverable
   * (and migratable). Populated only for non-legacy keys. Includes:
   *   1. the shared `other/default` fallback (every arbitrary key landed here);
   *   2. the directory the OLD `parts.length >= 3` parser would have chosen
   *      (e.g. `foo:bar:baz` → `baz/default`, `foo:bar:baz:qux` → `baz/qux`).
   * See {@link legacyParserReadbackDir}.
   */
  readbackDirs: string[];
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

  // Read-back-only candidates are only relevant for non-legacy keys: legacy
  // `agent:<id>:...` keys still resolve to their original channel directory, so
  // nothing about their on-disk location moved.
  const readbackDirs: string[] = [];
  if (!identity.legacy) {
    const seen = new Set<string>([dir]);
    if (alternateDir) seen.add(alternateDir);
    if (legacyDir) seen.add(legacyDir);
    for (const candidate of [OTHER_DEFAULT_READBACK_DIR, legacyParserReadbackDir(canonicalSessionKey)]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      readbackDirs.push(candidate);
    }
  }

  return { channelType, channelId, dir, alternateDir, legacyDir, readbackDirs };
}

/**
 * The shared `other/default` directory every arbitrary key was routed into by
 * builds predating issue #1496. Exposed so transcript/tool-usage/summary read
 * paths and the migration scanner all agree on the same fallback location.
 */
export const OTHER_DEFAULT_READBACK_DIR = path.join(
  LEGACY_FALLBACK_CHANNEL_TYPE,
  LEGACY_FALLBACK_CHANNEL_ID
);

/**
 * Reconstruct the transcript/tool-usage directory the OLD `getTranscriptPath`
 * parser (pre-#1496) would have produced for a key the NEW parser reclassifies
 * as a first-class `session/<hash>` identity.
 *
 * The OLD parser treated ANY key with `parts.length >= 3` as legacy — it did
 * NOT require a leading `agent` segment — so an arbitrary key like
 * `foo:bar:baz` was stored under `baz/default` and `foo:bar:baz:qux` under
 * `baz/qux`. Those directories must stay readable (and migratable) for existing
 * installs even though the key now writes to `session/<hash>` (Thread B / codex
 * review on PR #1504). Path segments are encoded exactly as the old `dir` was
 * built (`encodeStoragePathSegment`) so the candidate matches the bytes on disk.
 *
 * Returns `undefined` when the key has fewer than three colon parts (the old
 * parser would have used the `other/default` fallback, already covered), when
 * the channel type is empty, or when the result is unsafe.
 */
export function legacyParserReadbackDir(sessionKey: string): string | undefined {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length < 3) return undefined;

  const channelType = parts[2];
  if (!channelType || channelType.length === 0) return undefined;

  // Mirror the OLD parser's channelId derivation for parts.length >= 3 keys.
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

  return path.join(encodeStoragePathSegment(channelType), encodeStoragePathSegment(channelId));
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
