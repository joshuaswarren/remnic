// Entity timeline / structured-section pure helpers extracted from storage.ts
// (issue #1909 PR write-hot-paths). Pure functions only — no I/O — so they are
// safe to share across the write path and entity parsing without circular
// runtime coupling. storage.ts imports these back and re-exports the ones that
// were previously part of its public API.
import { createHash } from "node:crypto";
import { matchEntitySchemaSection, normalizeEntityStructuredSection } from "../entity-schema.js";
import type { EntityFile, EntityStructuredSection, EntityTimelineEntry, PluginConfig } from "../types.js";
export const ENTITY_TIMELINE_METADATA_MARKER = "remnic-meta-v1";

export function parseEntityTimelineBullet(bullet: string, fallbackTimestamp: string): EntityTimelineEntry | null {
  const trimmed = bullet.trim();
  if (!trimmed) return null;

  let rest = trimmed;
  const entry: EntityTimelineEntry = {
    timestamp: trimmed.startsWith("[") ? "" : fallbackTimestamp,
    text: "",
  };
  const consumedMetadataSegments: string[] = [];
  let metadataMarkerSeen = false;
  let literalSingleSourceSegment: string | undefined;

  if (!trimmed.startsWith("[")) {
    entry.text = trimmed;
    return entry.text ? entry : null;
  }

  const firstEnd = trimmed.indexOf("]");
  if (firstEnd === -1) {
    entry.text = trimmed;
    return entry.text ? entry : null;
  }

  const firstToken = trimmed.slice(1, firstEnd).trim();
  const parsedTimestamp = Date.parse(firstToken);
  if (Number.isFinite(parsedTimestamp)) {
    entry.timestamp = firstToken || fallbackTimestamp;
    rest = trimmed.slice(firstEnd + 1).trimStart();
  }

  while (rest.startsWith("[")) {
    const end = findEntityTimelineTokenEnd(rest);
    if (end === -1) break;
    const rawSegment = rest.slice(0, end + 1);
    const token = rest.slice(1, end).trim();
    const nextRest = rest.slice(end + 1).trimStart();
    if (token === ENTITY_TIMELINE_METADATA_MARKER) {
      metadataMarkerSeen = true;
      consumedMetadataSegments.push(rawSegment);
      rest = nextRest;
      continue;
    }
    const equalsIdx = token.indexOf("=");
    if (equalsIdx === -1) {
      if (rest === trimmed) {
        entry.text = trimmed;
        return entry.text ? entry : null;
      }
      break;
    }
    const key = token.slice(0, equalsIdx).trim().toLowerCase();
    const value = unescapeEntityTimelineMetadataValue(token.slice(equalsIdx + 1).trim());
    if (!value) break;
    if (key === "remnic-origin" && !metadataMarkerSeen) {
      entry.text = rest.trim();
      return entry.text ? entry : null;
    }
    switch (key) {
      case "source_meta":
        entry.source = value;
        break;
      case "source":
        if (
          consumedMetadataSegments.length === 0 &&
          !nextRest.startsWith("[") &&
          nextRest.length > 0 &&
          !isManagedEntityTimelineSource(value)
        ) {
          literalSingleSourceSegment = rawSegment;
          rest = nextRest;
          break;
        }
        entry.source = value;
        break;
      case "session":
      case "sessionkey":
        entry.sessionKey = value;
        break;
      case "principal":
        entry.principal = value;
        break;
      case "remnic-origin":
        entry.origin = value;
        break;
      default:
        entry.text = rest.trim();
        return entry.text ? entry : null;
    }
    if (literalSingleSourceSegment) break;
    consumedMetadataSegments.push(rawSegment);
    rest = nextRest;
  }

  if (literalSingleSourceSegment) {
    return {
      timestamp: entry.timestamp,
      text: `${literalSingleSourceSegment} ${rest}`.trim(),
    };
  }
  entry.text = unescapeEntityTimelineText(rest.trim());
  if (!entry.text) return null;
  return entry;
}

export function isEntitySynthesisTimelinePromotionBullet(bullet: string): boolean {
  const trimmed = bullet.trim();
  if (!trimmed.startsWith("[")) return false;

  const firstEnd = findEntityTimelineTokenEnd(trimmed);
  if (firstEnd === -1) return false;

  const firstToken = trimmed.slice(1, firstEnd).trim();
  return looksLikeEntityTimelineTimestamp(firstToken);
}

export function looksLikeEntityTimelineTimestamp(token: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(token)) return false;
  return Number.isFinite(Date.parse(token));
}

