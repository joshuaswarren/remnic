/**
 * Payload normalization for all three X sources plus the shared
 * dedupe fingerprint and the record → memory mapping.
 *
 * All parsers are shape-tolerant: X MCP payloads follow the v2 API
 * expansions shape (`data[]` + `includes.users`), local corpora and
 * CLI tools use a variety of field aliases. Every field read is
 * checked; unrecognized shapes yield empty results, never crashes.
 */

import { createHash } from "node:crypto";

import { isXObject } from "./guards.js";
import type { XMemorySuggestion, XPostRecord, XRecordKind } from "./types.js";

/** Sorts keys recursively so key order never changes the fingerprint. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (isXObject(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]])
      );
    }
    return entry;
  });
}

/** Identity fingerprint: same post + same content = same memory, regardless of source key order. */
export function recordFingerprint(record: XPostRecord): string {
  return createHash("sha256")
    .update(
      stableStringify({
        postId: record.postId,
        kind: record.kind,
        text: record.text,
        urls: [...record.urls].sort(),
        authorUsername: record.author?.username ?? null,
      })
    )
    .digest("hex");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const urls: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) urls.push(entry.trim());
    else if (isXObject(entry)) {
      const expanded = firstString(entry.expanded_url, entry.url, entry.href);
      if (expanded !== undefined) urls.push(expanded);
    }
  }
  return urls;
}

function kindFrom(value: unknown, fallback: XRecordKind): XRecordKind {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "bookmark" || raw === "bookmarks") return "bookmark";
  if (raw === "own_post" || raw === "post" || raw === "tweet" || raw === "own-post") {
    return "own_post";
  }
  return fallback;
}

/**
 * Normalizes an MCP tool-result payload (v2 expansions shape) into
 * records. Accepts `{data: [...]}` with `includes.users`, a bare
 * array, or `{bookmarks: [...]}`.
 */
export function normalizeMcpPayload(payload: unknown, kind: XRecordKind, ownUsername?: string): XPostRecord[] {
  const container = isXObject(payload) ? payload : {};
  const includesUsers = isXObject(container.includes)
    ? Array.isArray(container.includes.users)
      ? container.includes.users
      : []
    : [];
  const rows = Array.isArray(container.data)
    ? container.data
    : Array.isArray(payload)
      ? payload
      : isXObject(container.bookmarks) && Array.isArray(container.bookmarks.data)
        ? container.bookmarks.data
        : Array.isArray(container.bookmarks)
          ? container.bookmarks
          : [];
  const records: XPostRecord[] = [];
  for (const row of rows) {
    const record = normalizeEntry(row, kind, includesUsers, ownUsername);
    if (record !== null) records.push(record);
  }
  return records;
}

/** Normalizes one corpus/CLI entry (tolerant field aliases). */
export function normalizeCorpusEntry(
  entry: unknown,
  fallbackKind: XRecordKind,
  ownUsername?: string
): XPostRecord | null {
  return normalizeEntry(entry, fallbackKind, [], ownUsername);
}

