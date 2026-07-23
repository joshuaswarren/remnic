/**
 * `--replay <dir>` ingestion. Feeds synthetic fixture conversations into
 * the spool so the entire read path (spool + HTTP API) is testable in CI
 * without capture hardware or STT. Fixtures are synthetic by policy — no
 * real audio or conversation data lives in the repo, and none is required
 * for tests.
 *
 * Each `*.json` fixture is either a single conversation object or an array
 * of them. Every field is validated loudly: an absent optional field takes
 * its default, but a present-but-wrong-typed/invalid field throws
 * CaptureConfigError naming the file and path (no silent coercion). A
 * conversation is fully parsed BEFORE its speakers are upserted, so a
 * malformed conversation never persists speaker rows.
 *
 *   {
 *     "id": "conv_demo1",                        // optional; generated if absent
 *     "startedAtUtc": "2026-07-20T15:00:00.000Z",
 *     "endedAtUtc":  "2026-07-20T15:05:00.000Z", // optional
 *     "state": "final",                          // optional; "final" | "capturing"
 *     "device": "MacBook mic",                   // optional
 *     "speakers": [ { "id": "spk_1", "label": "Alice", "isSelf": false } ],
 *     "segments": [
 *       { "speakerCluster": "spk_1", "isWearer": false, "channel": "mic",
 *         "text": "hello there", "startUtc": "...", "endUtc": "..." }
 *     ]
 *   }
 *
 * Ingestion is idempotent by conversation id (see Spool.insertConversation),
 * so re-running a replay is a content no-op.
 */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CaptureConfigError } from "./errors.js";
import type { ConversationInput, SegmentInput, SpeakerInput, Spool } from "./spool.js";

export interface ReplayResult {
  files: number;
  conversationsIngested: number;
  segmentsIngested: number;
  ids: string[];
  /** True when a cooperative cancel (AbortSignal) stopped ingestion early. */
  aborted: boolean;
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureConfigError(`${where}: expected a conversation object`);
  }
  return value as Record<string, unknown>;
}

function parseTimestamp(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new CaptureConfigError(`${where}: expected an ISO timestamp`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new CaptureConfigError(`${where}: expected a valid ISO timestamp`);
  }
  // Reject non-round-trippable calendar dates (e.g. 2026-02-30) that Date.parse
  // silently rolls forward. Validate the written date part directly.
  const [cy, cm, cd] = value.slice(0, 10).split("-").map(Number);
  const probe = new Date(Date.UTC(cy, cm - 1, cd));
  probe.setUTCFullYear(cy);
  if (probe.getUTCFullYear() !== cy || probe.getUTCMonth() !== cm - 1 || probe.getUTCDate() !== cd) {
    throw new CaptureConfigError(`${where}: '${value}' is not a real calendar date`);
  }
  // Canonicalize to UTC (Z) so an offset timestamp sorts correctly under the
  // keyset that orders by the stored *_utc value.
  return new Date(ms).toISOString();
}

/** Optional string: absent → fallback; present-non-string → throw. */
function optionalString(value: unknown, where: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new CaptureConfigError(`${where}: expected a string`);
  return value;
}

function parseSegment(raw: unknown, where: string): SegmentInput {
  const obj = asObject(raw, where);
  if (typeof obj.text !== "string" || obj.text === "") {
    throw new CaptureConfigError(`${where}.text: expected a non-empty string`);
  }
  const startUtc = parseTimestamp(obj.startUtc, `${where}.startUtc`);
  const endUtc = parseTimestamp(obj.endUtc, `${where}.endUtc`);
  if (Date.parse(endUtc) < Date.parse(startUtc)) {
    throw new CaptureConfigError(`${where}: endUtc must not precede startUtc`);
  }
  if (obj.isWearer !== undefined && typeof obj.isWearer !== "boolean") {
    throw new CaptureConfigError(`${where}.isWearer: expected a boolean`);
  }
  const channel = obj.channel === undefined ? "mic" : obj.channel;
  if (typeof channel !== "string" || channel === "") {
    throw new CaptureConfigError(`${where}.channel: expected a non-empty string`);
  }
  return {
    speakerCluster: optionalString(obj.speakerCluster, `${where}.speakerCluster`, null),
    isWearer: obj.isWearer === true,
    channel,
    text: obj.text,
    startUtc,
    endUtc,
  };
}

