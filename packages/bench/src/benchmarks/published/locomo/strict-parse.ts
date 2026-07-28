/**
 * Strict LoCoMo dataset parsing for the runner path (extracted from
 * runner.ts under the structural ratchet, issue #1995).
 *
 * Unlike the lenient shared loader, this parser rejects malformed
 * conversations with location-annotated errors instead of skipping them.
 */

import { normalizeLoCoMoQa } from "../dataset-loader.js";
import type { LoCoMoConversation, LoCoMoQA, LoCoMoTurn } from "./fixture.js";

export function parseDataset(
  raw: string,
  filename: string,
): LoCoMoConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `LoCoMo dataset file ${filename} must contain an array of conversations.`,
    );
  }

  return parsed.map((entry, index) => parseConversation(entry, filename, index));
}

function parseConversation(
  entry: unknown,
  filename: string,
  index: number,
): LoCoMoConversation {
  const location = `LoCoMo dataset file ${filename} conversation ${index + 1}`;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${location} must be an object.`);
  }

  const record = entry as Record<string, unknown>;
  if (typeof record.sample_id !== "string") {
    throw new Error(`${location} must include a string sample_id.`);
  }
  if (
    !record.conversation ||
    typeof record.conversation !== "object" ||
    Array.isArray(record.conversation)
  ) {
    throw new Error(`${location} must include a conversation object.`);
  }
  const qa = normalizeQaArray(record.qa, location);
  const conversation = normalizeLoCoMoConversationSessions(
    record.conversation as Record<string, unknown>,
    location,
  );

  return {
    sample_id: record.sample_id,
    conversation,
    qa,
    event_summary: record.event_summary,
    observation: record.observation,
    session_summary: record.session_summary,
  };
}

function normalizeLoCoMoConversationSessions(
  conversation: Record<string, unknown>,
  location: string,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...conversation };
  const sessionKeys = Object.keys(conversation)
    .filter((key) => /^session_\d+$/.test(key))
    .sort((a, b) =>
      Number.parseInt(a.replace("session_", ""), 10) -
      Number.parseInt(b.replace("session_", ""), 10)
    );
  if (sessionKeys.length === 0) {
    throw new Error(`${location} conversation must include at least one session_N array.`);
  }

  for (const sessionKey of sessionKeys) {
    const session = conversation[sessionKey];
    if (!Array.isArray(session)) {
      throw new Error(`${location} conversation.${sessionKey} must be an array of turns.`);
    }
    normalized[sessionKey] = session.map((turn, index) =>
      normalizeLoCoMoTurn(turn, `${location} conversation.${sessionKey}[${index}]`),
    );
  }
  return normalized;
}

function normalizeLoCoMoTurn(turn: unknown, location: string): LoCoMoTurn {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) {
    throw new Error(`${location} must be a turn object.`);
  }
  const record = turn as Record<string, unknown>;
  const speaker = requireNonEmptyString(record.speaker, `${location}.speaker`);
  const dia_id = requireNonEmptyString(record.dia_id, `${location}.dia_id`);
  const text = requireNonEmptyString(record.text, `${location}.text`);
  const normalized: LoCoMoTurn = { speaker, dia_id, text };
  if (record.query !== undefined) {
    normalized.query = requireString(record.query, `${location}.query`);
  }
  if (record.blip_caption !== undefined) {
    normalized.blip_caption = requireString(record.blip_caption, `${location}.blip_caption`);
  }
  return normalized;
}

function requireString(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, location: string): string {
  const text = requireString(value, location);
  if (text.trim().length === 0) {
    throw new Error(`${location} must be a non-empty string.`);
  }
  return text;
}

function normalizeQaArray(value: unknown, location: string): LoCoMoQA[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${location} must include a qa array with question/answer/evidence/category fields.`,
    );
  }

  return value.map((entry, index) =>
    normalizeLoCoMoQa(entry, `${location} qa[${index}]`),
  );
}