export function isManagedEntityTimelineSource(source: string): boolean {
  switch (source.trim().toLowerCase()) {
    case "artifact":
    case "chunking":
    case "cli-migrate":
    case "compounding-promotion":
    case "consolidation":
    case "contradiction-detection":
    case "entity_extraction":
    case "explicit":
    case "explicit-inline":
    case "explicit-inline-review":
    case "explicit-review":
    case "extraction":
    case "extraction-shared-promotion":
    case "manual":
    case "migration":
    case "migration-rechunk":
    case "proactive":
    case "replay":
    case "semantic-consolidation":
    case "unknown":
      return true;
    default:
      return false;
  }
}

export function findEntityTimelineTokenEnd(input: string): number {
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "]") return index;
  }
  return -1;
}

export function escapeEntityTimelineMetadataValue(value: string): string {
  let escaped = "";
  for (const char of value) {
    switch (char) {
      case "\\":
        escaped += "\\\\";
        break;
      case "]":
        escaped += "\\]";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\r":
        escaped += "\\r";
        break;
      case "\t":
        escaped += "\\t";
        break;
      default: {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint < 0x20) {
          escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
        } else {
          escaped += char;
        }
      }
    }
  }
  return escaped;
}

export function unescapeEntityTimelineMetadataValue(value: string): string {
  if (!value.includes("\\")) return value;

  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = value[index + 1];
    if (!next) {
      result += "\\";
      break;
    }

    switch (next) {
      case "n":
        result += "\n";
        index += 1;
        break;
      case "r":
        result += "\r";
        index += 1;
        break;
      case "t":
        result += "\t";
        index += 1;
        break;
      case "u": {
        const hex = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          result += String.fromCharCode(parseInt(hex, 16));
          index += 5;
          break;
        }
        result += "u";
        index += 1;
        break;
      }
      default:
        result += next;
        index += 1;
        break;
    }
  }
  return result;
}
export function escapeEntityTimelineText(value: string): string {
  return value.startsWith("[remnic-origin=") ? `\\${value}` : value;
}

export function unescapeEntityTimelineText(value: string): string {
  return value.startsWith("\\[remnic-origin=") ? value.slice(1) : value;
}

export function serializeEntityTimelineEntry(entry: EntityTimelineEntry): string {
  const tokens: string[] = [];
  if (entry.timestamp.trim().length > 0) {
    tokens.push(`[${entry.timestamp}]`);
  }
  if (entry.source) {
    const sourceKey = isManagedEntityTimelineSource(entry.source) ? "source" : "source_meta";
    tokens.push(`[${sourceKey}=${escapeEntityTimelineMetadataValue(entry.source)}]`);
  }
  if (entry.sessionKey) {
    tokens.push(`[session=${escapeEntityTimelineMetadataValue(entry.sessionKey)}]`);
  }
  if (entry.principal) {
    tokens.push(`[principal=${escapeEntityTimelineMetadataValue(entry.principal)}]`);
  }
  if (entry.origin) {
    tokens.push(`[${ENTITY_TIMELINE_METADATA_MARKER}]`);
    tokens.push(`[remnic-origin=${escapeEntityTimelineMetadataValue(entry.origin)}]`);
  }
  const serializedMetadata = tokens.length > 0 ? `${tokens.join(" ")} ` : "";
  return `- ${serializedMetadata}${escapeEntityTimelineText(entry.text)}`.trimEnd();
}

export function dedupeEntityTimelineFacts(timeline: EntityTimelineEntry[]): string[] {
  return [...new Set(timeline.map((entry) => entry.text.trim()).filter((entry) => entry.length > 0))];
}

export function normalizeEntitySectionFact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeStructuredSectionFactsWithOrigins(
  facts: string[],
  factOrigins?: Array<string | undefined>,
  defaultOrigin?: string,
): Pick<EntityStructuredSection, "facts" | "factOrigins"> {
  const normalizedFacts: string[] = [];
  const origins: Array<string | undefined> = [];
  const seen = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    const normalized = normalizeEntitySectionFact(fact);
    if (!normalized) continue;
    const existingIndex = normalizedFacts.indexOf(normalized);
    const origin = factOrigins?.[index] ?? defaultOrigin;
    if (existingIndex >= 0) {
      if (origins[existingIndex] !== origin) origins[existingIndex] = undefined;
      continue;
    }
    normalizedFacts.push(normalized);
    origins.push(origin);
  }
  return {
    facts: normalizedFacts,
    ...(origins.some((origin) => origin !== undefined) ? { factOrigins: origins } : {}),
  };
}
export function normalizeStructuredSectionFacts(facts: string[]): string[] {
  return [...new Set(facts.map((fact) => normalizeEntitySectionFact(fact)).filter((fact) => fact.length > 0))];
}

