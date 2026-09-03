import { parseOriginClass } from "../security/origin-authority.js";
import { normalizeAttributePairs } from "../structured-attributes.js";
import { buildProcedurePersistBody } from "../procedural/procedure-types.js";
import { screenCandidateFact } from "../security/injection-screen.js";
import type { InjectionScreenProfile } from "../security/injection-screen.js";
import type { EntityStructuredSection } from "../types.js";

export interface InjectionScreenCandidate {
  content: string;
  category?: string;
  structuredAttributes?: Record<string, unknown>;
  procedureSteps?: unknown;
}

export interface InjectionScreenGateResult {
  status?: "pending_review";
  tags: string[];
}

/** Serialize the body fields that the persistence path will store. */
export function serializeInjectionScreenCandidate(candidate: InjectionScreenCandidate): string {
  const body =
    candidate.category === "procedure"
      ? buildProcedurePersistBody(candidate.content, candidate.procedureSteps)
      : candidate.content;
  // Salvage malformed extractor output: non-string attribute values (e.g.
  // `{ priority: 1 }`) must not throw and abort the whole extraction batch
  // (#1955 review). Coerce primitives; drop anything else.
  const attrs = Object.fromEntries(
    Object.entries(candidate.structuredAttributes ?? {}).flatMap(([key, value]): Array<[string, string]> => {
      if (typeof value === "string") return [[key, value]];
      if (typeof value === "number" || typeof value === "boolean") return [[key, String(value)]];
      return [];
    }),
  );
  return Object.keys(attrs).length > 0
    ? `${body}\n[Attributes: ${normalizeAttributePairs(attrs)}]`
    : body;
}

/** Screen one candidate and assemble the persistence effects. */
export function evaluateInjectionScreen(
  candidate: InjectionScreenCandidate | string,
  enabled: boolean,
  profile: InjectionScreenProfile = "default",
): InjectionScreenGateResult {
  if (!enabled) return { tags: [] };
  const content =
    typeof candidate === "string" ? candidate : serializeInjectionScreenCandidate(candidate);
  const result = screenCandidateFact(content, profile);
  return {
    status: result.quarantine === true ? "pending_review" : undefined,
    tags: result.quarantine === true
      ? result.findings.map((finding) => `injection-screen:${finding.rule}`)
      : [],
  };
}

/**
 * Withhold injection-flagged strings from an entity-index write (#1955
 * review): entity facts/sections have no review status, so a flagged field is
 * excluded from the recallable index and surfaced via the returned rules for
 * the caller to log. Screen off → strings pass through unfiltered.
 */
export function withholdScreenedStrings(
  values: readonly unknown[],
  enabled: boolean,
  profile: InjectionScreenProfile = "default",
): { kept: string[]; withheldRules: string[] } {
  const kept: string[] = [];
  const withheldRules: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    if (!enabled) {
      kept.push(value);
      continue;
    }
    const screened = screenCandidateFact(value, profile);
    if (screened.quarantine) {
      withheldRules.push(...screened.findings.map((finding) => `injection-screen:${finding.rule}`));
    } else {
      kept.push(value);
    }
  }
  return { kept, withheldRules };
}

export interface ScreenedEntityWrite {
  name: string;
  type: string;
  source: string;
  facts: string[];
  structuredSections?: EntityStructuredSection[];
  withheldRules: string[];
  /** True when the entity NAME itself was flagged — callers must not index it. */
  withheld: boolean;
}

/**
 * Validate and screen one extracted entity before it enters the entity index
 * (#1955 review): flagged facts/section facts are withheld and reported via
 * `withheldRules` (entities carry no review status; routing is #2397).
 * Returns null for entities without a usable name/type.
 */
export function screenEntityForIndex(entity: unknown, enabled: boolean, profile: InjectionScreenProfile = "default"): ScreenedEntityWrite | null {
  const record = entity as { name?: unknown; type?: unknown; source?: unknown; facts?: unknown; structuredSections?: unknown } | null;
  const name = record?.name;
  const type = record?.type;
  if (typeof name !== "string" || !name.trim() || typeof type !== "string" || !type.trim()) return null;
  // #1955 review: the raw name is emitted as the entity target outside the
  // snippet fence — a flagged name withholds the whole entity from the index.
  const nameScreen = withholdScreenedStrings([name], enabled, profile);
  const factScreen = withholdScreenedStrings(Array.isArray(record?.facts) ? record.facts : [], enabled, profile);
  const rawSections: EntityStructuredSection[] | undefined = Array.isArray(record?.structuredSections)
    ? (record.structuredSections as EntityStructuredSection[])
    : undefined;
  const sectionScreens = enabled && rawSections
    ? rawSections.map((section) => ({ section, screen: withholdScreenedStrings(section?.facts ?? [], true, profile) }))
    : undefined;
  return {
    name,
    type,
    source: typeof record?.source === "string" ? record.source : "extraction",
    facts: factScreen.kept,
    ...(sectionScreens
      ? {
        structuredSections: sectionScreens.map(({ section, screen }) => {
          let nextFactIndex = 0;
          const factOrigins = screen.kept.map((fact) => {
            const factIndex = section.facts.indexOf(fact, nextFactIndex);
            nextFactIndex = factIndex + 1;
            const origin = section.factOrigins?.[factIndex];
            return origin === undefined ? undefined : parseOriginClass(origin);
          });
          return {
            ...section,
            facts: screen.kept,
            ...(factOrigins.some((origin) => origin !== undefined) ? { factOrigins } : {}),
          };
        }),
      }
      : rawSections
        ? { structuredSections: rawSections }
        : {}),
    withheldRules: [
      ...nameScreen.withheldRules,
      ...factScreen.withheldRules,
      ...(sectionScreens ?? []).flatMap(({ screen }) => screen.withheldRules),
    ],
    withheld: nameScreen.withheldRules.length > 0,
  };
}

/**
 * Screen a batch of persist-bound strings and preformat the withheld warning
 * (#1955): keeps persist call sites within their file-size ratchet.
 */
export function screenPersistStrings(
  values: readonly string[],
  enabled: boolean,
  profile: InjectionScreenProfile = "default",
): { kept: string[]; warning?: string } {
  const screen = withholdScreenedStrings(values, enabled, profile);
  return {
    kept: screen.kept,
    ...(screen.withheldRules.length > 0
      ? { warning: `injection screen withheld ${values.length - screen.kept.length} candidate(s) [${screen.withheldRules.join(", ")}]` }
      : {}),
  };
}
