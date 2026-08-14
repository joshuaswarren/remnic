/**
 * Pure issue #1955 injection-screen gate for extracted facts.
 */

import { normalizeAttributePairs } from "../structured-attributes.js";
import { buildProcedurePersistBody } from "../procedural/procedure-types.js";
import { screenCandidateFact } from "../security/injection-screen.js";

export interface InjectionScreenCandidate {
  content: string;
  category?: string;
  structuredAttributes?: Record<string, string>;
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
  return candidate.structuredAttributes && Object.keys(candidate.structuredAttributes).length > 0
    ? `${body}\n[Attributes: ${normalizeAttributePairs(candidate.structuredAttributes)}]`
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
