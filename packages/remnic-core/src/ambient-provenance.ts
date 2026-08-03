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

import type { ExtractionResult } from "./types.js";

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
 * Categories that are personal-claim-shaped by construction, independent of any
 * vocabulary: `moment` is defined as an emotionally significant event or
 * milestone, and on ambient audio a `relationship` claim is a link the model
 * inferred between people it overheard. Non-lexical, so they still catch harm
 * the term lists below miss.
 */
const HIGH_IMPACT_CATEGORIES: Record<string, true> = { moment: true, relationship: true };

/**
 * Kinship, milestone, and health vocabulary. Deliberately broad: a false
 * positive costs one ambient fact a trip through the review queue, a false
 * negative puts a fabricated medical claim into active recall. The list cannot
 * be exhaustive and is not the primary defense — the prompt is, and the
 * category signal above plus the trust-band cap in the wearable pass catch
 * classes no word list enumerates. Extend it when a miss is observed.
 *
 * Word-bounded alternation only — no nesting, no backtracking risk.
 */
const HIGH_IMPACT_TOPIC_PATTERN =
  /\b(?:mother|mothers|mom|moms|mum|father|fathers|dad|dads|sister|sisters|brother|brothers|son|sons|daughter|daughters|wife|wives|husband|husbands|spouse|fiance|fiancee|grandmother|grandfather|grandma|grandpa|grandparent|grandparents|grandson|granddaughter|grandchild|grandchildren|aunt|uncle|cousin|niece|nephew|stepmother|stepfather|stepson|stepdaughter|stepchild|godmother|godfather|birthday|birthdays|anniversary|anniversaries|wedding|weddings|honeymoon|married|marriage|divorce|divorced|widow|widowed|funeral|memorial service|engagement party|baby shower|christening|bar mitzvah|pregnant|pregnancy|miscarriage|miscarried|newborn|gave birth|stillbirth|infertility|ivf|menopause|diagnosis|diagnosed|prognosis|tested positive|cancer|carcinoma|leukemia|tumor|tumour|biopsy|chemotherapy|chemo|radiation therapy|remission|hospice|palliative|terminal illness|surgery|surgeon|hospital|hospitalized|hospitalised|icu|emergency room|ambulance|stroke|heart attack|cardiac|arrhythmia|afib|seizure|epilepsy|asthma|allergy|allergic|diabetes|diabetic|insulin|cholesterol|blood pressure|hypertension|dementia|alzheimer|alzheimers|parkinson|parkinsons|hiv|aids diagnosis|medication|medications|prescription|prescribed|dosage|symptom|symptoms|illness|disease|disorder|syndrome|therapy|therapist|psychiatrist|psychologist|antidepressant|depression|anxiety|bipolar|schizophrenia|adhd|autism|ptsd|overdose|relapse|sobriety|rehab|addiction|alcoholism|concussion|transplant|dialysis|immunocompromised|mental health|covid|covid-19|coronavirus|flu|influenza|pneumonia|bronchitis|infection|infected|fever|migraine|ulcer|hernia|appendicitis|sepsis|sick leave|urgent care|broken leg|broken arm|broken wrist|broken hip|broken rib|broken ribs|sprained|dislocated|torn ligament|torn acl|whiplash|burn unit|chronic pain|disability|wheelchair|hearing aid|blind in|vaccinated|vaccination|immunization|blood test|scan results|mri|ct scan|x-ray|deaf|deafness|blind|blindness|mute|nonverbal|paralyzed|paralysed|paraplegic|quadriplegic|amputee|amputation|prosthetic|multiple sclerosis|lupus|crohn|celiac|fibromyalgia|cystic fibrosis|sickle cell|cerebral palsy|down syndrome|muscular dystrophy|chronic fatigue|chronic illness|terminally ill|life support|coma|special needs|caregiver|nursing home|assisted living)\b/i;

/**
 * Bodily-harm and affliction SHAPES rather than nouns: "broke her leg", "tore
 * his ACL", "caught something at the office". A vocabulary of conditions can
 * never be complete, so this matches the sentence form instead — a verb of
 * injury or contagion pointed at a person's POSSESSION. Articles are excluded
 * on purpose: "the build broke the deploy pipeline" is not an injury.
 */
const AFFLICTION_SHAPE_PATTERN =
  /\b(?:broke|broken|fractured|sprained|dislocated|tore|torn|bruised|burned|scalded|injured|hurt)\s+(?:his|her|their|my|your|our)\s+\w+|\b(?:caught|contracted|came down with|is recovering from|was rushed to|passed away|died of|died from)\b/i;