export function collectStructuredSectionFacts(structuredSections: EntityStructuredSection[]): string[] {
  const facts: string[] = [];
  for (const section of structuredSections) {
    for (const fact of section.facts) {
      const normalized = normalizeEntitySectionFact(fact);
      if (!normalized) continue;
      facts.push(normalized);
    }
  }
  return [...new Set(facts)];
}

export function compileEntityFacts(
  timeline: EntityTimelineEntry[],
  structuredSections: EntityStructuredSection[]
): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const fact of dedupeEntityTimelineFacts(timeline)) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    facts.push(fact);
  }
  for (const fact of collectStructuredSectionFacts(structuredSections)) {
    if (seen.has(fact)) continue;
    seen.add(fact);
    facts.push(fact);
  }
  return facts;
}

function parseEntityStructuredSectionFacts(
  lines: string[],
): Pick<EntityStructuredSection, "facts" | "factOrigins"> {
  const facts: string[] = [];
  const factOrigins: Array<string | undefined> = [];
  let currentBlock: string[] = [];
  let currentOrigin: string | undefined;

  const flushCurrentBlock = (): void => {
    const normalized = normalizeEntitySectionFact(currentBlock.join(" "));
    if (normalized.length > 0) {
      facts.push(normalized);
      factOrigins.push(currentOrigin);
    }
    currentBlock = [];
    currentOrigin = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushCurrentBlock();
      continue;
    }
    if (line.startsWith("- ")) {
      flushCurrentBlock();
      const bullet = line.slice(2).trim();
      const metadataPrefix = `[${ENTITY_TIMELINE_METADATA_MARKER}] `;
      const hasMarker = bullet.startsWith(metadataPrefix);
      const originStart = hasMarker ? metadataPrefix.length : 0;
      const escapedOrigin = bullet.startsWith("\\[remnic-origin=", originStart);
      const originPrefix = bullet.startsWith("[remnic-origin=", originStart);
      const originEnd = !escapedOrigin && originPrefix
        ? findEntityTimelineTokenEnd(bullet.slice(originStart)) + originStart
        : -1;
      const token = originEnd >= 0 ? bullet.slice(originStart + 15, originEnd) : "";
      currentBlock = [originEnd >= 0
        ? bullet.slice(originEnd + 1).trimStart()
        : unescapeEntityTimelineText(bullet)];
      currentOrigin = originEnd >= 0 && hasMarker
        ? unescapeEntityTimelineMetadataValue(token)
        : undefined;
      continue;
    }
    currentBlock.push(line);
  }
  flushCurrentBlock();
  return normalizeStructuredSectionFactsWithOrigins(facts, factOrigins);
}
function looksLikeStructuredSectionFactList(lines: string[]): boolean {
  const firstNonBlank = lines.find((line) => line.trim().length > 0)?.trim() ?? "";
  return firstNonBlank.startsWith("- ");
}

export function partitionEntityStructuredSections(
  entityType: string,
  extraSections: Array<{ title: string; lines: string[] }>,
  entitySchemas?: PluginConfig["entitySchemas"]
): {
  structuredSections: EntityStructuredSection[];
  remainingExtraSections: Array<{ title: string; lines: string[] }>;
} {
  const structuredSections: EntityStructuredSection[] = [];
  const remainingExtraSections: Array<{ title: string; lines: string[] }> = [];
  const structuredSectionIndex = new Map<string, EntityStructuredSection>();

  for (const section of extraSections) {
    const matchedSection = matchEntitySchemaSection(entityType, section.title, entitySchemas);
    if (!matchedSection && !looksLikeStructuredSectionFactList(section.lines)) {
      remainingExtraSections.push(section);
      continue;
    }
    const parsedFacts = parseEntityStructuredSectionFacts(section.lines);
    if (!matchedSection && parsedFacts.facts.length === 0) {
      remainingExtraSections.push(section);
      continue;
    }
    const normalizedSection = matchedSection
      ? { key: matchedSection.key, title: matchedSection.title }
      : normalizeEntityStructuredSection(entityType, { key: section.title, title: section.title }, entitySchemas);
    if (parsedFacts.facts.length === 0) {
      remainingExtraSections.push(section);
      continue;
    }
    const existing = structuredSectionIndex.get(normalizedSection.key);
    if (existing) {
      const existingOrigins = existing.facts.map((_, index) => existing.factOrigins?.[index]);
      const incomingOrigins = parsedFacts.facts.map((_, index) => parsedFacts.factOrigins?.[index]);
      const merged = normalizeStructuredSectionFactsWithOrigins(
        [...existing.facts, ...parsedFacts.facts],
        [...existingOrigins, ...incomingOrigins],
      );
      existing.facts = merged.facts;
      existing.factOrigins = merged.factOrigins;
      continue;
    }
    const structuredSection: EntityStructuredSection = {
      key: normalizedSection.key,
      title: normalizedSection.title,
      facts: parsedFacts.facts,
      ...(parsedFacts.factOrigins ? { factOrigins: parsedFacts.factOrigins } : {}),
    };
    structuredSections.push(structuredSection);
    structuredSectionIndex.set(normalizedSection.key, structuredSection);
  }

  return {
    structuredSections,
    remainingExtraSections,
  };
}

