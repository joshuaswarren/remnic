
import { createHash } from "node:crypto";
import type {
  AntiEvent,
  CorrectionEvent,
  CorrectionShape,
  EstablishingTurn,
  FactCategory,
  MemCorrectCorpus,
  MemCorrectGeneratorOptions,
  MemCorrectScenario,
  PersonaFactPlanLike,
  ProbeQuery,
  Reassertion,
  ScopedTwin,
  UnrelatedProbe,
} from "./types.js";
import { PERSONAS, SUBJECTS, VALUES_A, VALUES_B } from "./token-pools.js";

const MAX_PRNG_SEED = 0xffffffff;

const FACT_CATEGORIES: readonly FactCategory[] = [
  "fact",
  "preference",
  "decision",
  "commitment",
  "relationship",
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function rng(): number {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

function pickExcluding<T>(rng: () => number, pool: readonly T[], exclude: T): T {
  const choices = pool.filter((v) => v !== exclude);
  const source = choices.length > 0 ? choices : pool;
  return source[Math.floor(rng() * source.length) % source.length];
}

function pickExcludingSet<T>(rng: () => number, pool: readonly T[], used: ReadonlySet<T>): T {
  const choices = pool.filter((v) => !used.has(v));
  const source = choices.length > 0 ? choices : pool;
  return source[Math.floor(rng() * source.length) % source.length];
}

function isoAfter(baseMs: number, addMs: number): string {
  return new Date(baseMs + addMs).toISOString();
}

function planFacts(
  rng: () => number,
  options: MemCorrectGeneratorOptions,
): PersonaFactPlanLike[] {
  const plans: PersonaFactPlanLike[] = [];
  const shapes: CorrectionShape[] = [
    "explicit-targeted",
    "conversational",
    "scoped",
    "re-assertion",
  ];
  for (let p = 0; p < options.personaCount; p += 1) {
    const persona = PERSONAS[p % PERSONAS.length];
    const namespaces = [
      `${persona.toLowerCase()}-work`,
      `${persona.toLowerCase()}-home`,
    ];
    for (let f = 0; f < options.factsPerPersona; f += 1) {
      const category =
        FACT_CATEGORIES[(p * options.factsPerPersona + f) % FACT_CATEGORIES.length];
      const subject = pick(rng, SUBJECTS);
      const oldValue = pick(rng, VALUES_A);
      const newValue = pick(rng, VALUES_B);
      const namespace = namespaces[f % namespaces.length];
      const shape = shapes[(p * options.factsPerPersona + f) % shapes.length];
      plans.push({ persona, namespace, category, subject, oldValue, newValue, shape });
    }
  }
  return plans;
}

function establishTurns(
  plan: PersonaFactPlanLike,
  baseMs: number,
  startOffsetMs: number,
): { turns: EstablishingTurn[]; nextOffsetMs: number } {
  const turns: EstablishingTurn[] = [
    {
      role: "user",
      text: `My ${plan.subject} preference is ${plan.oldValue}.`,
      at: isoAfter(baseMs, startOffsetMs),
    },
    {
      role: "assistant",
      text: `Got it — noting ${plan.oldValue} for ${plan.subject}.`,
      at: isoAfter(baseMs, startOffsetMs + 60_000),
    },
  ];
  return { turns, nextOffsetMs: startOffsetMs + 120_000 };
}

function buildCorrection(
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): { correction: CorrectionEvent; nextOffsetMs: number } {
  const retiredContent = [plan.oldValue];
  const correctedContent = [plan.newValue];
  let text: string;
  switch (plan.shape) {
    case "explicit-targeted":
      text = `Correction: my ${plan.subject} record saying ${plan.oldValue} is wrong. It is now ${plan.newValue}.`;
      break;
    case "conversational":
      text = `Oh by the way, we switched ${plan.subject} from ${plan.oldValue} to ${plan.newValue} last month.`;
      break;
    case "scoped":
      text = `For this project, ${plan.subject} is ${plan.newValue} now, not ${plan.oldValue}.`;
      break;
    case "re-assertion":
      text = `Update: ${plan.subject} is ${plan.newValue} going forward instead of ${plan.oldValue}.`;
      break;
  }
  const correction: CorrectionEvent = {
    shape: plan.shape,
    turn: { role: "user", text, at: isoAfter(baseMs, offsetMs) },
    retiredContent,
    correctedContent,
  };
  return { correction, nextOffsetMs: offsetMs + 60_000 };
}

function buildAntiEvents(
  rng: () => number,
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): { events: AntiEvent[]; nextOffsetMs: number } {
  const kinds: AntiEvent["kind"][] = [
    "quoting-other",
    "hypothetical",
    "third-party-correction",
  ];
  const kind = kinds[Math.floor(rng() * kinds.length) % kinds.length];
  const decoy = pickExcluding(rng, VALUES_B, plan.newValue);
  let text: string;
  switch (kind) {
    case "quoting-other":
      text = `Riley mentioned their ${plan.subject} is set to ${decoy}.`;
      break;
    case "hypothetical":
      text = `If someone asked, I might consider ${decoy} for ${plan.subject}, but I have not decided.`;
      break;
    case "third-party-correction":
      text = `Sage said you should change ${plan.subject} to ${decoy} for them.`;
      break;
  }
  const event: AntiEvent = {
    kind,
    turn: { role: "user", text, at: isoAfter(baseMs, offsetMs) },
    probeQuery: `what is my ${plan.subject} preference?`,
    shouldNotAppear: decoy,
  };
  return { events: [event], nextOffsetMs: offsetMs + 60_000 };
}

function buildScopedTwin(
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): { twin: ScopedTwin; nextOffsetMs: number } {
  const otherNamespace = plan.namespace.endsWith("-work")
    ? plan.namespace.replace(/-work$/, "-home")
    : plan.namespace.replace(/-home$/, "-work");
  const twin: ScopedTwin = {
    namespace: otherNamespace,
    establishingTurns: [
      {
        role: "user",
        text: `My ${plan.subject} preference is ${plan.oldValue}.`,
        at: isoAfter(baseMs, offsetMs),
      },
      {
        role: "assistant",
        text: `Noted ${plan.oldValue} for ${plan.subject}.`,
        at: isoAfter(baseMs, offsetMs + 60_000),
      },
    ],
    twinContent: plan.oldValue,
  };
  return { twin, nextOffsetMs: offsetMs + 120_000 };
}

function buildReassertion(
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): Reassertion {
  return {
    turn: {
      role: "user",
      text: `Actually, we went back to ${plan.oldValue} for ${plan.subject}.`,
      at: isoAfter(baseMs, offsetMs),
    },
    expectedContent: plan.oldValue,
  };
}

function buildUnrelatedProbes(
  rng: () => number,
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): { probes: UnrelatedProbe[]; nextOffsetMs: number } {
  const PROBE_COUNT = 2;
  const probes: UnrelatedProbe[] = [];
  const usedSubjects = new Set<string>([plan.subject]);
  for (let i = 0; i < PROBE_COUNT; i += 1) {
    const subject = pickExcludingSet(rng, SUBJECTS, usedSubjects);
    usedSubjects.add(subject);
    const value = pick(rng, VALUES_A);
    const turnBase = offsetMs + i * 120_000;
    probes.push({
      query: `what is my ${subject} setting?`,
      expectedContent: value,
      establishingTurns: [
        {
          role: "user",
          text: `My ${subject} setting is ${value}.`,
          at: isoAfter(baseMs, turnBase),
        },
        {
          role: "assistant",
          text: `Got it — noting ${value} for ${subject}.`,
          at: isoAfter(baseMs, turnBase + 60_000),
        },
      ],
    });
  }
  return { probes, nextOffsetMs: PROBE_COUNT * 120_000 };
}

function probeFor(plan: PersonaFactPlanLike): ProbeQuery {
  return {
    query: `what is my ${plan.subject} preference?`,
    mustContain: [plan.newValue],
    mustAbsent: [plan.oldValue],
  };
}

/**
 * Build a deterministic MemCorrect scenario corpus.
 *
 * @throws if `seed` is outside `[0, 2**32-1]` or `nowIso` is unparseable.
 */
export function generateMemCorrectCorpus(
  options: MemCorrectGeneratorOptions,
): MemCorrectCorpus {
  if (!Number.isInteger(options.personaCount) || options.personaCount <= 0) {
    throw new Error(
      `personaCount must be a positive integer, got ${options.personaCount}`,
    );
  }
  if (!Number.isInteger(options.factsPerPersona) || options.factsPerPersona <= 0) {
    throw new Error(
      `factsPerPersona must be a positive integer, got ${options.factsPerPersona}`,
    );
  }
  if (!Number.isInteger(options.maintenanceCycles) || options.maintenanceCycles < 0) {
    throw new Error(
      `maintenanceCycles must be a non-negative integer, got ${options.maintenanceCycles}`,
    );
  }
  if (!Number.isInteger(options.uptakeLatencyCap) || options.uptakeLatencyCap <= 0) {
    throw new Error(
      `uptakeLatencyCap must be a positive integer, got ${options.uptakeLatencyCap}`,
    );
  }
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > MAX_PRNG_SEED) {
    throw new Error(
      `seed must be an integer in [0, ${MAX_PRNG_SEED}], got ${options.seed}`,
    );
  }
  const baseMs = Date.parse(options.nowIso);
  if (!Number.isFinite(baseMs)) {
    throw new Error(`nowIso must be a valid ISO timestamp, got ${options.nowIso}`);
  }

  const rng = mulberry32(options.seed);
  const plans = planFacts(rng, options);
  const scenarios: MemCorrectScenario[] = [];

  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    const scenarioBase = baseMs + i * 86_400_000;
    let offset = 0;
    const established = establishTurns(plan, scenarioBase, offset);
    offset = established.nextOffsetMs;

    const unrelated = buildUnrelatedProbes(rng, plan, scenarioBase, offset);
    offset += unrelated.nextOffsetMs;

    let scopedTwin: ScopedTwin | undefined;
    if (plan.shape === "scoped") {
      const twin = buildScopedTwin(plan, scenarioBase, offset);
      scopedTwin = twin.twin;
      offset = twin.nextOffsetMs;
    }

    const corrected = buildCorrection(plan, scenarioBase, offset);
    offset = corrected.nextOffsetMs;
    const antis = buildAntiEvents(rng, plan, scenarioBase, offset);
    offset = antis.nextOffsetMs;

    let reassertion: Reassertion | undefined;
    if (plan.shape === "re-assertion") {
      reassertion = buildReassertion(plan, scenarioBase, offset);
      offset += 60_000;
    }

    scenarios.push({
      id: `memcorrect-${options.seed}-${i.toString(16)}`,
      namespace: plan.namespace,
      category: plan.category,
      establishingTurns: established.turns,
      correction: corrected.correction,
      probe: probeFor(plan),
      antiEvents: antis.events,
      scopedTwin,
      reassertion,
      unrelatedProbes: unrelated.probes,
    });
  }

  return { options, scenarios };
}

/**
 * Canonical SHA-256 of the corpus. Two runs with the same seed produce a
 * byte-identical hash — this is the determinism assertion CI enforces.
 */
export function corpusHash(corpus: MemCorrectCorpus): string {
  const canonical = JSON.stringify({
    personaCount: corpus.options.personaCount,
    factsPerPersona: corpus.options.factsPerPersona,
    seed: corpus.options.seed,
    nowIso: corpus.options.nowIso,
    maintenanceCycles: corpus.options.maintenanceCycles,
    uptakeLatencyCap: corpus.options.uptakeLatencyCap,
    scenarios: corpus.scenarios,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
