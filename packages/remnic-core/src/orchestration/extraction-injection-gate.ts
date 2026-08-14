/**
 * Pure issue #1955 injection-screen gate for extracted facts.
 */

import { screenCandidateFact } from "../security/injection-screen.js";

export interface InjectionScreenGateResult {
  status?: "pending_review";
  tags: string[];
}

/** Screen one candidate and assemble the persistence effects. */
export function evaluateInjectionScreen(
  content: string,
  enabled: boolean,
): InjectionScreenGateResult {
  if (!enabled) return { tags: [] };
  const result = screenCandidateFact(content);
  return {
    status: result.quarantine === true ? "pending_review" : undefined,
    tags: result.quarantine === true
      ? result.findings.map((finding) => `injection-screen:${finding.rule}`)
      : [],
  };
}
