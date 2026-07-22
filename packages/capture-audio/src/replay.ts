/**
 * `--replay <dir>` ingestion. Feeds synthetic fixture conversations into
 * the spool so the entire read path (spool + HTTP API) is testable in CI
 * without capture hardware or STT. Fixtures are synthetic by policy — no
 * real audio or conversation data lives in the repo, and none is required
 * for tests.
 *
 * Each `*.json` fixture is either a single conversation object or an array
 * of them. Shape (validated loudly; malformed → CaptureConfigError naming
 * the file):
 *
 *   {
 *     "id": "conv_demo1",                       // optional; generated if absent
 *     "startedAtUtc": "2026-07-20T15:00:00.000Z",
 *     "endedAtUtc":  "2026-07-20T15:05:00.000Z", // optional
 *     "state": "final",                          // optional; default "final"
 *     "device": "MacBook mic",                   // optional
 *     "speakers": [                               // optional cluster labels
 *       { "id": "spk_1", "label": "Alice", "isSelf": false }
 *     ],
 *     "segments": [
 *       { "speakerCluster": "spk_1", "isWearer": false, "channel": "mic",
 *         "text": "hello there", "startUtc": "...", "endUtc": "..." }
 *     ]
 *   }
 *
 * Ingestion is idempotent by conversation id (see Spool.insertConversation),
 * so re-running a replay is a content no-op.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CaptureConfigError } from "./errors.js";
import type { ConversationInput, SegmentInput, Spool } from "./spool.js";

export interface ReplayResult {
  files: number;
  conversationsIngested: number;
  segmentsIngested: number;
  ids: string[];
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CaptureConfigError(`${where}: expected a conversation object`);
  }
  return value as Record<string, unknown>;
}

function parseSegment(raw: unknown, where: string): SegmentInput {
  const obj = asObject(raw, where);
  if (typeof obj.text !== "string" || obj.text === "") {
    throw new CaptureConfigError(`${where}.text: expected a non-empty string`);
  }
  if (typeof obj.startUtc !== "string" || typeof obj.endUtc !== "string") {
    throw new CaptureConfigError(`${where}: startUtc and endUtc must be ISO strings`);
  }
  return {
    speakerCluster: typeof obj.speakerCluster === "string" ? obj.speakerCluster : null,
    isWearer: obj.isWearer === true,
    channel: typeof obj.channel === "string" && obj.channel !== "" ? obj.channel : "mic",
    text: obj.text,
    startUtc: obj.startUtc,
    endUtc: obj.endUtc,
  };
}

function parseConversation(raw: unknown, where: string): ConversationInput {
  const obj = asObject(raw, where);
  if (typeof obj.startedAtUtc !== "string" || obj.startedAtUtc === "") {
    throw new CaptureConfigError(`${where}.startedAtUtc: expected an ISO timestamp`);
  }
  if (!Array.isArray(obj.segments)) {
    throw new CaptureConfigError(`${where}.segments: expected an array`);
  }
  const state = obj.state === "capturing" ? "capturing" : "final";
  return {
    id: typeof obj.id === "string" && obj.id !== "" ? obj.id : undefined,
    startedAtUtc: obj.startedAtUtc,
    endedAtUtc: typeof obj.endedAtUtc === "string" ? obj.endedAtUtc : null,
    state,
    device: typeof obj.device === "string" ? obj.device : null,
    segments: obj.segments.map((seg, i) => parseSegment(seg, `${where}.segments[${i}]`)),
  };
}

function ingestSpeakers(spool: Spool, raw: unknown, where: string): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    throw new CaptureConfigError(`${where}.speakers: expected an array`);
  }
  raw.forEach((entry, i) => {
    const obj = asObject(entry, `${where}.speakers[${i}]`);
    if (typeof obj.id !== "string" || obj.id === "") {
      throw new CaptureConfigError(`${where}.speakers[${i}].id: expected a non-empty string`);
    }
    spool.upsertSpeaker({
      id: obj.id,
      label: typeof obj.label === "string" ? obj.label : null,
      isSelf: obj.isSelf === true,
    });
  });
}

export function ingestReplayDir(spool: Spool, dir: string): ReplayResult {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    throw new CaptureConfigError(`replay dir not found or unreadable: ${dir}`);
  }
  if (entries.length === 0) {
    throw new CaptureConfigError(`replay dir ${dir} contains no *.json fixtures`);
  }
  const result: ReplayResult = { files: 0, conversationsIngested: 0, segmentsIngested: 0, ids: [] };
  for (const name of entries) {
    const filePath = path.join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new CaptureConfigError(`replay fixture ${name} is not valid JSON: ${(err as Error).message}`);
    }
    result.files += 1;
    const docs = Array.isArray(parsed) ? parsed : [parsed];
    docs.forEach((doc, i) => {
      const where = `${name}[${i}]`;
      ingestSpeakers(spool, asObject(doc, where).speakers, where);
      const conv = parseConversation(doc, where);
      const id = spool.insertConversation(conv);
      result.ids.push(id);
      result.conversationsIngested += 1;
      result.segmentsIngested += conv.segments.length;
    });
  }
  return result;
}
