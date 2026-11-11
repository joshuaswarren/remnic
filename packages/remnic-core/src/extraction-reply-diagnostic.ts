import { extractJsonCandidates } from "./json-extract.js";

const SHAPE_KEYS = ["facts", "entities", "profileUpdates", "questions", "relationships", "identityReflection"];
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MAX_TOP_LEVEL_KEYS = 8;

/** True when a parsed JSON value has the top-level shape of an extraction result. */
export function looksLikeExtractionResultPayload(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    SHAPE_KEYS.some((key) => key in parsed)
  );
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
  jsonCandidates: number;
  parsedAnyJson: boolean;
  payloadShapeRejected: number;
  topLevelKeys: string[];
  partialFacts: number;
}

/** `content` is the trimmed reply; `finishReason` is whatever the client reported (validated here). */
export function buildUnusableReplyDiagnostic(
  content: string,
  finishReason: unknown,
  partialFacts: number,
): UnusableReplyDiagnostic {
  const candidates = extractJsonCandidates(content);
  let parsedAnyJson = false;
  let payloadShapeRejected = 0;
  let topLevelKeys: string[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsedAnyJson && typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      topLevelKeys = Object.keys(parsed).filter((key) => SAFE_NAME.test(key)).slice(0, MAX_TOP_LEVEL_KEYS);
    }
    parsedAnyJson = true;
    if (!looksLikeExtractionResultPayload(parsed)) payloadShapeRejected++;
  }
  return {
    replyChars: content.length,
    finishReason: typeof finishReason === "string" && SAFE_NAME.test(finishReason) ? finishReason : undefined,
    startsWithBrace: content.startsWith("{"),
    jsonCandidates: candidates.length,
    parsedAnyJson,
    payloadShapeRejected,
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
    `payloadShapeRejected=${d.payloadShapeRejected}`,
    `topLevelKeys=${d.topLevelKeys.join(",")}`,
    `partialFacts=${d.partialFacts}`,
  ].join(" ");
}
