/**
 * Pure issue #1955 injection-screen gate for extracted facts.
 */

import { normalizeAttributePairs } from "../structured-attributes.js";
import { buildProcedurePersistBody } from "../procedural/procedure-types.js";
import { screenCandidateFact } from "../security/injection-screen.js";

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
): InjectionScreenGateResult {
  if (!enabled) return { tags: [] };
  const content =
    typeof candidate === "string" ? candidate : serializeInjectionScreenCandidate(candidate);
  const result = screenCandidateFact(content);
  return {
    status: result.quarantine === true ? "pending_review" : undefined,
    tags: result.quarantine === true
      ? result.findings.map((finding) => `injection-screen:${finding.rule}`)
      : [],
  };
}
