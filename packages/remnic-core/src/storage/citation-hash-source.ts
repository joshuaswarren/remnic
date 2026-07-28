/**
 * Citation-marker stripping for dedup-hash sources (extracted from storage.ts
 * under the #1995 structural ratchet; behavior unchanged).
 *
 * Content persisted with an injected citation block must hash to the SAME
 * value as its raw form (AGENTS.md #13/#23 hash-consistency rules), so the
 * hash source strips the configured citation template — literal template
 * parts matched in order, whitespace around the marker normalized — without
 * building a regex from template text (AGENTS.md #34).
 */
import { DEFAULT_CITATION_FORMAT } from "../source-attribution.js";

function trimTrailingSpacesAndTabs(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === " " || value[end - 1] === "\t")) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function trimLeadingSpacesAndTabs(value: string): string {
  let start = 0;
  while (start < value.length && (value[start] === " " || value[start] === "\t")) {
    start += 1;
  }
  return start === 0 ? value : value.slice(start);
}

export function stripDefaultCitationMarkersWithoutRegex(value: string): string {
  return stripCitationMarkersForHashRemoval(value, DEFAULT_CITATION_FORMAT);
}

function citationTemplateLiteralParts(template: string): string[] {
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{", cursor);
    if (open === -1) {
      parts.push(template.slice(cursor));
      break;
    }
    parts.push(template.slice(cursor, open));
    const close = template.indexOf("}", open + 1);
    if (close === -1) {
      cursor = open + 1;
    } else {
      cursor = close + 1;
    }
  }
  return parts.filter((part) => part.length > 0);
}

export function stripCitationMarkersForHashRemoval(value: string, template: string): string {
  const parts = citationTemplateLiteralParts(template);
  if (parts.length === 0) return value;
  const first = parts[0]!;
  const lowerValue = value.toLowerCase();
  const lowerFirst = first.toLowerCase();
  const lowerParts = parts.map((part) => part.toLowerCase());
  if (!lowerValue.includes(lowerFirst)) return value;

  let result = "";
  let cursor = 0;
  let removed = false;
  while (cursor < value.length) {
    const markerStart = lowerValue.indexOf(lowerFirst, cursor);
    if (markerStart === -1) {
      result += value.slice(cursor);
      break;
    }
    const boundedEnd = first.startsWith("[") ? value.indexOf("]", markerStart + first.length) : -1;
    if (first.startsWith("[") && boundedEnd === -1) {
      result += value.slice(cursor);
      break;
    }
    const searchLimit = boundedEnd === -1 ? value.length : boundedEnd + 1;
    let markerEnd = markerStart + first.length;
    let matched = true;
    for (let i = 1; i < lowerParts.length; i += 1) {
      const partIndex = lowerValue.indexOf(lowerParts[i]!, markerEnd);
      if (partIndex === -1 || partIndex + parts[i]!.length > searchLimit) {
        matched = false;
        break;
      }
      markerEnd = partIndex + parts[i]!.length;
    }
    if (!matched) {
      result += value.slice(cursor);
      break;
    }
    result += trimTrailingSpacesAndTabs(value.slice(cursor, markerStart));
    cursor = markerEnd;
    removed = true;
  }

  return removed ? trimLeadingSpacesAndTabs(result) : value;
}
