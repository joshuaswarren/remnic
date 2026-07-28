/**
 * drift-gen corpus validator (issue #1954 dataset runbook, "Creating" step 8
 * and "Curation" checks).
 *
 * Structural integrity is an error; statistical distribution checks degrade
 * to warnings on corpora too small for the tolerances to be meaningful
 * (fewer than MIN_STATISTICAL_BASE kind-eligible facts), so the committed
 * canonical smoke fixture stays validatable.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type {
  DriftGenManifest,
  DriftSession,
  DriftValidationReport,
  DriftValidationStats,
  GoldFact,
  GoldProbe,
} from "./types.js";
import { MIN_DRIFT_GAP } from "./schedule.js";

const FACT_COUNT_TOLERANCE = 0.1;
const RATIO_TOLERANCE = 0.05;
const MAX_QUESTION_ANSWER_LEAKAGE = 0.6;
const MIN_STATISTICAL_BASE = 40;

const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "before", "by", "did", "do", "does", "for",
  "from", "has", "have", "how", "in", "is", "it", "its", "most", "now", "of",
  "on", "one", "order", "recent", "s", "the", "these", "to", "was", "what",
  "when", "where", "which", "who", "with",
]);

export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length > 0 && !STOPWORDS.has(raw)) words.add(raw);
  }
  return words;
}

/** Fraction of the answer's content words that also appear in the question. */
export function questionAnswerLeakage(question: string, answer: string): number {
  const answerWords = contentWords(answer);
  if (answerWords.size === 0) return 0;
  const questionWords = contentWords(question);
  let overlap = 0;
  for (const word of answerWords) {
    if (questionWords.has(word)) overlap++;
  }
  return overlap / answerWords.size;
}

async function readJsonl<T>(filePath: string, errors: string[]): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    errors.push(`missing file: ${filePath}`);
    return [];
  }
  const rows: T[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      errors.push(`${filePath}:${i + 1}: invalid JSON line`);
    }
  }
  return rows;
}

interface LoadedSeed {
  seed: number;
  facts: GoldFact[];
  probes: GoldProbe[];
  sessions: DriftSession[];
}

async function loadSeedDir(
  corpusDir: string,
  seed: number,
  errors: string[],
): Promise<LoadedSeed> {
  const seedDir = path.join(corpusDir, String(seed));
  const facts = await readJsonl<GoldFact>(path.join(seedDir, "gold", "facts.jsonl"), errors);
  const probes = await readJsonl<GoldProbe>(path.join(seedDir, "gold", "probes.jsonl"), errors);
  const sessions: DriftSession[] = [];
  const usersDir = path.join(seedDir, "users");
  let userIds: string[] = [];
  try {
    userIds = (await readdir(usersDir)).sort();
  } catch {
    errors.push(`missing directory: ${usersDir}`);
  }
  for (const userId of userIds) {
    sessions.push(
      ...(await readJsonl<DriftSession>(
        path.join(usersDir, userId, "sessions.jsonl"),
        errors,
      )),
    );
  }
  return { seed, facts, probes, sessions };
}

function checkFactIntegrity(loaded: LoadedSeed, epochs: number, errors: string[]): void {
  const byId = new Map(loaded.facts.map((f) => [f.id, f]));
  if (byId.size !== loaded.facts.length) {
    errors.push(`seed ${loaded.seed}: duplicate fact ids`);
  }
  for (const fact of loaded.facts) {
    if (fact.introducedEpoch < 1 || fact.introducedEpoch > epochs) {
      errors.push(`${fact.id}: introducedEpoch ${fact.introducedEpoch} out of range 1..${epochs}`);
    }
    if ((fact.supersededBy === null) !== (fact.supersededEpoch === null)) {
      errors.push(`${fact.id}: supersededBy and supersededEpoch must be set together`);
    }
    if (fact.kind !== "stable" && fact.supersededBy === null) {
      errors.push(`${fact.id}: kind "${fact.kind}" requires a successor; unsuperseded facts must be "stable"`);
    }
    if (fact.supersededBy !== null && fact.supersededEpoch !== null) {
      const successor = byId.get(fact.supersededBy);
      if (!successor) {
        errors.push(`${fact.id}: supersededBy ${fact.supersededBy} does not exist`);
        continue;
      }
      if (successor.introducedEpoch <= fact.introducedEpoch) {
        errors.push(`${fact.id}: successor ${successor.id} must be introduced at a later epoch`);
      }
      if (successor.introducedEpoch !== fact.supersededEpoch) {
        errors.push(`${fact.id}: supersededEpoch ${fact.supersededEpoch} does not match successor introduction ${successor.introducedEpoch}`);
      }
      if (successor.subject !== fact.subject || successor.attribute !== fact.attribute) {
        errors.push(`${fact.id}: successor ${successor.id} targets a different subject/attribute`);
      }
      if (successor.value === fact.value) {
        errors.push(`${fact.id}: successor ${successor.id} repeats the same value`);
      }
    }
  }
}

