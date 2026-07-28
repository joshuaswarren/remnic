/**
 * Fact-lifecycle scheduling for drift-gen.
 *
 * Per user and epoch, emit `factsPerEpoch` new facts. A configurable share is
 * "drifting" (superseded 2-5 epochs later) or "contradicted" (superseded the
 * next epoch). Supersession lands as a new fact for the same (subject,
 * attribute) with a different value, linked via supersededBy on the old fact.
 * Probes are derived from the schedule so expected answers are exact for the
 * epoch they are asked at.
 */

import {
  createSeededRandom,
  pickOne,
  randomInt,
  shuffled,
  type SeededRandom,
} from "../../seeded-random.js";
import {
  CITIES,
  COMPANIES,
  HOBBIES,
  PERSON_NAMES,
  PETS,
  PRODUCTS,
  PROJECTS,
  ROLES,
} from "./names.js";
import type {
  GoldFact,
  GoldFactKind,
  GoldProbe,
  GoldProbeCategory,
} from "./types.js";

export interface AttributeSpec {
  attribute: string;
  values: readonly string[];
  /** Clause with subject in third person, e.g. "works at Norvig Dynamics". */
  clause: (value: string) => string;
  /** Same clause in first person for user-subject rendering. */
  firstPersonClause: (value: string) => string;
  questionCurrent: (subject: string) => string;
  questionHistorical: (subject: string) => string;
  questionTransition: (subject: string) => string;
  /** Short noun phrase used in aggregation questions, e.g. "employer". */
  noun: string;
}

export const ATTRIBUTE_SPECS: readonly AttributeSpec[] = Object.freeze([
  {
    attribute: "employer",
    values: COMPANIES,
    clause: (v) => `works at ${v}`,
    firstPersonClause: (v) => `work at ${v}`,
    questionCurrent: (s) => `Where does ${s} work these days?`,
    questionHistorical: (s) => `Which employer did ${s} have before the most recent change?`,
    questionTransition: (s) => `How did ${s}'s employer change?`,
    noun: "employer",
  },
  {
    attribute: "role",
    values: ROLES,
    clause: (v) => `is ${/^[aeiou]/.test(v) ? "an" : "a"} ${v}`,
    firstPersonClause: (v) => `am ${/^[aeiou]/.test(v) ? "an" : "a"} ${v}`,
    questionCurrent: (s) => `What does ${s} do for a living now?`,
    questionHistorical: (s) => `What was ${s}'s job title before the most recent change?`,
    questionTransition: (s) => `How did ${s}'s job change?`,
    noun: "job title",
  },
  {
    attribute: "city",
    values: CITIES,
    clause: (v) => `lives in ${v}`,
    firstPersonClause: (v) => `live in ${v}`,
    questionCurrent: (s) => `Which city is ${s} living in currently?`,
    questionHistorical: (s) => `Where did ${s} live before the most recent move?`,
    questionTransition: (s) => `How did ${s}'s home city change?`,
    noun: "home city",
  },
  {
    attribute: "hobby",
    values: HOBBIES,
    clause: (v) => `has gotten into ${v}`,
    firstPersonClause: (v) => `have gotten into ${v}`,
    questionCurrent: (s) => `What pastime is ${s} into at the moment?`,
    questionHistorical: (s) => `What pastime was ${s} into before the most recent switch?`,
    questionTransition: (s) => `How did ${s}'s main pastime change?`,
    noun: "main pastime",
  },
  {
    attribute: "pet",
    values: PETS,
    clause: (v) => `has ${v}`,
    firstPersonClause: (v) => `have ${v}`,
    questionCurrent: (s) => `What animal companion does ${s} keep right now?`,
    questionHistorical: (s) => `What animal companion did ${s} keep before the most recent change?`,
    questionTransition: (s) => `How did ${s}'s animal companion situation change?`,
    noun: "animal companion",
  },
  {
    attribute: "favorite-tool",
    values: PRODUCTS,
    clause: (v) => `relies on the ${v} for daily planning`,
    firstPersonClause: (v) => `rely on the ${v} for daily planning`,
    questionCurrent: (s) => `Which planning app does ${s} rely on at the moment?`,
    questionHistorical: (s) => `Which planning app did ${s} rely on before the most recent switch?`,
    questionTransition: (s) => `How did ${s}'s planning app choice change?`,
    noun: "planning app",
  },
  {
    attribute: "project",
    values: PROJECTS,
    clause: (v) => `is leading ${v}`,
    firstPersonClause: (v) => `am leading ${v}`,
    questionCurrent: (s) => `Which initiative is ${s} leading right now?`,
    questionHistorical: (s) => `Which initiative did ${s} lead before the most recent handover?`,
    questionTransition: (s) => `How did the initiative ${s} leads change?`,
    noun: "current initiative",
  },
]);

