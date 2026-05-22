import type { SignalLevel, SignalScanResult } from "./types.js";

const BUILTIN_HIGH_PATTERNS: RegExp[] = [
  /\bactually,?\s+(i|my|we)\b/i,
  /\bno,?\s+(i|my|we|that'?s)\s+(not|wrong|incorrect)\b/i,
  /\bthat'?s\s+not\s+right\b/i,
  /\bwhy\s+did\s+you\s+say\s+that\b/i,
  /\bi\s+(?:always|never|prefer|hate|love|want|need)\b/i,
  /\bdon'?t\s+(?:use|do|call|say|make)\b/i,
  /\bplease\s+(?:always|never|remember|note)\b/i,
  /\bcorrection:?\b/i,
  /\bimportant:?\s+/i,
  /\bfyi:?\b/i,
  /\bfor\s+(?:the\s+)?record\b/i,
  /\bmy\s+(?:name|email|company|role|title|preference)\s+is\b/i,
  /\bi\s+(?:work|live|am)\s+(?:at|in|from|a)\b/i,
  /\bwe\s+(?:decided|agreed|chose|picked)\b/i,
  /\bthe\s+decision\s+(?:is|was)\b/i,
  /\bgoing\s+forward\b/i,
  /\bfrom\s+now\s+on\b/i,
];

const MEDIUM_PATTERNS: RegExp[] = [
  /\bi\s+(?:think|believe|feel)\b/i,
  /\busually\b/i,
  /\btypically\b/i,
  /\bi\s+(?:like|dislike)\b/i,
  /\bmy\s+(?:team|project|stack|setup)\b/i,
];

const DISAGREEMENT_PATTERNS: RegExp[] = [
  /\bthat'?s\s+not\s+right\b/i,
  /\bwhy\s+did\s+you\s+say\s+that\b/i,
  /\bthat'?s\s+wrong\b/i,
  /\bnot\s+correct\b/i,
];

export function isDisagreementPrompt(text: string): boolean {
  for (const rx of DISAGREEMENT_PATTERNS) {
    if (rx.test(text)) return true;
  }
  return false;
}

export function scanSignals(
  text: string,
  customPatterns: string[] = [],
): SignalScanResult {
  const matched: string[] = [];

  const customRegexes: RegExp[] = [];
  for (const pattern of customPatterns) {
    try {
      customRegexes.push(new RegExp(pattern, "i"));
    } catch {
      // Invalid custom patterns should not make the scan path fail closed.
    }
  }

  for (const rx of customRegexes) {
    if (rx.test(text)) {
      matched.push(`custom:${rx.source}`);
    }
  }

  for (const rx of BUILTIN_HIGH_PATTERNS) {
    if (rx.test(text)) {
      matched.push(`high:${rx.source}`);
    }
  }

  if (matched.length > 0) {
    return { level: "high", patterns: matched };
  }

  const mediumMatched: string[] = [];
  for (const rx of MEDIUM_PATTERNS) {
    if (rx.test(text)) {
      mediumMatched.push(`medium:${rx.source}`);
    }
  }

  if (mediumMatched.length >= 2) {
    return { level: "medium", patterns: mediumMatched };
  }
  if (mediumMatched.length === 1) {
    return { level: "low", patterns: mediumMatched };
  }

  return { level: "none", patterns: [] };
}
