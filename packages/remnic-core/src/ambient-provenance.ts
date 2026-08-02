/**
 * Ambient-capture provenance for extraction (issue #2294).
 *
 * Always-on capture devices — wearable recorders, room microphones — hand the
 * extraction engine speech the user never authored: television and film
 * dialogue, podcasts, radio, music with spoken segments, and conversations the
 * user merely walked past. The extraction prompt otherwise reads every turn as
 * first-person user input, so a scripted line about a relative's birthday or a
 * medical diagnosis lands as a high-confidence personal fact and auto-promotes
 * into recall. That output is plausible, personally relevant, and wrong, which
 * makes it materially worse than a missed fact.
 *
 * This module owns both halves of the fix:
 *
 * 1. The prompt text that teaches the model to separate the user's own speech
 *    from background media, drop high-consequence personal claims it cannot
 *    attribute to the user, and score the remainder speculatively. One source
 *    of truth, shared by the cloud, direct-client, and local-LLM prompts so the
 *    three paths cannot drift.
 * 2. A deterministic backstop — `clampAmbientCaptureConfidence` — for when the
 *    model ignores the prompt anyway. It clamps ONLY high-impact personal facts
 *    (family, milestones, medical) to the speculative ceiling. Clamping every
 *    ambient fact would gut the wearable integration, which is explicitly not
 *    the goal; clamping this class costs a birthday landing in the review queue
 *    instead of active recall.
 *
 * The provenance signal itself is `BufferTurn.ambientCapture`, set by the
 * ingesting subsystem (the wearable memory pass), never by tool arguments.
 */

import type { ExtractedFact, ExtractionResult } from "./types.js";

/**
 * Upper bound of the speculative confidence tier, matching the tier table in
 * the extraction prompt ("Speculative (0.00-0.39)"). A fact at or below this
 * value cannot auto-promote through the wearable trust bands.
 */
export const SPECULATIVE_CONFIDENCE_CEILING = 0.39;

/**
 * Appended to the speculative tier definition when the input is ambient
 * capture, so the tier itself carries the rule rather than relying on the
 * separate section below being obeyed in isolation.
 */
export const AMBIENT_SPECULATIVE_TIER_CLAUSE =
  " Speculative also applies to any fact whose only evidence is ambient or background audio from an always-on capture device, even when the content is concrete and specific.";

/**
 * Full provenance section for the cloud and direct-client extraction prompts.
 */
export const AMBIENT_CAPTURE_PROMPT_SECTION = `
Source provenance — always-on capture audio:
- This transcript came from an always-on capture device (a wearable recorder or room microphone). It may contain audio the user did not author: television, film, podcasts, radio, advertisements, music with spoken segments, and conversations the user merely overheard or walked past.
- Separate the user's own speech from background media before extracting anything. Narrative, scripted, performed, or third-person speech — a show's dialogue, a podcast host, an ad read, a lecture playing in the room — is media, not user input. Never attribute it to the user or to anyone the user knows.
- High-consequence personal claims must be dropped entirely unless the user's own voice is clearly identifiable as their source: family relationships, personal milestones (births, birthdays, anniversaries, weddings, funerals, divorces), and any medical or health detail. Omit them; do not emit them at reduced confidence as a compromise.
- When you cannot tell whether a statement was spoken by the user or captured passively, skip it or set its confidence in the speculative tier (0.00-0.39). Never resolve that doubt upward.`;

/**
 * Compact variant for the local-LLM prompt, which is deliberately small to fit
 * 4k-8k context windows.
 */
export const AMBIENT_CAPTURE_PROMPT_SECTION_COMPACT = `
Ambient capture:
- This transcript came from an always-on capture device and may contain TV, film, podcast, music, or overheard speech the user did not author.
- Treat narrative, scripted, or third-person speech as media, not user input.
- Drop family, milestone (birth, birthday, anniversary, wedding, funeral), and medical claims unless the user's own voice is clearly the source.
- Otherwise, when unsure whether the user said it, set confidence in the speculative tier (0.00-0.39).`;

/**
 * Single rule for prompts that already have their own rule list and only need
 * the ambient warning (the meeting scribe, whose transcript is the same
 * wearable audio).
 */
export const AMBIENT_CAPTURE_PROMPT_RULE =
  "- The transcript may contain ambient audio nobody in the meeting authored: television, podcasts, music, or a passing conversation. Treat scripted, performed, or third-person speech as background media and never record it as a decision, commitment, or question.";

/**
 * Content classes where one fabricated fact does the most damage. Word-bounded
 * alternation only — no nesting, no backtracking risk.
 */
const HIGH_IMPACT_PERSONAL_PATTERN =
  /\b(?:mother|mothers|mom|moms|mum|father|fathers|dad|dads|parent|parents|sister|sisters|brother|brothers|sibling|siblings|son|sons|daughter|daughters|child|children|kid|kids|wife|wives|husband|husbands|spouse|partner|fiance|fiancee|grandmother|grandfather|grandma|grandpa|grandparent|grandparents|grandson|granddaughter|grandchild|grandchildren|aunt|uncle|cousin|niece|nephew|stepmother|stepfather|stepson|stepdaughter|in-law|family|birthday|birthdays|anniversary|anniversaries|wedding|weddings|engaged|engagement|married|marriage|divorce|divorced|widow|widowed|funeral|memorial|pregnant|pregnancy|miscarriage|newborn|diagnosis|diagnosed|cancer|tumor|tumour|biopsy|chemotherapy|chemo|surgery|surgeon|hospital|hospitalized|hospitalised|icu|stroke|seizure|medication|medications|prescription|prescribed|symptom|symptoms|illness|disease|disorder|therapy|therapist|psychiatrist|antidepressant|diabetes|diabetic|dementia|alzheimer|alzheimers|overdose|relapse|sobriety|miscarried)\b/i;

/** Tags that mark a fact as belonging to the same high-impact classes. */
const HIGH_IMPACT_TAGS: Record<string, true> = {
  family: true,
  health: true,
  medical: true,
  medication: true,
  diagnosis: true,
  birthday: true,
  anniversary: true,
  milestone: true,
  relationship: true,
  marriage: true,
  pregnancy: true,
  "mental-health": true,
};

/**
 * True when this fact makes a personal claim whose fabrication causes real
 * harm — a family relationship, a personal milestone, or a medical detail.
 */
export function isHighImpactPersonalFact(
  fact: Pick<ExtractedFact, "content" | "tags">,
): boolean {
  if (HIGH_IMPACT_PERSONAL_PATTERN.test(fact.content)) return true;
  for (const tag of fact.tags ?? []) {
    if (HIGH_IMPACT_TAGS[tag.trim().toLowerCase()] === true) return true;
  }
  return false;
}

/**
 * Deterministic backstop applied after extraction on ambient-capture input:
 * hold high-impact personal facts at or below the speculative ceiling so they
 * cannot auto-promote to active recall on a model's unsupported confidence.
 *
 * Returns the input unchanged when nothing needs clamping, so the non-ambient
 * path pays one predicate per fact and allocates nothing.
 */
export function clampAmbientCaptureConfidence(
  result: ExtractionResult,
): ExtractionResult {
  let clampedAny = false;
  const facts = result.facts.map((fact) => {
    if (fact.confidence <= SPECULATIVE_CONFIDENCE_CEILING) return fact;
    if (!isHighImpactPersonalFact(fact)) return fact;
    clampedAny = true;
    return { ...fact, confidence: SPECULATIVE_CONFIDENCE_CEILING };
  });
  return clampedAny ? { ...result, facts } : result;
}