export const MIN_DRIFT_GAP = 2;
const MAX_DRIFT_GAP = 5;
const AGGREGATION_EPOCH_INTERVAL = 2;
const AGGREGATION_PROBES_PER_EPOCH = 4;
const MIN_AGGREGATION_FACTS = 3;
const MAX_AGGREGATION_FACTS = 6;
const CONTACTS_PER_USER = 15;

export interface ScheduleOptions {
  users: number;
  epochs: number;
  seed: number;
  factsPerEpoch: number;
  driftingRatio: number;
  contradictedRatio: number;
}

export interface UserSchedule {
  userId: string;
  /** Persona name of the user (subject rendered in first person). */
  persona: string;
  facts: GoldFact[];
}

export interface CorpusSchedule {
  users: UserSchedule[];
  facts: GoldFact[];
  probes: GoldProbe[];
}

interface PendingSupersession {
  epoch: number;
  factId: string;
}

export function buildCorpusSchedule(options: ScheduleOptions): CorpusSchedule {
  validateScheduleOptions(options);
  const rng = createSeededRandom(options.seed);
  const personaPool = shuffled(rng, PERSON_NAMES);
  const users: UserSchedule[] = [];
  const allFacts: GoldFact[] = [];
  const allProbes: GoldProbe[] = [];

  for (let u = 0; u < options.users; u++) {
    const userId = `u${u + 1}`;
    const persona = personaPool[u % personaPool.length];
    const contacts = buildContacts(rng, persona);
    const subjects = [persona, ...contacts];
    const facts: GoldFact[] = [];
    const factById = new Map<string, GoldFact>();
    const activeByPair = new Map<string, GoldFact>();
    const pending: PendingSupersession[] = [];

    for (let epoch = 1; epoch <= options.epochs; epoch++) {
      const due = takeDueSupersessions(pending, epoch);
      let created = 0;

      for (const item of due) {
        if (created >= options.factsPerEpoch) {
          pending.push({ epoch: epoch + 1, factId: item.factId });
          continue;
        }
        const oldFact = factById.get(item.factId);
        if (!oldFact || oldFact.supersededBy !== null) continue;
        const successor = createSuccessorFact(rng, options, oldFact, epoch, facts.length);
        oldFact.supersededEpoch = epoch;
        oldFact.supersededBy = successor.id;
        registerFact(successor, facts, factById, activeByPair);
        scheduleLifecycle(rng, options, successor, epoch, pending);
        created++;
      }

      while (created < options.factsPerEpoch) {
        const fresh = createFreshFact(rng, options, userId, subjects, activeByPair, epoch, facts.length);
        registerFact(fresh, facts, factById, activeByPair);
        scheduleLifecycle(rng, options, fresh, epoch, pending);
        created++;
      }
    }

    attachSingleFactProbes(facts, factById, options.epochs);
    const aggregation = buildAggregationProbes(rng, userId, facts, options.epochs);

    users.push({ userId, persona, facts });
    allFacts.push(...facts);
    for (const fact of facts) allProbes.push(...fact.probes);
    allProbes.push(...aggregation);
  }

  allProbes.sort(compareProbes);
  return { users, facts: allFacts, probes: allProbes };
}

