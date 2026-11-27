
export function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?([\s\S]*?)```/gi, (_m, inner) => String(inner).trim());
}

export function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const cleaned = stripCodeFences(trimmed);
  const candidates: string[] = [];

  candidates.push(...scanBalancedJsonBlocks(trimmed));
  if (cleaned.length > 0) candidates.push(cleaned);
  candidates.push(...scanBalancedJsonBlocks(cleaned));

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

