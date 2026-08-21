/**
 * Scoring utilities for ingestion benchmarks.
 */

import type {
  ExtractedEntity,
  ExtractedLink,
  ExtractedPage,
  GoldEntity,
  GoldLink,
  GoldPage,
} from "./ingestion-types.js";

function normalize(value: string): string {
  // NFKC decomposition first so that composed/decomposed forms (e.g. accented
  // letters, full-width characters, ligatures) compare equal.  Then lowercase,
  // strip punctuation/symbols via Unicode property escapes (preserves all
  // Unicode letters and digits, so multilingual names are not collapsed).
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function entityNameMatches(extracted: string, gold: GoldEntity): boolean {
  const normalizedExtracted = normalize(extracted);
  if (normalizedExtracted === normalize(gold.name)) return true;
  if (gold.aliases) {
    return gold.aliases.some((alias) => normalize(alias) === normalizedExtracted);
  }
  return false;
}

export function matchEntity(extracted: ExtractedEntity, gold: GoldEntity): boolean {
  return (
    normalize(extracted.type) === normalize(gold.type) &&
    entityNameMatches(extracted.name, gold)
  );
}

export function entityRecall(
  extracted: ExtractedEntity[],
  gold: GoldEntity[],
): { overall: number; byType: Record<string, number> } {
  if (gold.length === 0) return { overall: 1, byType: {} };

  const matched = new Set<string>();
  const consumedExtracted = new Set<number>();

  // Pass 1: exact-name matches first to avoid alias-order sensitivity.
  for (const ge of gold) {
    const idx = extracted.findIndex(
      (ee, i) =>
        !consumedExtracted.has(i) &&
        normalize(ee.type) === normalize(ge.type) &&
        normalize(ee.name) === normalize(ge.name),
    );
    if (idx >= 0) {
      matched.add(ge.id);
      consumedExtracted.add(idx);
    }
  }

  // Pass 2: alias fallback for unmatched gold entities.
  for (const ge of gold) {
    if (matched.has(ge.id)) continue;
    const idx = extracted.findIndex((ee, i) => !consumedExtracted.has(i) && matchEntity(ee, ge));
    if (idx >= 0) {
      matched.add(ge.id);
      consumedExtracted.add(idx);
    }
  }

  const overall = matched.size / gold.length;

  const typeGroups = new Map<string, GoldEntity[]>();
  for (const ge of gold) {
    const group = typeGroups.get(ge.type) ?? [];
    group.push(ge);
    typeGroups.set(ge.type, group);
  }

  const byType: Record<string, number> = {};
  for (const [type, entities] of typeGroups) {
    const typeMatched = entities.filter((ge) => matched.has(ge.id)).length;
    byType[`${type}_recall`] = typeMatched / entities.length;
  }

  return { overall, byType };
}

export function linkMatches(extracted: ExtractedLink, gold: GoldLink): boolean {
  const eSrc = normalize(extracted.source);
  const eTgt = normalize(extracted.target);
  const gSrc = normalize(gold.source);
  const gTgt = normalize(gold.target);
  const relMatch = normalize(extracted.relation) === normalize(gold.relation);

  // Reject self-links when the gold link has distinct endpoints
  if (eSrc === eTgt && gSrc !== gTgt) return false;

  if (gold.bidirectional) {
    const directMatch = eSrc === gSrc && eTgt === gTgt;
    const reverseMatch = eSrc === gTgt && eTgt === gSrc;
    return (directMatch || reverseMatch) && relMatch;
  }

  return eSrc === gSrc && eTgt === gTgt && relMatch;
}

export function backlinkF1(
  extracted: ExtractedLink[],
  gold: GoldLink[],
): { precision: number; recall: number; f1: number } {
  if (gold.length === 0 && extracted.length === 0) {
    return { precision: 1, recall: 1, f1: 1 };
  }
  if (extracted.length === 0) return { precision: 0, recall: 0, f1: 0 };
  if (gold.length === 0) return { precision: 0, recall: 1, f1: 0 };

  const matchedGold = new Set<number>();
  let correctExtracted = 0;
  for (const el of extracted) {
    for (let gi = 0; gi < gold.length; gi++) {
      if (!matchedGold.has(gi) && linkMatches(el, gold[gi]!)) {
        matchedGold.add(gi);
        correctExtracted++;
        break;
      }
    }
  }

  const precision = correctExtracted / extracted.length;
  const recall = matchedGold.size / gold.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1 };
}

export function schemaCompleteness(
  pages: ExtractedPage[],
  goldPages: GoldPage[],
  requiredFields: readonly string[],
): { overall: number; fieldCoverage: Record<string, number> } {
  if (goldPages.length === 0) return { overall: 1, fieldCoverage: {} };

  const fieldPasses: Record<string, number[]> = {};
  for (const field of requiredFields) {
    fieldPasses[field] = [];
  }

  let totalApplicable = 0;
  let totalPassing = 0;

  for (const gp of goldPages) {
    const matchedPage = pages.find((p) => normalize(p.title) === normalize(gp.title));

    for (const field of gp.requiredFields) {
      totalApplicable++;
      const passes = matchedPage ? matchedPage.frontmatter[field] !== undefined : false;
      if (passes) totalPassing++;
      fieldPasses[field]?.push(passes ? 1 : 0);
    }

    if (gp.expectExecSummary) {
      totalApplicable++;
      const passes = matchedPage?.hasExecSummary ?? false;
      if (passes) totalPassing++;
    }

    if (gp.expectTimeline) {
      totalApplicable++;
      const passes = matchedPage?.hasTimeline ?? false;
      if (passes) totalPassing++;
    }

    if (gp.expectSeeAlso && gp.expectSeeAlso.length > 0) {
      for (const expected of gp.expectSeeAlso) {
        totalApplicable++;
        const passes = matchedPage?.seeAlso.some((sa) => normalize(sa) === normalize(expected)) ?? false;
        if (passes) totalPassing++;
      }
    }
  }

  const overall = totalApplicable > 0 ? totalPassing / totalApplicable : 1;

  const fieldCoverage: Record<string, number> = {};
  for (const [field, values] of Object.entries(fieldPasses)) {
    if (values.length > 0) {
      fieldCoverage[field] = values.reduce((s, v) => s + v, 0) / values.length;
    }
  }

  return { overall, fieldCoverage };
}