function validateScheduleOptions(options: ScheduleOptions): void {
  if (!Number.isSafeInteger(options.users) || options.users < 1) {
    throw new Error("drift-gen users must be a positive integer");
  }
  if (!Number.isSafeInteger(options.epochs) || options.epochs < 2) {
    throw new Error("drift-gen epochs must be an integer >= 2 (supersession needs at least two epochs)");
  }
  if (!Number.isSafeInteger(options.factsPerEpoch) || options.factsPerEpoch < 1) {
    throw new Error("drift-gen factsPerEpoch must be a positive integer");
  }
  for (const [name, value] of [
    ["driftingRatio", options.driftingRatio],
    ["contradictedRatio", options.contradictedRatio],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`drift-gen ${name} must be a finite number in [0, 1]`);
    }
  }
  if (options.driftingRatio + options.contradictedRatio > 1) {
    throw new Error("drift-gen driftingRatio + contradictedRatio must not exceed 1");
  }
  const pairCapacity = (CONTACTS_PER_USER + 1) * ATTRIBUTE_SPECS.length;
  const worstCaseFresh = options.epochs * options.factsPerEpoch;
  if (worstCaseFresh > pairCapacity) {
    throw new Error(
      `drift-gen cannot allocate ${worstCaseFresh} facts per user: only ${pairCapacity} unique subject/attribute pairs exist. Lower epochs or factsPerEpoch.`,
    );
  }
}

function buildContacts(rng: SeededRandom, persona: string): string[] {
  const pool = shuffled(rng, PERSON_NAMES.filter((name) => name !== persona));
  return pool.slice(0, CONTACTS_PER_USER);
}

function registerFact(
  fact: GoldFact,
  facts: GoldFact[],
  factById: Map<string, GoldFact>,
  activeByPair: Map<string, GoldFact>,
): void {
  facts.push(fact);
  factById.set(fact.id, fact);
  activeByPair.set(`${fact.subject}|${fact.attribute}`, fact);
}

function takeDueSupersessions(
  pending: PendingSupersession[],
  epoch: number,
): PendingSupersession[] {
  const due = pending.filter((p) => p.epoch === epoch);
  let write = 0;
  for (const item of pending) {
    if (item.epoch !== epoch) pending[write++] = item;
  }
  pending.length = write;
  return due;
}

function rollKind(rng: SeededRandom, options: ScheduleOptions, epoch: number): GoldFactKind {
  if (epoch >= options.epochs) return "stable";
  const roll = rng();
  if (roll < options.contradictedRatio) return "contradicted";
  if (roll < options.contradictedRatio + options.driftingRatio) {
    return epoch + MIN_DRIFT_GAP <= options.epochs ? "drifting" : "contradicted";
  }
  return "stable";
}

function scheduleLifecycle(
  rng: SeededRandom,
  options: ScheduleOptions,
  fact: GoldFact,
  epoch: number,
  pending: PendingSupersession[],
): void {
  if (fact.kind === "contradicted") {
    pending.push({ epoch: epoch + 1, factId: fact.id });
  } else if (fact.kind === "drifting") {
    const maxGap = Math.min(MAX_DRIFT_GAP, options.epochs - epoch);
    const gap = randomInt(rng, MIN_DRIFT_GAP, Math.max(MIN_DRIFT_GAP, maxGap));
    pending.push({ epoch: epoch + gap, factId: fact.id });
  }
}

function specFor(attribute: string): AttributeSpec {
  const spec = ATTRIBUTE_SPECS.find((s) => s.attribute === attribute);
  if (!spec) throw new Error(`unknown drift-gen attribute: ${attribute}`);
  return spec;
}

function createFreshFact(
  rng: SeededRandom,
  options: ScheduleOptions,
  userId: string,
  subjects: readonly string[],
  activeByPair: Map<string, GoldFact>,
  epoch: number,
  ordinal: number,
): GoldFact {
  for (let attempt = 0; attempt < 500; attempt++) {
    const subject = pickOne(rng, subjects);
    const spec = pickOne(rng, ATTRIBUTE_SPECS);
    if (activeByPair.has(`${subject}|${spec.attribute}`)) continue;
    const value = pickOne(rng, spec.values);
    return {
      id: `gf-${userId}-${epoch}-${ordinal + 1}`,
      userId,
      statement: `${subject} ${spec.clause(value)}.`,
      subject,
      attribute: spec.attribute,
      value,
      introducedEpoch: epoch,
      supersededEpoch: null,
      supersededBy: null,
      kind: rollKind(rng, options, epoch),
      probes: [],
    };
  }
  throw new Error(
    "drift-gen exhausted unique subject/attribute pairs; lower factsPerEpoch or epochs",
  );
}

