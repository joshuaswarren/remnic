/**
 * Session-experience recall helpers (issue #2979 layer 2).
 *
 * Promoted experience memories are `category: procedure`, so they already
 * compete in `buildProcedureRecallSection` and share `recallMaxProcedures`.
 * These helpers add situation-overlap scoring and an Experience preview.
 * Call them only when `sessionExperience.enabled` is true — the gate-off
 * path must not inspect experience attributes.
 */

import type { MemoryFile } from "../types.js";

function tokenOverlapScore(prompt: string, memoryText: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
  const promptTokens = new Set(norm(prompt));
  const memTokens = new Set(norm(memoryText));
  if (promptTokens.size === 0 || memTokens.size === 0) return 0;
  let inter = 0;
  for (const t of promptTokens) {
    if (memTokens.has(t)) inter++;
  }
  const union = new Set([...promptTokens, ...memTokens]);
  return inter / Math.max(1, union.size);
}

export function isSessionExperienceMemory(memory: MemoryFile): boolean {
  const hash = memory.frontmatter.structuredAttributes?.experience_session_hash;
  return typeof hash === "string" && hash.length > 0;
}

/**
 * Situation-overlap score in `[0, 1]`, or `null` when the memory is not a
 * session-experience episode. Caller keeps the generic procedure score.
 */
export function scoreSessionExperienceForPrompt(memory: MemoryFile, prompt: string): number | null {
  if (!isSessionExperienceMemory(memory)) return null;
  const situation = memory.frontmatter.structuredAttributes?.experience_situation ?? "";
  const situationScore = tokenOverlapScore(prompt, situation);
  const bodyScore = tokenOverlapScore(prompt, memory.content);
  return Math.min(1, situationScore * 0.75 + bodyScore * 0.25);
}

/** Flattened Experience preview, or `null` when the memory is not an episode. */
export function renderSessionExperiencePreview(memory: MemoryFile): string | null {
  if (!isSessionExperienceMemory(memory)) return null;
  const attrs = memory.frontmatter.structuredAttributes ?? {};
  const situation = (attrs.experience_situation ?? "").trim();
  const approach = (attrs.experience_approach ?? "").trim();
  const reflection = (attrs.experience_reflection ?? "").trim();
  if (situation.length === 0 && approach.length === 0 && reflection.length === 0) {
    return `Experience. ${memory.content.replace(/\s+/g, " ").trim()}`;
  }
  return `Experience. Situation: ${situation} Approach: ${approach} Reflection: ${reflection}`
    .replace(/\s+/g, " ")
    .trim();
}