/**
 * Words that are personal only when someone possesses them: "child process",
 * "parent component", "sibling node", and "customer family" are everyday
 * technical speech, while "his child" and "Rachel's parents" are not.
 */
const POSSESSED_KINSHIP_PATTERN =
  /(?:\b(?:my|your|his|her|their|our)|'s)\s+(?:child|children|kid|kids|parent|parents|partner|family|sibling|siblings|in-law|in-laws|relatives)\b/i;

/** Tags that mark a fact as belonging to the same high-impact classes. */
const HIGH_IMPACT_TAGS: Record<string, true> = {
  disability: true,
  family: true,
  health: true,
  medical: true,
  medication: true,
  diagnosis: true,
  birthday: true,
  anniversary: true,
  marriage: true,
  pregnancy: true,
  "mental-health": true,
};

/**
 * True when this claim is personal in a way whose fabrication causes real
 * harm — a family relationship, a personal milestone, or a medical detail.
 *
 * Read by every ambient guard: the post-extraction confidence clamp below, the
 * wearable trust-band cap, and the meeting trust-band cap. A fact this flags
 * can never auto-approve, on any path, however the boosts add up.
 *
 * Takes the shape rather than `ExtractedFact` so meeting candidates — which
 * carry no tags — pass without a synthetic empty array.
 *
 * `personRefs` comes from `collectPersonEntityRefs` over the same extraction:
 * pass it whenever the entity list is available, so personhood is read from
 * the extractor's own `type: "person"` metadata instead of inferred from how
 * it happened to spell the ref.
 */
export function isHighImpactPersonalFact(
  fact: {
    category: string;
    content: string;
    tags?: readonly string[];
    entityRef?: string;
  },
  personRefs?: ReadonlySet<string>,
): boolean {
  // The strongest non-lexical signal: a claim ABOUT A PERSON is high-impact
  // whatever condition, relationship, or milestone the sentence names. This is
  // what covers wording no list anticipates ("Dana is deaf").
  if (isPersonRef(fact.entityRef, personRefs)) return true;
  if (HIGH_IMPACT_CATEGORIES[fact.category] === true) return true;
  if (HIGH_IMPACT_TOPIC_PATTERN.test(fact.content)) return true;
  if (AFFLICTION_SHAPE_PATTERN.test(fact.content)) return true;
  if (POSSESSED_KINSHIP_PATTERN.test(fact.content)) return true;
  for (const tag of fact.tags ?? []) {
    if (HIGH_IMPACT_TAGS[tag.trim().toLowerCase()] === true) return true;
  }
  return false;
}

/**
 * Normalize an entity reference for comparison: casefold, strip a leading
 * type prefix, and collapse separators. `Person-Jane_Doe`, `person:jane-doe`,
 * and `jane doe` all reduce to `jane-doe`.
 */
function normalizeEntityRef(ref: string): string {
  return ref
    .trim()
    .toLowerCase()
    .replace(/^(?:person|people)[-:_\s]+/, "")
    .replace(/[\s_]+/g, "-");
}

/**
 * Names of every `type: "person"` entity in an extraction, normalized for
 * lookup. Personhood is the extractor's own metadata, not a guess from the
 * shape of `entityRef` — the prompt asks for `person-jane-doe` but the field is
 * optional and models routinely emit a bare `jane-doe`.
 */
export function collectPersonEntityRefs(result: {
  entities: ReadonlyArray<{ name: string; type: string }>;
}): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const entity of result.entities) {
    if (entity.type !== "person") continue;
    const normalized = normalizeEntityRef(entity.name);
    if (normalized.length > 0) refs.add(normalized);
  }
  return refs;
}

/** True when this ref names a person, by metadata or by explicit prefix. */
function isPersonRef(ref: string | undefined, personRefs?: ReadonlySet<string>): boolean {
  if (ref === undefined || ref.trim().length === 0) return false;
  if (/^(?:person|people)[-:_]/i.test(ref.trim())) return true;
  return personRefs !== undefined && personRefs.has(normalizeEntityRef(ref));
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
  const personRefs = collectPersonEntityRefs(result);
  const facts = result.facts.map((fact) => {
    if (fact.confidence <= SPECULATIVE_CONFIDENCE_CEILING) return fact;
    if (!isHighImpactPersonalFact(fact, personRefs)) return fact;
    clampedAny = true;
    return { ...fact, confidence: SPECULATIVE_CONFIDENCE_CEILING };
  });
  return clampedAny ? { ...result, facts } : result;
}
