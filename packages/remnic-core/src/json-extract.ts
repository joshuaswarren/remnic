/**
 * Utilities for extracting JSON payloads from LLM outputs.
 *
 * We see common failure modes:
 * - "Here's an example: {..}\nHere's the real answer: {..}" (multiple JSON blocks)
 * - fenced ```json blocks
 * - leading/trailing prose around JSON
 *
 * These helpers attempt multiple candidates and let callers validate with schemas.
 */

export function stripCodeFences(text: string): string {
  // Drop the leading \s* before the lazy body: it overlapped the body and caused
  // polynomial backtracking on unterminated fences (CodeQL js/polynomial-redos).
  // inner is trimmed, so captured content is identical.
  return text.replace(/```(?:json)?([\s\S]*?)```/gi, (_m, inner) => String(inner).trim());
}

export function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const cleaned = stripCodeFences(trimmed);
  const candidates: string[] = [];

  if (cleaned.length > 0) candidates.push(cleaned);
  candidates.push(...scanBalancedJsonBlocks(cleaned));

  // Legacy regex fallback (single object)
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) candidates.push(objMatch[0]);

  const seen = new Set<string>();
  return candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter((c) => {
      if (seen.has(c)) return false;
      seen.add(c);
      return true;
    });
}

function scanBalancedJsonBlocks(text: string): string[] {
  const out: string[] = [];
  const opens = new Set(["{", "["]);
  const closes: Record<string, string> = { "{": "}", "[": "]" };

  for (let i = 0; i < text.length; i++) {
    const start = text[i];
    if (!opens.has(start)) continue;

    const expectedClose = closes[start];
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];

      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === start) depth++;
      if (ch === expectedClose) depth--;

      if (depth === 0) {
        out.push(text.slice(i, j + 1).trim());
        i = j;
        break;
      }
    }
  }

  return out;
}