function normalizeEntry(
  entry: unknown,
  fallbackKind: XRecordKind,
  includesUsers: unknown[],
  ownUsername?: string
): XPostRecord | null {
  if (!isXObject(entry)) return null;
  const postId = firstString(entry.post_id, entry.id, entry.tweet_id, entry.postId);
  const text = firstString(entry.text, entry.full_text, entry.content, entry.note) ?? "";
  if (postId === undefined || (text.length === 0 && !hasUrls(entry))) return null;

  const kind = kindFrom(entry.kind ?? entry.type, fallbackKind);
  const authorRaw = isXObject(entry.author) ? entry.author : entry;
  const authorId = firstString(entry.author_id, entry.authorId, authorRaw.id);
  const authorUsername =
    firstString(authorRaw.username, authorRaw.handle, authorRaw.screen_name) ??
    lookupIncludedUsername(includesUsers, authorId) ??
    ownUsername;
  const authorName = firstString(authorRaw.name, authorRaw.display_name);
  const author =
    authorUsername !== undefined || authorId !== undefined || authorName !== undefined
      ? {
          ...(authorId !== undefined ? { id: authorId } : {}),
          ...(authorUsername !== undefined ? { username: authorUsername } : {}),
          ...(authorName !== undefined ? { name: authorName } : {}),
        }
      : undefined;

  const urls = collectUrls(entry);
  const createdAt = firstString(entry.created_at, entry.createdAt, entry.created_at_iso);
  const bookmarkedAt = firstString(entry.bookmarked_at, entry.bookmarkedAt, entry.saved_at);
  const mediaCount = countMedia(entry);
  const enrichment = isXObject(entry.enrichment) ? entry.enrichment : undefined;

  return {
    postId,
    kind,
    ...(author !== undefined ? { author } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(bookmarkedAt !== undefined ? { bookmarkedAt } : {}),
    text: trimTcoSuffix(text, entry),
    urls,
    mediaCount,
    ...(enrichment !== undefined ? { enrichment } : {}),
  };
}

function hasUrls(entry: Record<string, unknown>): boolean {
  return collectUrls(entry).length > 0;
}

function collectUrls(entry: Record<string, unknown>): string[] {
  const urls = [...asStringArray(entry.urls), ...asStringArray(entry.url), ...asStringArray(entry.links)];
  if (isXObject(entry.entities) && Array.isArray(entry.entities.urls)) {
    urls.push(...asStringArray(entry.entities.urls));
  }
  return [...new Set(urls)];
}

function countMedia(entry: Record<string, unknown>): number {
  if (isXObject(entry.attachments) && Array.isArray(entry.attachments.media_keys)) {
    return entry.attachments.media_keys.length;
  }
  if (Array.isArray(entry.media)) return entry.media.length;
  if (isXObject(entry.media) && Array.isArray(entry.media.media_keys)) {
    return entry.media.media_keys.length;
  }
  return 0;
}

function lookupIncludedUsername(includesUsers: unknown[], authorId: string | undefined): string | undefined {
  if (authorId === undefined) return undefined;
  for (const user of includesUsers) {
    if (isXObject(user) && user.id === authorId) {
      return firstString(user.username, user.screen_name);
    }
  }
  return undefined;
}

/**
 * X appends the share URL (a t.co short link) to tweet text; when the
 * text ends with exactly that short link, drop it — the expanded URL
 * is already in `urls`.
 */
function trimTcoSuffix(text: string, entry: Record<string, unknown>): string {
  const entities = isXObject(entry.entities) && Array.isArray(entry.entities.urls) ? entry.entities.urls : [];
  for (const raw of entities) {
    if (!isXObject(raw) || typeof raw.url !== "string") continue;
    if (raw.url.includes("://t.co/") && text.endsWith(raw.url)) {
      return text.slice(0, text.length - raw.url.length).trimEnd();
    }
  }
  return text;
}

function postUrl(record: XPostRecord): string {
  const username = record.author?.username;
  return username !== undefined
    ? `https://x.com/${username}/status/${record.postId}`
    : `https://x.com/i/status/${record.postId}`;
}

const QUOTE = '"';

/**
 * Record → memory mapping (issue #2009 §2):
 * - bookmarks → tag `x/bookmark`, category `reference` (carries a URL) or `interest`
 * - own posts → tag `x/post`, category `expression`, higher confidence
 */
export function suggestionForRecord(record: XPostRecord): XMemorySuggestion {
  const quoted = `${QUOTE}${record.text.slice(0, 280)}${record.text.length > 280 ? "…" : ""}${QUOTE}`;
  const from = record.author?.username !== undefined ? ` from @${record.author.username}` : "";
  const firstUrl = record.urls[0];
  const title = enrichmentTitle(record);
  const isOwnPost = record.kind === "own_post";
  const content = isOwnPost
    ? `Posted on X: ${quoted}${firstUrl !== undefined ? ` ${firstUrl}` : ""}${title !== undefined ? ` (${title})` : ""}`
    : `Bookmarked on X${from}: ${quoted}${firstUrl !== undefined ? ` ${firstUrl}` : ""}${
        title !== undefined ? ` (${title})` : ""
      }`;
  return {
    record,
    tags: [isOwnPost ? "x/post" : "x/bookmark"],
    category: isOwnPost ? "expression" : firstUrl !== undefined ? "reference" : "interest",
    ...(record.author?.username !== undefined ? { entityRef: `person-${record.author.username.toLowerCase()}` } : {}),
    confidence: isOwnPost ? 0.9 : 0.7,
    postUrl: postUrl(record),
    content,
  };
}

function enrichmentTitle(record: XPostRecord): string | undefined {
  if (record.enrichment === undefined) return undefined;
  const title = isXObject(record.enrichment) ? record.enrichment.title : undefined;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined;
}
