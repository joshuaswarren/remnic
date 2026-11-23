/**
 * peers/interaction-log-append.ts — append path for the peer
 * interaction log, extracted from storage.ts (#1995 ratchet: the file
 * exceeded its grandfathered ceiling). Read/parse stays in storage.ts.
 */

import { z } from "zod";

import type { PeerInteractionLogEntry } from "./types.js";
import {
  appendFileNoFollow,
  assertPeerDirNotEscaped,
  assertValidPeerId,
  interactionsPath,
  mkdirPeerDirAtomic,
} from "./storage.js";

// Boundary decode for the untrusted entry argument. The checks below
// carry the Codex P2 review history: trim() before the empty check
// matches what sanitizeLogField does at format time (round 10/12); a
// whitespace-only timestamp or kind would previously pass validation
// and then be normalized to "" later, producing an entry like
// `- [] ()` that breaks downstream parsers; optional sessionId must be
// a non-empty string OR strictly `undefined` — null and "" are both
// rejected explicitly (rounds 6/8/9) because silently dropping them
// reinterprets invalid input instead of failing fast.
const NON_WHITESPACE_TIMESTAMP = "interaction entry must have a non-whitespace timestamp";
const NON_WHITESPACE_KIND = "interaction entry must have a non-whitespace kind";
const STRING_SUMMARY = "interaction entry must have a string summary";
const NON_WHITESPACE_SESSION = "interaction entry sessionId must be a non-whitespace string when provided";
const interactionEntrySchema = z.object({
  timestamp: z.string({ error: NON_WHITESPACE_TIMESTAMP }).trim().min(1, NON_WHITESPACE_TIMESTAMP),
  kind: z.string({ error: NON_WHITESPACE_KIND }).trim().min(1, NON_WHITESPACE_KIND),
  summary: z.string({ error: STRING_SUMMARY }),
  sessionId: z.string({ error: NON_WHITESPACE_SESSION }).trim().min(1, NON_WHITESPACE_SESSION).optional(),
});

function sanitizeLogField(value: string): string {
  // Cursor Medium: every interaction-log field — not just summary —
  // must collapse newlines so a malicious or buggy `timestamp` /
  // `kind` / `sessionId` value can't break the one-line-per-entry
  // invariant the append-only log relies on. Replace CR/LF/Tab with
  // a single space; trim leading/trailing whitespace.
  return value.replace(/[\r\n\t]+/g, " ").trim();
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}
function assertCanonicalIsoTimestamp(value: string, field: string): void {
  if (!isCanonicalIsoTimestamp(value)) {
    throw new Error(`${field} must be a canonical ISO-8601 timestamp`);
  }
}

function formatLogEntry(entry: PeerInteractionLogEntry): string {
  // One line per entry. We use a leading bullet so the file remains
  // readable as ordinary markdown. Order: timestamp, kind, optional
  // session id, summary. ALL fields are passed through `sanitizeLogField`
  // so a stray newline anywhere can't shatter the append-only invariant
  // (cursor Medium on PR #723).
  //
  // Cursor Low on PR #736: the previous bare `session=<id>` token was
  // ambiguous with summaries that literally start with `session=`
  // (e.g. summary `"session=foo bar"` round-tripped to
  // `{sessionId: "foo", summary: "bar"}`). New entries wrap the
  // session marker in square brackets — `[session=<id>]` — which a
  // sanitized summary can never start with (sanitizeLogField never
  // emits `[` as the first character of a summary that originally
  // started with `session=`, and bracketed metadata is unambiguously
  // distinct from `session=` text). Old entries written by previous
  // code remain parseable through the legacy fallback in
  // `parseLogLine`.
  const ts = sanitizeLogField(entry.timestamp);
  const kind = sanitizeLogField(entry.kind);
  const summary = sanitizeLogField(entry.summary);
  const session = entry.sessionId
    ? ` [session=${sanitizeLogField(entry.sessionId)}]`
    : "";
  return `- [${ts}] (${kind})${session} ${summary}`;
}

/**
 * Append one entry to a peer's interaction log.
 *
 * Creates `peers/{id}/` and `interactions.log.md` if needed. The file is
 * append-only by contract — this helper never rewrites prior entries.
 * Returns the absolute path of the log file (useful for tests).
 *
 * Concurrency contract: appends to the same file are serialized
 * in-process via a per-file promise chain — entries land in enqueue
 * order and a single entry can never be split by another writer's chunk
 * (#3564). Ordering across separate PROCESSES is still the caller's
 * responsibility (POSIX gives atomicity per write, not ordering).
 */
// Per-file tail of the append chain. Bounded to files with an in-flight
// write: the writer deletes its entry when it is still the tail.
const appendQueues = new Map<string, Promise<void>>();
export async function appendInteractionLog(
  memoryDir: string,
  peerId: string,
  entry: PeerInteractionLogEntry,
): Promise<string> {
  assertValidPeerId(peerId);
  const parsedEntry = interactionEntrySchema.safeParse(entry);
  if (!parsedEntry.success) {
    throw new Error(parsedEntry.error.issues[0]?.message ?? "invalid interaction entry");
  }
  const e = parsedEntry.data;
  assertCanonicalIsoTimestamp(e.timestamp, "interaction entry timestamp");
  const file = interactionsPath(memoryDir, peerId);
  const line = formatLogEntry(e) + "\n";
  // `appendFile` creates the file if it does not exist. Serialize writes
  // per file so concurrent callers' entries land in enqueue order —
  // `fh.writeFile` chunks a large entry across multiple writes, and an
  // unqueued writer could otherwise interleave between them (#3564).
  // The chain tail is kept on a .catch(() => {}) so one failed append
  // does not poison the queue for followers.
  //
  // The queue slot is taken SYNCHRONOUSLY, before the directory awaits:
  // a caller that awaits mkdir first can otherwise reach this block after
  // a later caller (the dir already exists, so its mkdir returns faster),
  // and the later entry would be written first. Taking the slot here makes
  // enqueue order equal call order.
  const prev = appendQueues.get(file) ?? Promise.resolve();
  const write = prev.then(async () => {
    await mkdirPeerDirAtomic(memoryDir, peerId);
    await assertPeerDirNotEscaped(memoryDir, peerId);
    await appendFileNoFollow(file, line);
  });
  const tail = write.catch(() => {});
  appendQueues.set(file, tail);
  try {
    await write;
  } finally {
    if (appendQueues.get(file) === tail) appendQueues.delete(file);
  }
  return file;
}
