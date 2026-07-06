/**
 * MemCorrect seeded synthetic corpus generator (issue #1584 PR 1).
 *
 * Produces a deterministic scenario corpus given a seed. The corpus is
 * generated, never committed: CI runs this generator and asserts the corpus
 * hash, mirroring the existing full-mode dataset-guard pattern under
 * `benchmarks/published/`. No real-world PII is possible by construction —
 * every name, city, and entity is drawn from small synthetic token pools.
 *
 * Each scenario seeds a fact via a natural establishing transcript (so
 * systems ingest it through their normal observe path, not a backdoor),
 * then delivers a correction in one of four shapes, plus anti-events that
 * must not stick. Scoped scenarios also seed a same-text twin in a second
 * namespace so `scope_precision` can verify the correction does not leak
 * across scope boundaries.
 */

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

/**
 * Mulberry32 PRNG — small, deterministic, fast. Identical contract to the
 * one used by `retention-aged-dataset/fixture.ts` so seeded determinism
 * behaves consistently across bench fixtures.
 */
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

/** ISO timestamp strictly after `baseMs` by `addMs` (half-open windowing). */
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
    // Each persona owns ≥2 namespaces (work + home) so scoped scenarios can
    // seed a twin in the alternate namespace.
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
  // Two-turn establishing transcript: user states the fact, assistant
  // acknowledges. Both turns carry the original value so systems that
  // dedupe or summarize still capture it.
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
      // The re-assertion scenario's "correction" sets a value that the user
      // later walks back; the reassertion block carries the original.
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
  // One anti-event per scenario, cycling through the three kinds so the
  // false_apply metric exercises each.
  const kinds: AntiEvent["kind"][] = [
    "quoting-other",
    "hypothetical",
    "third-party-correction",
  ];
  const kind = kinds[Math.floor(rng() * kinds.length) % kinds.length];
  let text: string;
  switch (kind) {
    case "quoting-other":
      text = `Riley mentioned their ${plan.subject} is set to ${plan.newValue}.`;
      break;
    case "hypothetical":
      text = `If someone asked, I might consider ${plan.newValue} for ${plan.subject}, but I have not decided.`;
      break;
    case "third-party-correction":
      text = `Sage said you should change ${plan.subject} to ${plan.newValue} for them.`;
      break;
  }
  const event: AntiEvent = {
    kind,
    turn: { role: "user", text, at: isoAfter(baseMs, offsetMs) },
    probeQuery: `what is my ${plan.subject} preference?`,
    // The new value must NOT stick from a third-party / hypothetical cue.
    shouldNotAppear: plan.newValue,
  };
  return { events: [event], nextOffsetMs: offsetMs + 60_000 };
}

function buildScopedTwin(
  plan: PersonaFactPlanLike,
  baseMs: number,
  offsetMs: number,
): { twin: ScopedTwin; nextOffsetMs: number } {
  // Twin lives in the persona's *other* namespace and keeps the OLD value.
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
): { probes: UnrelatedProbe[]; nextOffsetMs: number } {
  // Two unrelated facts that the correction must not damage. They share
  // the persona/namespace so collateral is measured in the same scope.
  const probes: UnrelatedProbe[] = [];
  for (let i = 0; i < 2; i += 1) {
    const subject = pick(rng, SUBJECTS);
    const value = pick(rng, VALUES_A);
    probes.push({
      query: `what is my ${subject} setting?`,
      expectedContent: value,
    });
  }
  return { probes, nextOffsetMs: 0 };
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
    // Stagger each scenario's base time so timestamps never collide and
    // half-open windows are unambiguous.
    const scenarioBase = baseMs + i * 86_400_000;
    let offset = 0;
    const established = establishTurns(plan, scenarioBase, offset);
    offset = established.nextOffsetMs;
    const corrected = buildCorrection(plan, scenarioBase, offset);
    offset = corrected.nextOffsetMs;
    const antis = buildAntiEvents(rng, plan, scenarioBase, offset);
    offset = antis.nextOffsetMs;

    let scopedTwin: ScopedTwin | undefined;
    if (plan.shape === "scoped") {
      const twin = buildScopedTwin(plan, scenarioBase, offset);
      scopedTwin = twin.twin;
      offset = twin.nextOffsetMs;
    }

    let reassertion: Reassertion | undefined;
    if (plan.shape === "re-assertion") {
      reassertion = buildReassertion(plan, scenarioBase, offset);
      offset += 60_000;
    }

    const unrelated = buildUnrelatedProbes(rng);
    offset += unrelated.nextOffsetMs;

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