function createSuccessorFact(
  rng: SeededRandom,
  options: ScheduleOptions,
  oldFact: GoldFact,
  epoch: number,
  ordinal: number,
): GoldFact {
  const spec = specFor(oldFact.attribute);
  const alternatives = spec.values.filter((v) => v !== oldFact.value);
  const value = pickOne(rng, alternatives);
  return {
    id: `gf-${oldFact.userId}-${epoch}-${ordinal + 1}`,
    userId: oldFact.userId,
    statement: `${oldFact.subject} ${spec.clause(value)}.`,
    subject: oldFact.subject,
    attribute: oldFact.attribute,
    value,
    introducedEpoch: epoch,
    supersededEpoch: null,
    supersededBy: null,
    kind: rollKind(rng, options, epoch),
    probes: [],
  };
}

function attachSingleFactProbes(
  facts: GoldFact[],
  factById: Map<string, GoldFact>,
  epochs: number,
): void {
  for (const fact of facts) {
    const spec = specFor(fact.attribute);
    let n = 0;
    const probeEpoch = fact.introducedEpoch + 1;
    const stillActiveAtProbe =
      fact.supersededEpoch === null || fact.supersededEpoch > probeEpoch;
    if (probeEpoch <= epochs && stillActiveAtProbe) {
      fact.probes.push({
        id: `${fact.id}-p${++n}`,
        userId: fact.userId,
        epoch: probeEpoch,
        question: spec.questionCurrent(fact.subject),
        expectedAnswer: fact.value,
        requiredFactIds: [fact.id],
        category: "current",
      });
    }
    if (fact.supersededEpoch !== null && fact.supersededBy !== null) {
      const successor = factById.get(fact.supersededBy);
      const afterEpoch = fact.supersededEpoch + 1;
      if (successor && afterEpoch <= epochs) {
        fact.probes.push({
          id: `${fact.id}-p${++n}`,
          userId: fact.userId,
          epoch: afterEpoch,
          question: spec.questionHistorical(fact.subject),
          expectedAnswer: fact.value,
          requiredFactIds: [fact.id],
          category: "historical",
        });
        fact.probes.push({
          id: `${fact.id}-p${++n}`,
          userId: fact.userId,
          epoch: afterEpoch,
          question: spec.questionTransition(fact.subject),
          expectedAnswer: `from ${fact.value} to ${successor.value}`,
          requiredFactIds: [fact.id, successor.id],
          category: "transition",
        });
      }
    }
  }
}

function activeFactsAt(facts: readonly GoldFact[], epoch: number): GoldFact[] {
  return facts.filter(
    (f) =>
      f.introducedEpoch <= epoch &&
      (f.supersededEpoch === null || f.supersededEpoch > epoch),
  );
}

function buildAggregationProbes(
  rng: SeededRandom,
  userId: string,
  facts: readonly GoldFact[],
  epochs: number,
): GoldProbe[] {
  const probes: GoldProbe[] = [];
  for (
    let epoch = AGGREGATION_EPOCH_INTERVAL;
    epoch <= epochs;
    epoch += AGGREGATION_EPOCH_INTERVAL
  ) {
    const active = activeFactsAt(facts, epoch);
    if (active.length < MIN_AGGREGATION_FACTS) continue;
    for (let p = 0; p < AGGREGATION_PROBES_PER_EPOCH; p++) {
      const count = Math.min(
        randomInt(rng, MIN_AGGREGATION_FACTS, MAX_AGGREGATION_FACTS),
        active.length,
      );
      const chosen = shuffled(rng, active).slice(0, count);
      const parts = chosen.map(
        (f) => `what is ${f.subject}'s ${specFor(f.attribute).noun}`,
      );
      probes.push({
        id: `gp-${userId}-${epoch}-agg${p + 1}`,
        userId,
        epoch,
        question: `Answer in order: ${parts.join("; ")}?`,
        expectedAnswer: chosen.map((f) => f.value).join("; "),
        requiredFactIds: chosen.map((f) => f.id),
        category: "aggregation",
      });
    }
  }
  return probes;
}

function compareProbes(a: GoldProbe, b: GoldProbe): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export const PROBE_CATEGORIES: readonly GoldProbeCategory[] = Object.freeze([
  "current",
  "historical",
  "transition",
  "aggregation",
]);
