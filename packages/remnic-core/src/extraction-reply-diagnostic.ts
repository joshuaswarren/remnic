import { z } from "zod";

import { extractJsonCandidates } from "./json-extract.js";

const PAYLOAD_KEYS = ["facts", "entities", "profileUpdates", "questions", "relationships", "identityReflection"];
const SAFE_NAME = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/);
const JsonObject = z.record(z.string(), z.unknown());
const MAX_TOP_LEVEL_KEYS = 8;

export type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** True when a parsed JSON value is an object carrying at least one extraction-result key. */
export function looksLikeExtractionResultPayload(parsed: JsonValue): boolean {
  const object = JsonObject.safeParse(parsed);
  return object.success && PAYLOAD_KEYS.some((key) => key in object.data);
}

function safeTopLevelKeys(parsed: JsonValue): string[] {
  const object = JsonObject.safeParse(parsed);
  const keys: string[] = [];
  if (!object.success) return keys;
  for (const key of Object.keys(object.data)) {
    if (keys.length === MAX_TOP_LEVEL_KEYS) break;
    if (SAFE_NAME.safeParse(key).success) keys.push(key);
  }
  return keys;
}

/**
 * What an unusable local-LLM extraction reply looked like, without any of its
 * content (the reply may hold user data). Every field is a count, a boolean, or
 * an identifier-shaped name (`finishReason`, JSON key names); anything else is omitted.
 */
export interface UnusableReplyDiagnostic {
  replyChars: number;
  finishReason: string | undefined;
  startsWithBrace: boolean;
  /** Candidates the extractor tried; the whole reply counts as one when non-empty. */
  jsonCandidates: number;
  parsedAnyJson: boolean;
  /** Candidates that parsed as JSON but carry no extraction-result key. */
  unrecognizedPayloads: number;
  /** From the first candidate that parsed. */
  topLevelKeys: string[];
  partialFacts: number;
}

/** `content` is the trimmed reply; `finishReason` is whatever the client recorded (validated here). */
export function buildUnusableReplyDiagnostic(
  content: string,
  finishReason: string | undefined,
  partialFacts: number,
): UnusableReplyDiagnostic {
  const candidates = extractJsonCandidates(content);
  let parsedAnyJson = false;
  let unrecognizedPayloads = 0;
  let topLevelKeys: string[] = [];
  for (const candidate of candidates) {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsedAnyJson) topLevelKeys = safeTopLevelKeys(parsed);
    parsedAnyJson = true;
    if (!looksLikeExtractionResultPayload(parsed)) unrecognizedPayloads++;
  }
  const reason = SAFE_NAME.safeParse(finishReason);
  return {
    replyChars: content.length,
    finishReason: reason.success ? reason.data : undefined,
    startsWithBrace: content.startsWith("{"),
    jsonCandidates: candidates.length,
    parsedAnyJson,
    unrecognizedPayloads,
    topLevelKeys,
    partialFacts,
  };
}

export function formatUnusableReplyDiagnostic(d: UnusableReplyDiagnostic): string {
  return [
    "extractWithLocalLlm: unusable local reply",
    `replyChars=${d.replyChars}`,
    `finishReason=${d.finishReason ?? "none"}`,
    `startsWithBrace=${d.startsWithBrace}`,
    `jsonCandidates=${d.jsonCandidates}`,
    `parsedAnyJson=${d.parsedAnyJson}`,
    `unrecognizedPayloads=${d.unrecognizedPayloads}`,
    `topLevelKeys=${d.topLevelKeys.join(",")}`,
    `partialFacts=${d.partialFacts}`,
  ].join(" ");
}
