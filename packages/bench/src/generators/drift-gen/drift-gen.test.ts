import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DRIFT_GEN_DEFAULTS,
  DRIFT_GEN_VERSION,
  buildDriftCorpus,
  generateDriftCorpus,
  runDriftGenCliCommand,
} from "./index.js";
import { buildCorpusSchedule } from "./schedule.js";
import { questionAnswerLeakage, validateDriftCorpus } from "./validate.js";
import type { GoldFact } from "./types.js";

const SMALL = { users: 2, epochs: 4, seed: 11, factsPerEpoch: 8 } as const;

async function hashTree(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, abs);
    hashes.set(rel, createHash("sha256").update(await readFile(abs)).digest("hex"));
  }
  return hashes;
}

test("generation is byte-identical across runs with the same seed", async () => {
  const dirA = await mkdtemp(path.join(tmpdir(), "drift-gen-a-"));
  const dirB = await mkdtemp(path.join(tmpdir(), "drift-gen-b-"));
  try {
    await generateDriftCorpus({ ...SMALL, outDir: dirA });
    await generateDriftCorpus({ ...SMALL, outDir: dirB });
    const hashesA = await hashTree(dirA);
    const hashesB = await hashTree(dirB);
    assert.deepEqual(
      [...hashesA.entries()].sort(),
      [...hashesB.entries()].sort(),
    );
    assert.ok(hashesA.size >= 4, `expected at least 4 files, got ${hashesA.size}`);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("different seeds produce different corpora", () => {
  const a = buildDriftCorpus({ ...SMALL });
  const b = buildDriftCorpus({ ...SMALL, seed: 12 });
  assert.notDeepEqual(
    a.facts.map((f) => f.statement),
    b.facts.map((f) => f.statement),
  );
});

test("generated corpus passes its own validator", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "drift-gen-valid-"));
  try {
    await generateDriftCorpus({ ...SMALL, outDir: dir });
    const report = await validateDriftCorpus(dir);
    assert.deepEqual(report.errors, []);
    assert.equal(report.ok, true);
    assert.equal(report.stats.facts, SMALL.users * SMALL.epochs * SMALL.factsPerEpoch);
    assert.ok(report.stats.probes > 0);
    assert.ok(report.stats.probesByCategory.current > 0);
    assert.ok(report.stats.probesByCategory.historical > 0);
    assert.ok(report.stats.probesByCategory.transition > 0);
    assert.ok(report.stats.probesByCategory.aggregation > 0);
    assert.ok(report.stats.maxQuestionAnswerLeakage <= 0.6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default-sized corpus passes distribution checks without warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "drift-gen-full-"));
  try {
    await generateDriftCorpus({
      users: DRIFT_GEN_DEFAULTS.users,
      epochs: DRIFT_GEN_DEFAULTS.epochs,
      seed: DRIFT_GEN_DEFAULTS.seed,
      outDir: dir,
    });
    const report = await validateDriftCorpus(dir);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(
      report.stats.facts,
      DRIFT_GEN_DEFAULTS.users * DRIFT_GEN_DEFAULTS.epochs * DRIFT_GEN_DEFAULTS.factsPerEpoch,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validator rejects tampered data (hash mismatch) and broken links", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "drift-gen-tamper-"));
  try {
    await generateDriftCorpus({ ...SMALL, outDir: dir });
    const factsPath = path.join(dir, String(SMALL.seed), "gold", "facts.jsonl");
    const lines = (await readFile(factsPath, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]) as GoldFact;
    first.supersededBy = "gf-missing-99-1";
    first.supersededEpoch = 3;
    lines[0] = JSON.stringify(first);
    await writeFile(factsPath, `${lines.join("\n")}\n`, "utf8");

    const report = await validateDriftCorpus(dir);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.includes("sha256 mismatch")));
    assert.ok(report.errors.some((e) => e.includes("does not exist")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("supersession links are consistent and values change", () => {
  const corpus = buildDriftCorpus({
    users: DRIFT_GEN_DEFAULTS.users,
    epochs: DRIFT_GEN_DEFAULTS.epochs,
    seed: 21,
  });
  const byId = new Map(corpus.facts.map((f) => [f.id, f]));
  let superseded = 0;
  for (const fact of corpus.facts) {
    if (fact.supersededBy === null) continue;
    superseded++;
    const successor = byId.get(fact.supersededBy);
    assert.ok(successor, `${fact.id} points at missing successor`);
    assert.equal(successor.introducedEpoch, fact.supersededEpoch);
    assert.ok(successor.introducedEpoch > fact.introducedEpoch);
    assert.equal(successor.subject, fact.subject);
    assert.equal(successor.attribute, fact.attribute);
    assert.notEqual(successor.value, fact.value);
  }
  assert.ok(superseded > 0, "expected some superseded facts at default ratios");
});

test("probe epochs and expected answers reflect corpus state", () => {
  const corpus = buildDriftCorpus({ ...SMALL, seed: 31 });
  const byId = new Map(corpus.facts.map((f) => [f.id, f]));
  for (const probe of corpus.probes) {
    for (const factId of probe.requiredFactIds) {
      const fact = byId.get(factId);
      assert.ok(fact, `${probe.id} requires missing fact ${factId}`);
      assert.ok(fact.introducedEpoch <= probe.epoch);
    }
    if (probe.category === "current") {
      const fact = byId.get(probe.requiredFactIds[0]) as GoldFact;
      assert.equal(probe.expectedAnswer, fact.value);
      assert.ok(fact.supersededEpoch === null || fact.supersededEpoch > probe.epoch);
    }
    if (probe.category === "historical") {
      const fact = byId.get(probe.requiredFactIds[0]) as GoldFact;
      assert.ok(fact.supersededEpoch !== null && fact.supersededEpoch <= probe.epoch);
      assert.equal(probe.expectedAnswer, fact.value);
    }
    if (probe.category === "aggregation") {
      assert.ok(probe.requiredFactIds.length >= 3 && probe.requiredFactIds.length <= 6);
    }
  }
});

test("questionAnswerLeakage measures answer-word containment", () => {
  assert.equal(questionAnswerLeakage("Where does Avery work?", "Norvig Dynamics"), 0);
  assert.equal(
    questionAnswerLeakage("Is it Norvig Dynamics or not?", "Norvig Dynamics"),
    1,
  );
  assert.equal(questionAnswerLeakage("Anything?", ""), 0);
});

test("schedule options are validated", () => {
  const base = {
    users: 1,
    epochs: 4,
    seed: 1,
    factsPerEpoch: 4,
    driftingRatio: 0.2,
    contradictedRatio: 0.1,
  };
  assert.throws(() => buildCorpusSchedule({ ...base, users: 0 }), /users/);
  assert.throws(() => buildCorpusSchedule({ ...base, epochs: 1 }), /epochs/);
  assert.throws(() => buildCorpusSchedule({ ...base, driftingRatio: 1.5 }), /driftingRatio/);
  assert.throws(
    () => buildCorpusSchedule({ ...base, driftingRatio: 0.8, contradictedRatio: 0.4 }),
    /must not exceed 1/,
  );
  assert.throws(
    () => buildCorpusSchedule({ ...base, epochs: 20, factsPerEpoch: 8 }),
    /unique subject\/attribute pairs/,
  );
});

test("cli command generates and validates a corpus", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "drift-gen-cli-"));
  try {
    const gen = await runDriftGenCliCommand({
      action: "generate",
      users: SMALL.users,
      epochs: SMALL.epochs,
      seed: SMALL.seed,
      out: dir,
    });
    assert.equal(gen.exitCode, 0);
    assert.match(gen.output, new RegExp(DRIFT_GEN_VERSION.replaceAll(".", "\\.")));

    const valid = await runDriftGenCliCommand({ action: "validate", dir });
    assert.equal(valid.exitCode, 0);
    assert.match(valid.output, /VALID/);

    const missingOut = await runDriftGenCliCommand({ action: "generate" });
    assert.equal(missingOut.exitCode, 1);
    assert.match(missingOut.output, /--out/);

    const missingDir = await runDriftGenCliCommand({ action: "validate" });
    assert.equal(missingDir.exitCode, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generator sources contain no wall-clock or unseeded randomness", async () => {
  const generatorDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = await readdir(generatorDir);
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const source = await readFile(path.join(generatorDir, entry), "utf8");
    assert.ok(!source.includes("Math.random"), `${entry} uses Math.random`);
    assert.ok(!source.includes("Date.now"), `${entry} uses Date.now`);
    assert.ok(!source.includes("new Date("), `${entry} uses new Date()`);
  }
});

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "drift-gen-core",
);

test("committed drift-gen-core fixture matches a fresh regeneration and validates", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(FIXTURE_DIR, "dataset.manifest.json"), "utf8"),
  );
  const report = await validateDriftCorpus(FIXTURE_DIR);
  assert.deepEqual(report.errors, []);

  const regenDir = await mkdtemp(path.join(tmpdir(), "drift-gen-fixture-"));
  try {
    await generateDriftCorpus({
      users: manifest.counts.users,
      epochs: manifest.counts.epochs,
      seed: manifest.seeds[0],
      factsPerEpoch: manifest.generator.factsPerEpoch,
      driftingRatio: manifest.generator.driftingRatio,
      contradictedRatio: manifest.generator.contradictedRatio,
      outDir: regenDir,
      audit: manifest.audit,
    });
    const committed = await hashTree(FIXTURE_DIR);
    committed.delete("README.md");
    committed.delete("regenerate.ts");
    const regenerated = await hashTree(regenDir);
    assert.deepEqual(
      [...regenerated.entries()].sort(),
      [...committed.entries()].sort(),
      "committed fixture is stale: rerun packages/bench/src/fixtures/drift-gen-core/regenerate.ts and bump DRIFT_GEN_VERSION if the generator changed",
    );
  } finally {
    await rm(regenDir, { recursive: true, force: true });
  }
});