function checkProbeIntegrity(loaded: LoadedSeed, epochs: number, errors: string[]): void {
  const byId = new Map(loaded.facts.map((f) => [f.id, f]));
  const seenProbeIds = new Set<string>();
  for (const probe of loaded.probes) {
    if (seenProbeIds.has(probe.id)) {
      errors.push(`${probe.id}: duplicate probe id`);
    }
    seenProbeIds.add(probe.id);
    if (probe.epoch < 1 || probe.epoch > epochs) {
      errors.push(`${probe.id}: epoch ${probe.epoch} out of range 1..${epochs}`);
    }
    if (probe.requiredFactIds.length === 0) {
      errors.push(`${probe.id}: requiredFactIds is empty`);
    }
    for (const factId of probe.requiredFactIds) {
      const fact = byId.get(factId);
      if (!fact) {
        errors.push(`${probe.id}: requiredFactId ${factId} does not exist`);
        continue;
      }
      if (fact.introducedEpoch > probe.epoch) {
        errors.push(`${probe.id}: fact ${factId} is introduced at epoch ${fact.introducedEpoch}, after the probe epoch ${probe.epoch}`);
      }
    }
    if (probe.category === "historical") {
      const fact = byId.get(probe.requiredFactIds[0]);
      if (fact && (fact.supersededEpoch === null || fact.supersededEpoch > probe.epoch)) {
        errors.push(`${probe.id}: historical probe targets fact ${fact.id} not superseded by epoch ${probe.epoch}`);
      }
    }
    if (probe.category === "aggregation") {
      if (probe.requiredFactIds.length < 3 || probe.requiredFactIds.length > 6) {
        errors.push(`${probe.id}: aggregation probe must require 3-6 facts, has ${probe.requiredFactIds.length}`);
      }
    }
    const leakage = questionAnswerLeakage(probe.question, probe.expectedAnswer);
    if (leakage > MAX_QUESTION_ANSWER_LEAKAGE) {
      errors.push(`${probe.id}: question leaks ${(leakage * 100).toFixed(0)}% of answer content words (max ${MAX_QUESTION_ANSWER_LEAKAGE * 100}%)`);
    }
  }
}

function checkSessions(loaded: LoadedSeed, epochs: number, errors: string[]): void {
  const sessionText = new Map<string, string>();
  for (const session of loaded.sessions) {
    if (session.epoch < 1 || session.epoch > epochs) {
      errors.push(`${session.sessionId}: epoch ${session.epoch} out of range`);
    }
    sessionText.set(
      `${session.userId}|${session.epoch}`,
      session.turns.map((t) => t.content).join("\n").toLowerCase(),
    );
  }
  for (const fact of loaded.facts) {
    const text = sessionText.get(`${fact.userId}|${fact.introducedEpoch}`);
    if (text === undefined) {
      errors.push(`${fact.id}: no session found for ${fact.userId} epoch ${fact.introducedEpoch}`);
      continue;
    }
    if (!text.includes(fact.value.toLowerCase())) {
      errors.push(`${fact.id}: introducing session never states the value "${fact.value}"`);
    }
  }
}

function checkDistribution(
  loaded: LoadedSeed,
  manifest: DriftGenManifest,
  errors: string[],
  warnings: string[],
): void {
  const { epochs } = manifest.counts;
  const target = manifest.generator.factsPerEpoch;
  const perUserEpoch = new Map<string, number>();
  for (const fact of loaded.facts) {
    const key = `${fact.userId}|${fact.introducedEpoch}`;
    perUserEpoch.set(key, (perUserEpoch.get(key) ?? 0) + 1);
  }
  for (const [key, count] of [...perUserEpoch.entries()].sort()) {
    if (Math.abs(count - target) > target * FACT_COUNT_TOLERANCE) {
      const [userId, epoch] = key.split("|");
      errors.push(`seed ${loaded.seed}: ${userId} epoch ${epoch} introduces ${count} facts, outside ±10% of target ${target}`);
    }
  }

  const eligible = loaded.facts.filter(
    (f) => f.introducedEpoch + MIN_DRIFT_GAP <= epochs,
  );
  const drifting = eligible.filter((f) => f.kind === "drifting").length;
  const contradicted = eligible.filter((f) => f.kind === "contradicted").length;
  const checks: [string, number, number][] = [
    ["drifting", drifting, manifest.generator.driftingRatio],
    ["contradicted", contradicted, manifest.generator.contradictedRatio],
  ];
  for (const [label, count, expected] of checks) {
    if (eligible.length === 0) continue;
    const measured = count / eligible.length;
    const delta = Math.abs(measured - expected);
    if (delta <= RATIO_TOLERANCE) continue;
    const message = `seed ${loaded.seed}: ${label} ratio ${measured.toFixed(3)} deviates from ${expected} by more than ${RATIO_TOLERANCE} (eligible base ${eligible.length})`;
    if (eligible.length < MIN_STATISTICAL_BASE) {
      warnings.push(`${message} — base too small, reported as warning`);
    } else {
      errors.push(message);
    }
  }
}