function parseConversation(raw: unknown, where: string): ConversationInput {
  const obj = asObject(raw, where);
  const startedAtUtc = parseTimestamp(obj.startedAtUtc, `${where}.startedAtUtc`);
  const endedAtUtc = obj.endedAtUtc === undefined ? null : parseTimestamp(obj.endedAtUtc, `${where}.endedAtUtc`);
  if (endedAtUtc !== null && Date.parse(endedAtUtc) < Date.parse(startedAtUtc)) {
    throw new CaptureConfigError(`${where}: endedAtUtc must not precede startedAtUtc`);
  }
  if (obj.state !== undefined && obj.state !== "capturing" && obj.state !== "final") {
    throw new CaptureConfigError(`${where}.state: expected "capturing" or "final"`);
  }
  if (obj.id !== undefined && (typeof obj.id !== "string" || obj.id === "")) {
    throw new CaptureConfigError(`${where}.id: expected a non-empty string`);
  }
  if (!Array.isArray(obj.segments)) {
    throw new CaptureConfigError(`${where}.segments: expected an array`);
  }
  return {
    id: obj.id === undefined ? undefined : (obj.id as string),
    startedAtUtc,
    endedAtUtc,
    state: obj.state ?? "final",
    device: optionalString(obj.device, `${where}.device`, null),
    segments: obj.segments.map((seg, i) => parseSegment(seg, `${where}.segments[${i}]`)),
  };
}

/** Parse + validate a fixture's speakers WITHOUT touching the spool. */
function parseSpeakers(raw: unknown, where: string): SpeakerInput[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new CaptureConfigError(`${where}.speakers: expected an array`);
  }
  return raw.map((entry, i) => {
    const obj = asObject(entry, `${where}.speakers[${i}]`);
    if (typeof obj.id !== "string" || obj.id === "") {
      throw new CaptureConfigError(`${where}.speakers[${i}].id: expected a non-empty string`);
    }
    if (obj.isSelf !== undefined && typeof obj.isSelf !== "boolean") {
      throw new CaptureConfigError(`${where}.speakers[${i}].isSelf: expected a boolean`);
    }
    // Only carry fields the fixture actually provided so upsertSpeaker
    // preserves omitted label/isSelf on an existing cluster (issue: a later
    // { id } reference must not wipe an established speaker).
    const speaker: SpeakerInput = { id: obj.id };
    if (obj.label !== undefined) {
      speaker.label = optionalString(obj.label, `${where}.speakers[${i}].label`, null);
    }
    if (obj.isSelf !== undefined) {
      speaker.isSelf = obj.isSelf === true;
    }
    return speaker;
  });
}

interface ParsedFixture {
  speakers: SpeakerInput[];
  conv: ConversationInput;
}

/**
 * Ingest a directory of synthetic replay fixtures atomically: EVERY record
 * (conversation + speakers) is parsed and validated in a first pass, and
 * nothing is written to the spool until the whole set is known valid. A
 * later invalid record therefore leaves no earlier mutation (no stray
 * speaker rows, no half-committed batch).
 */
interface ParsedReplay {
  fixtures: ParsedFixture[];
  files: number;
}

/**
 * Parse + validate an entire replay directory WITHOUT writing to the spool.
 * Throws on the first invalid record so nothing is ever partially committed
 * (atomic failure semantics live here, before any commit runs).
 */
