/**
 * LoCoMo gold-memory derivation (issue #1954).
 *
 * Derives plain-statement gold knowledge points for a LoCoMo QA item from
 * dataset observation annotations, keyed by the QA item's evidence dialogue
 * ids. Extracted from runner.ts (structural ratchet, issue #1995).
 */
export function deriveLoCoMoGoldMemories(
  observation: unknown,
  evidence: readonly string[] | undefined,
): string[] | undefined {
  if (
    !observation ||
    typeof observation !== "object" ||
    Array.isArray(observation) ||
    !evidence ||
    !Array.isArray(evidence) ||
    evidence.length === 0
  ) {
    return undefined;
  }

  const diaMap = new Map<string, string[]>();

  const sessRecord = observation as Record<string, unknown>;
  for (const sessionVal of Object.values(sessRecord)) {
    if (!sessionVal || typeof sessionVal !== "object" || Array.isArray(sessionVal)) {
      continue;
    }
    const speakerRecord = sessionVal as Record<string, unknown>;
    for (const speakerVal of Object.values(speakerRecord)) {
      if (!Array.isArray(speakerVal)) {
        continue;
      }
      for (const item of speakerVal) {
        if (!Array.isArray(item) || item.length < 2) {
          continue;
        }
        const stmt = item[0];
        const diaIds = item[1];
        if (typeof stmt !== "string") {
          continue;
        }

        const targetDias: string[] = [];
        if (typeof diaIds === "string") {
          targetDias.push(diaIds);
        } else if (Array.isArray(diaIds)) {
          for (const d of diaIds) {
            if (typeof d === "string") {
              targetDias.push(d);
            }
          }
        }

        for (const d of targetDias) {
          let list = diaMap.get(d);
          if (!list) {
            list = [];
            diaMap.set(d, list);
          }
          list.push(stmt);
        }
      }
    }
  }

  if (diaMap.size === 0) {
    return undefined;
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const ev of evidence) {
    if (typeof ev !== "string") {
      continue;
    }
    const stmts = diaMap.get(ev);
    if (!stmts) {
      continue;
    }
    for (const stmt of stmts) {
      if (!seen.has(stmt)) {
        seen.add(stmt);
        result.push(stmt);
      }
    }
  }

  return result.length > 0 ? result : undefined;
}