async function checkFileHashes(
  corpusDir: string,
  manifest: DriftGenManifest,
  errors: string[],
): Promise<void> {
  for (const [relPath, expected] of Object.entries(manifest.files)) {
    let data: Buffer;
    try {
      data = await readFile(path.join(corpusDir, relPath));
    } catch {
      errors.push(`manifest lists missing file: ${relPath}`);
      continue;
    }
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) {
      errors.push(`sha256 mismatch for ${relPath}: manifest ${expected}, actual ${actual}`);
    }
  }
}

export async function validateDriftCorpus(corpusDir: string): Promise<DriftValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const emptyStats: DriftValidationStats = {
    users: 0,
    epochs: 0,
    facts: 0,
    probes: 0,
    sessions: 0,
    factsPerEpochMean: 0,
    driftingRatio: 0,
    contradictedRatio: 0,
    probesByCategory: { current: 0, historical: 0, transition: 0, aggregation: 0 },
    maxQuestionAnswerLeakage: 0,
  };

  try {
    const dirStat = await stat(corpusDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, errors: [`not a directory: ${corpusDir}`], warnings, stats: emptyStats };
    }
  } catch {
    return { ok: false, errors: [`corpus directory not found: ${corpusDir}`], warnings, stats: emptyStats };
  }

  let manifest: DriftGenManifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(corpusDir, "dataset.manifest.json"), "utf8"),
    ) as DriftGenManifest;
  } catch {
    return {
      ok: false,
      errors: [`missing or invalid dataset.manifest.json in ${corpusDir}`],
      warnings,
      stats: emptyStats,
    };
  }
  if (!manifest.generator || typeof manifest.generator.factsPerEpoch !== "number") {
    return {
      ok: false,
      errors: ["manifest lacks generator parameters (generator.factsPerEpoch etc.)"],
      warnings,
      stats: emptyStats,
    };
  }

  await checkFileHashes(corpusDir, manifest, errors);

  let totalFacts = 0;
  let totalProbes = 0;
  let totalSessions = 0;
  let driftingCount = 0;
  let contradictedCount = 0;
  let maxLeakage = 0;
  const probesByCategory: DriftValidationStats["probesByCategory"] = {
    current: 0,
    historical: 0,
    transition: 0,
    aggregation: 0,
  };

  for (const seed of manifest.seeds) {
    const loaded = await loadSeedDir(corpusDir, seed, errors);
    checkFactIntegrity(loaded, manifest.counts.epochs, errors);
    checkProbeIntegrity(loaded, manifest.counts.epochs, errors);
    checkSessions(loaded, manifest.counts.epochs, errors);
    checkDistribution(loaded, manifest, errors, warnings);
    totalFacts += loaded.facts.length;
    totalProbes += loaded.probes.length;
    totalSessions += loaded.sessions.length;
    for (const fact of loaded.facts) {
      if (fact.kind === "drifting") driftingCount++;
      if (fact.kind === "contradicted") contradictedCount++;
    }
    for (const probe of loaded.probes) {
      if (probe.category in probesByCategory) probesByCategory[probe.category]++;
      maxLeakage = Math.max(
        maxLeakage,
        questionAnswerLeakage(probe.question, probe.expectedAnswer),
      );
    }
  }

  if (totalFacts !== manifest.counts.facts) {
    errors.push(`manifest counts.facts ${manifest.counts.facts} does not match corpus ${totalFacts}`);
  }
  if (totalProbes !== manifest.counts.probes) {
    errors.push(`manifest counts.probes ${manifest.counts.probes} does not match corpus ${totalProbes}`);
  }

  const denominator = manifest.seeds.length * manifest.counts.users * manifest.counts.epochs;
  const stats: DriftValidationStats = {
    users: manifest.counts.users,
    epochs: manifest.counts.epochs,
    facts: totalFacts,
    probes: totalProbes,
    sessions: totalSessions,
    factsPerEpochMean: denominator === 0 ? 0 : totalFacts / denominator,
    driftingRatio: totalFacts === 0 ? 0 : driftingCount / totalFacts,
    contradictedRatio: totalFacts === 0 ? 0 : contradictedCount / totalFacts,
    probesByCategory,
    maxQuestionAnswerLeakage: maxLeakage,
  };

  errors.sort();
  warnings.sort();
  return { ok: errors.length === 0, errors, warnings, stats };
}
