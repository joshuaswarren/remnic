import test from "node:test";
import assert from "node:assert/strict";
import {
  generateMemCorrectCorpus,
  corpusHash,
} from "./generator.js";
import { validateCorpus } from "./schema.js";
import { PERSONAS, SUBJECTS, VALUES_A, VALUES_B } from "./token-pools.js";
import type { CorrectionShape, MemCorrectGeneratorOptions } from "./types.js";

const BASE: MemCorrectGeneratorOptions = {
  personaCount: 2,
  factsPerPersona: 4,
  seed: 12345,
  nowIso: "2026-07-05T00:00:00.000Z",
  maintenanceCycles: 3,
  uptakeLatencyCap: 5,
};

const ALL_SHAPES: CorrectionShape[] = [
  "explicit-targeted",
  "conversational",
  "scoped",
  "re-assertion",
];

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("generator: same seed → byte-identical corpus hash", () => {
  const a = generateMemCorrectCorpus(BASE);
  const b = generateMemCorrectCorpus(BASE);
  assert.equal(corpusHash(a), corpusHash(b));
  // Structural equality too: every field deep-equal.
  assert.deepEqual(a.scenarios, b.scenarios);
});

test("generator: different seed → different corpus hash", () => {
  const a = generateMemCorrectCorpus(BASE);
  const b = generateMemCorrectCorpus({ ...BASE, seed: 999 });
  assert.notEqual(corpusHash(a), corpusHash(b));
});

test("generator: determinism holds across persona/fact scales", () => {
  for (const opts of [
    { ...BASE, personaCount: 3, factsPerPersona: 6 },
    { ...BASE, personaCount: 1, factsPerPersona: 4 },
  ]) {
    const a = generateMemCorrectCorpus(opts);
    const b = generateMemCorrectCorpus(opts);
    assert.equal(corpusHash(a), corpusHash(b), `seed ${opts.seed} scale`);
  }
});

// ---------------------------------------------------------------------------
// Taxonomy coverage
// ---------------------------------------------------------------------------

test("generator: corpus covers all four correction shapes", () => {
  const corpus = generateMemCorrectCorpus({
    ...BASE,
    personaCount: 2,
    factsPerPersona: 4, // 8 scenarios; shapes cycle every 4 → each shape ×2
  });
  const shapes = new Set(corpus.scenarios.map((s) => s.correction.shape));
  for (const shape of ALL_SHAPES) {
    assert.ok(shapes.has(shape), `missing shape ${shape}`);
  }
});

test("generator: scoped scenarios carry a namespace-B twin; re-assertion scenarios carry a reassertion block", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  const scoped = corpus.scenarios.filter((s) => s.correction.shape === "scoped");
  assert.ok(scoped.length > 0, "expected at least one scoped scenario");
  for (const s of scoped) {
    assert.ok(s.scopedTwin, `scoped scenario ${s.id} missing twin`);
    assert.notEqual(s.scopedTwin.namespace, s.namespace, "twin must be in a different namespace");
  }
  const reassert = corpus.scenarios.filter((s) => s.correction.shape === "re-assertion");
  assert.ok(reassert.length > 0, "expected at least one re-assertion scenario");
  for (const s of reassert) {
    assert.ok(s.reassertion, `re-assertion scenario ${s.id} missing reassertion block`);
  }
});

test("generator: establishing transcripts are non-empty and ISO-timestamped", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  for (const s of corpus.scenarios) {
    assert.ok(s.establishingTurns.length >= 1);
    for (const t of s.establishingTurns) {
      assert.ok(Number.isFinite(Date.parse(t.at)), `${s.id} bad timestamp ${t.at}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Schema validation + no-PII
// ---------------------------------------------------------------------------

test("schema: generated corpus validates", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  const result = validateCorpus(corpus);
  assert.ok(result.ok, `validation errors: ${JSON.stringify(result.errors)}`);
});

test("schema: every fact token originates from a synthetic pool (no-PII)", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  const pool = new Set<string>([
    ...VALUES_A,
    ...VALUES_B,
    ...[...SUBJECTS].flatMap((s) => [s]),
  ]);
  for (const s of corpus.scenarios) {
    for (const token of [
      ...s.correction.retiredContent,
      ...s.correction.correctedContent,
      s.scopedTwin?.twinContent,
      s.reassertion?.expectedContent,
    ]) {
      if (token !== undefined) {
        assert.ok(pool.has(token), `token "${token}" outside synthetic pools (PII guard)`);
      }
    }
  }
});

test("schema: validator rejects a hand-corrupted scenario", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  // Corrupt: empty namespace on first scenario.
  const corrupted = {
    ...corpus,
    scenarios: corpus.scenarios.map((s, i) =>
      i === 0 ? { ...s, namespace: "" } : s,
    ),
  };
  const result = validateCorpus(corrupted);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.message.includes("namespace")));
});

test("schema: validator rejects a scoped scenario missing its twin", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  const firstScoped = corpus.scenarios.find(
    (s) => s.correction.shape === "scoped",
  );
  assert.ok(firstScoped, "expected a scoped scenario");
  const corrupted = {
    ...corpus,
    scenarios: corpus.scenarios.map((s) =>
      s.id === firstScoped.id ? { ...s, scopedTwin: undefined } : s,
    ),
  };
  const result = validateCorpus(corrupted);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.message.includes("scopedTwin")),
    "expected scopedTwin error",
  );
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("generator: rejects invalid seed", () => {
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, seed: -1 }));
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, seed: 0x100000000 }));
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, seed: 1.5 }));
});

test("generator: rejects non-positive personaCount / factsPerPersona", () => {
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, personaCount: 0 }));
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, factsPerPersona: -1 }));
});

test("generator: rejects unparseable nowIso", () => {
  assert.throws(() => generateMemCorrectCorpus({ ...BASE, nowIso: "not-a-date" }));
});

// ---------------------------------------------------------------------------
// Persona coverage sanity
// ---------------------------------------------------------------------------

test("generator: namespaces derive from the synthetic persona pool only", () => {
  const corpus = generateMemCorrectCorpus(BASE);
  const personaPool = new Set(PERSONAS.map((p) => p.toLowerCase()));
  for (const s of corpus.scenarios) {
    const persona = s.namespace.replace(/-(work|home)$/, "");
    assert.ok(personaPool.has(persona), `namespace persona "${persona}" not in pool`);
  }
});