export function latestEntityTimelineTimestamp(entity: EntityFile): string | undefined {
  let latestRaw: string | undefined;
  for (const entry of entity.timeline) {
    const timestamp = entry.timestamp.trim();
    if (!timestamp) continue;
    if (!latestRaw || compareEntityTimestamps(timestamp, latestRaw) > 0) {
      latestRaw = timestamp;
    }
  }
  return latestRaw;
}

export function compareEntityTimestamps(left?: string, right?: string): number {
  const leftValue = left?.trim() ?? "";
  const rightValue = right?.trim() ?? "";

  if (!leftValue && !rightValue) return 0;
  if (!leftValue) return -1;
  if (!rightValue) return 1;

  const leftMs = Date.parse(leftValue);
  const rightMs = Date.parse(rightValue);
  const leftParsed = Number.isFinite(leftMs);
  const rightParsed = Number.isFinite(rightMs);

  if (leftParsed && rightParsed) {
    if (leftMs === rightMs) return 0;
    return leftMs > rightMs ? 1 : -1;
  }
  if (leftParsed) return 1;
  if (rightParsed) return -1;
  return leftValue.localeCompare(rightValue);
}

export function countEntityStructuredFacts(entity: EntityFile): number {
  return (entity.structuredSections ?? []).reduce((count, section) => count + section.facts.length, 0);
}

export function fingerprintEntityStructuredFacts(entity: Pick<EntityFile, "structuredSections">): string | undefined {
  const normalizedSections = (entity.structuredSections ?? [])
    .map((section) => ({
      key: section.key.trim().toLowerCase(),
      title: section.title.replace(/\s+/g, " ").trim(),
      facts: normalizeStructuredSectionFacts(section.facts)
        .slice()
        .sort((left, right) => left.localeCompare(right)),
    }))
    .filter((section) => section.facts.length > 0)
    .sort(
      (left, right) =>
        left.key.localeCompare(right.key) ||
        left.title.localeCompare(right.title) ||
        left.facts.join("\n").localeCompare(right.facts.join("\n"))
    );
  if (normalizedSections.length === 0) return undefined;
  return createHash("sha256").update(JSON.stringify(normalizedSections)).digest("hex");
}

export function isEntitySynthesisStale(entity: EntityFile): boolean {
  const structuredFactCount = countEntityStructuredFacts(entity);
  const structuredFactDigest = fingerprintEntityStructuredFacts(entity);
  const storedStructuredFactDigest = entity.synthesisStructuredFactDigest?.trim() || undefined;
  if (entity.timeline.length === 0 && structuredFactCount === 0) return false;
  if (!entity.synthesis?.trim()) return true;
  if (entity.synthesisTimelineCount === undefined) return true;
  if (structuredFactCount > 0 && entity.synthesisStructuredFactCount === undefined) return true;
  if (structuredFactCount > 0 && !storedStructuredFactDigest) return true;
  const latestTimelineTimestamp = latestEntityTimelineTimestamp(entity);
  if (!latestTimelineTimestamp) {
    return (
      entity.timeline.length > entity.synthesisTimelineCount ||
      structuredFactCount > (entity.synthesisStructuredFactCount ?? 0) ||
      structuredFactDigest !== storedStructuredFactDigest
    );
  }
  if (!entity.synthesisUpdatedAt?.trim()) return true;
  const timelineFreshness = compareEntityTimestamps(latestTimelineTimestamp, entity.synthesisUpdatedAt);
  if (timelineFreshness > 0) return true;
  return (
    entity.timeline.length > entity.synthesisTimelineCount ||
    structuredFactCount > (entity.synthesisStructuredFactCount ?? 0) ||
    structuredFactDigest !== storedStructuredFactDigest
  );
}