function parseReplayDir(dir: string): ParsedReplay {
  let entries: string[];
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      throw new CaptureConfigError(`replay dir ${dir} is a symlink; refusing to follow it`);
    }
    entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch (err) {
    if (err instanceof CaptureConfigError) throw err;
    throw new CaptureConfigError(`replay dir not found or unreadable: ${dir}`);
  }
  if (entries.length === 0) {
    throw new CaptureConfigError(`replay dir ${dir} contains no *.json fixtures`);
  }

  const fixtures: ParsedFixture[] = [];
  const seenIds = new Set<string>();
  let files = 0;
  for (const name of entries) {
    const filePath = path.join(dir, name);
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new CaptureConfigError(`replay fixture ${name} is a symlink; refusing to follow it`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new CaptureConfigError(`replay fixture ${name} is not valid JSON: ${(err as Error).message}`);
    }
    files += 1;
    const docs = Array.isArray(raw) ? raw : [raw];
    docs.forEach((doc, i) => {
      const where = `${name}[${i}]`;
      const conv = parseConversation(doc, where);
      if (conv.id === undefined) {
        // Derive the id from conversation CONTENT so identical fixtures stay
        // idempotent across replays while distinct conversations that happen to
        // share a filename/index/start time cannot collide.
        const material = JSON.stringify({
          startedAtUtc: conv.startedAtUtc,
          endedAtUtc: conv.endedAtUtc,
          state: conv.state,
          segments: conv.segments,
        });
        conv.id = `conv_${createHash("sha1").update(material).digest("hex").slice(0, 24)}`;
      }
      // Distinct conversations must not share an id within one batch — a silent
      // delete-then-insert overwrite would drop data. (Cross-call re-ingest of
      // the same fixture stays idempotent: each call is its own batch.)
      if (seenIds.has(conv.id as string)) {
        throw new CaptureConfigError(`${where}: duplicate conversation id '${conv.id}' in this replay batch`);
      }
      seenIds.add(conv.id as string);
      const speakers = parseSpeakers(asObject(doc, where).speakers, where);
      fixtures.push({ speakers, conv });
    });
  }
  return { fixtures, files };
}

function commitFixture(spool: Spool, fixture: ParsedFixture, result: ReplayResult): void {
  for (const speaker of fixture.speakers) spool.upsertSpeaker(speaker);
  const id = spool.insertConversation(fixture.conv);
  result.ids.push(id);
  result.conversationsIngested += 1;
  result.segmentsIngested += fixture.conv.segments.length;
}

/** Commit size between event-loop yields in the responsive ingester. */
export const REPLAY_COMMIT_BATCH = 25;

/** Synchronous ingest: validate the whole directory, then commit it all. */
export function ingestReplayDir(spool: Spool, dir: string): ReplayResult {
  const { fixtures, files } = parseReplayDir(dir);
  const result: ReplayResult = { files, conversationsIngested: 0, segmentsIngested: 0, ids: [], aborted: false };
  for (const fixture of fixtures) commitFixture(spool, fixture, result);
  return result;
}

/**
 * Responsive ingest: everything is validated up front (atomic — a later
 * invalid record commits nothing), then committed in bounded batches with an
 * event-loop yield between them so a co-hosted HTTP server stays responsive
 * during a large replay.
 */
export async function ingestReplayDirResponsive(
  spool: Spool,
  dir: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReplayResult> {
  const { fixtures, files } = parseReplayDir(dir);
  const result: ReplayResult = { files, conversationsIngested: 0, segmentsIngested: 0, ids: [], aborted: false };
  for (let i = 0; i < fixtures.length; i += REPLAY_COMMIT_BATCH) {
    // Cooperative cancel: check between batches so no commit runs after a
    // shutdown has been requested (and thus none after the spool is closed).
    if (options.signal?.aborted) {
      result.aborted = true;
      break;
    }
    for (const fixture of fixtures.slice(i, i + REPLAY_COMMIT_BATCH)) {
      commitFixture(spool, fixture, result);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return result;
}