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
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type {
  DriftGenManifest,
  DriftSession,
  DriftValidationReport,
  DriftValidationStats,
  GoldFact,
  GoldProbe,
} from "./types.js";
import { MIN_DRIFT_GAP, formatFactStatement } from "./schedule.js";
import { epochDate } from "./render.js";

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

const FACT_KINDS = new Set(["stable", "drifting", "contradicted"]);
const PROBE_CATEGORIES = new Set(["current", "historical", "transition", "aggregation"]);
const SESSION_TURN_ROLES = new Set(["user", "assistant"]);

function isGoldFactShape(row: unknown): row is GoldFact {
  if (typeof row !== "object" || row === null) return false;
  const f = row as Record<string, unknown>;
  return (
    typeof f.id === "string" &&
    typeof f.userId === "string" &&
    typeof f.statement === "string" &&
    typeof f.subject === "string" &&
    typeof f.attribute === "string" &&
    typeof f.value === "string" &&
    Number.isSafeInteger(f.introducedEpoch) &&
    (f.supersededEpoch === null || Number.isSafeInteger(f.supersededEpoch)) &&
    (f.supersededBy === null || typeof f.supersededBy === "string") &&
    typeof f.kind === "string" &&
    FACT_KINDS.has(f.kind) &&
    Array.isArray(f.probes)
  );
}

function isGoldProbeShape(row: unknown): row is GoldProbe {
  if (typeof row !== "object" || row === null) return false;
  const p = row as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.userId === "string" &&
    Number.isSafeInteger(p.epoch) &&
    typeof p.question === "string" &&
    typeof p.expectedAnswer === "string" &&
    Array.isArray(p.requiredFactIds) &&
    p.requiredFactIds.every((id) => typeof id === "string") &&
    typeof p.category === "string" &&
    PROBE_CATEGORIES.has(p.category)
  );
}

function isDriftSessionShape(row: unknown): row is DriftSession {
  if (typeof row !== "object" || row === null) return false;
  const s = row as Record<string, unknown>;
  return (
    typeof s.sessionId === "string" &&
    typeof s.userId === "string" &&
    Number.isSafeInteger(s.epoch) &&
    typeof s.date === "string" &&
    Array.isArray(s.turns) &&
    s.turns.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as Record<string, unknown>).role === "string" &&
        SESSION_TURN_ROLES.has((t as Record<string, unknown>).role as string) &&
        typeof (t as Record<string, unknown>).content === "string",
    )
  );
}

/**
 * Externally supplied corpora can be syntactically valid JSON with mistyped
 * fields; every row is shape-checked here so malformed data surfaces as a
 * validation error instead of a crash in the integrity checks.
 */
async function readJsonl<T>(
  filePath: string,
  errors: string[],
  isShape: (row: unknown) => row is T,
): Promise<T[]> {
  let raw: string;
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      errors.push(`symlinked corpus file rejected: ${filePath}`);
      return [];
    }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${filePath}:${i + 1}: invalid JSON line`);
      continue;
    }
    if (!isShape(parsed)) {
      errors.push(`${filePath}:${i + 1}: row does not match the expected record shape`);
      continue;
    }
    rows.push(parsed);
  }
  return rows;
}

async function isNonSymlinkDirectory(dirPath: string, errors: string[]): Promise<boolean> {
  try {
    const stats = await lstat(dirPath);
    if (stats.isSymbolicLink()) {
      errors.push(`symlinked corpus directory rejected: ${dirPath}`);
      return false;
    }
    if (!stats.isDirectory()) {
      errors.push(`corpus path is not a directory: ${dirPath}`);
      return false;
    }
    return true;
  } catch {
    errors.push(`missing directory: ${dirPath}`);
    return false;
  }
}

async function hasNoSymlinkComponents(
  rootDir: string,
  targetPath: string,
  errors: string[],
  description: string,
): Promise<boolean> {
  let current = rootDir;
  for (const part of path.relative(rootDir, targetPath).split(path.sep)) {
    if (part.length === 0 || part === ".") continue;
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        errors.push(`${description} contains a symlinked path component: ${path.relative(rootDir, current)}`);
        return false;
      }
    } catch {
      errors.push(`${description} is missing: ${path.relative(rootDir, current)}`);
      return false;
    }
  }
  return true;
}

function corpusRelativePath(corpusDir: string, targetPath: string): string {
  return path.relative(corpusDir, targetPath).split(path.sep).join("/");
}

interface LoadedSeed {
  seed: number;
  facts: GoldFact[];
  probes: GoldProbe[];
  sessions: DriftSession[];
  consumedFiles: string[];
}

async function loadSeedDir(
  corpusDir: string,
  seed: number,
  errors: string[],
): Promise<LoadedSeed> {
  const seedDir = path.join(corpusDir, String(seed));
  const empty: LoadedSeed = { seed, facts: [], probes: [], sessions: [], consumedFiles: [] };
  if (!(await isNonSymlinkDirectory(seedDir, errors))) return empty;

  const goldDir = path.join(seedDir, "gold");
  const factsPath = path.join(goldDir, "facts.jsonl");
  const probesPath = path.join(goldDir, "probes.jsonl");
  let facts: GoldFact[] = [];
  let probes: GoldProbe[] = [];
  const consumedFiles: string[] = [];
  if (await isNonSymlinkDirectory(goldDir, errors)) {
    consumedFiles.push(
      corpusRelativePath(corpusDir, factsPath),
      corpusRelativePath(corpusDir, probesPath),
    );
    facts = await readJsonl<GoldFact>(factsPath, errors, isGoldFactShape);
    probes = await readJsonl<GoldProbe>(probesPath, errors, isGoldProbeShape);
  }

  const sessions: DriftSession[] = [];
  const usersDir = path.join(seedDir, "users");
  if (!(await isNonSymlinkDirectory(usersDir, errors))) {
    return { seed, facts, probes, sessions, consumedFiles };
  }

  const userIds: string[] = [];
  try {
    const entries = await readdir(usersDir, { withFileTypes: true });
    for (const entry of entries) {
      const userDir = path.join(usersDir, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`symlinked corpus entry rejected: ${userDir}`);
        continue;
      }
      if (entry.isDirectory()) userIds.push(entry.name);
    }
  } catch {
    errors.push(`missing directory: ${usersDir}`);
    return { seed, facts, probes, sessions, consumedFiles };
  }

  for (const userId of userIds.sort()) {
    const userDir = path.join(usersDir, userId);
    const sessionsPath = path.join(userDir, "sessions.jsonl");
    consumedFiles.push(corpusRelativePath(corpusDir, sessionsPath));
    for (const session of await readJsonl<DriftSession>(sessionsPath, errors, isDriftSessionShape)) {
      if (session.userId !== userId) {
        errors.push(`${session.sessionId}: userId ${session.userId} does not match directory ${userId}`);
        continue;
      }
      sessions.push(session);
    }
  }

  return { seed, facts, probes, sessions, consumedFiles };
}

function checkFactIntegrity(loaded: LoadedSeed, epochs: number, errors: string[]): void {
  const byId = new Map(loaded.facts.map((f) => [f.id, f]));
  if (byId.size !== loaded.facts.length) {
    errors.push(`seed ${loaded.seed}: duplicate fact ids`);
  }
  for (const fact of loaded.facts) {
    try {
      if (fact.statement !== formatFactStatement(fact.subject, fact.attribute, fact.value)) {
        errors.push(`${fact.id}: statement does not match subject, attribute, and value`);
      }
    } catch {
      errors.push(`${fact.id}: attribute is not recognized`);
    }
    if (fact.introducedEpoch < 1 || fact.introducedEpoch > epochs) {
      errors.push(`${fact.id}: introducedEpoch ${fact.introducedEpoch} out of range 1..${epochs}`);
    }
    if ((fact.supersededBy === null) !== (fact.supersededEpoch === null)) {
      errors.push(`${fact.id}: supersededBy and supersededEpoch must be set together`);
    }
    const realizedKind =
      fact.supersededEpoch === null
        ? "stable"
        : fact.supersededEpoch === fact.introducedEpoch + 1
          ? "contradicted"
          : "drifting";
    if (fact.kind !== realizedKind) {
      errors.push(`${fact.id}: kind "${fact.kind}" does not match realized lifecycle "${realizedKind}"`);
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
      if (successor.userId !== fact.userId) {
        errors.push(`${fact.id}: successor ${successor.id} belongs to a different user`);
      }
      if (successor.value === fact.value) {
        errors.push(`${fact.id}: successor ${successor.id} repeats the same value`);
      }
    }
  }
  const factsBySlot = new Map<string, GoldFact[]>();
  for (const fact of loaded.facts) {
    const slot = `${fact.userId}\u0000${fact.subject}\u0000${fact.attribute}`;
    const facts = factsBySlot.get(slot) ?? [];
    facts.push(fact);
    factsBySlot.set(slot, facts);
  }
  for (const facts of factsBySlot.values()) {
    facts.sort((a, b) => a.introducedEpoch - b.introducedEpoch || a.id.localeCompare(b.id));
    for (let index = 1; index < facts.length; index++) {
      const previous = facts[index - 1]!;
      const current = facts[index]!;
      if (previous.supersededEpoch === null || previous.supersededEpoch > current.introducedEpoch) {
        errors.push(`${current.id}: overlaps active lifecycle for ${previous.id}`);
      }
    }
  }
}

function expectedProbeAnswer(probe: GoldProbe, facts: GoldFact[]): string | null {
  switch (probe.category) {
    case "current":
    case "historical":
      return facts.length === 1 ? facts[0]!.value : null;
    case "transition":
      return facts.length === 2 ? `from ${facts[0]!.value} to ${facts[1]!.value}` : null;
    case "aggregation":
      return facts.map((fact) => fact.value).join("; ");
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
      if (
        probe.category === "aggregation" &&
        fact.supersededEpoch !== null &&
        fact.supersededEpoch <= probe.epoch
      ) {
        errors.push(`${probe.id}: aggregation probe targets fact ${factId} already superseded at epoch ${fact.supersededEpoch}`);
      }
    }
    const requiredFactCount =
      probe.category === "transition" ? 2 : probe.category === "aggregation" ? null : 1;
    if (
      requiredFactCount !== null &&
      probe.requiredFactIds.length !== requiredFactCount
    ) {
      errors.push(
        `${probe.id}: ${probe.category} probe must require exactly ${requiredFactCount} fact${requiredFactCount === 1 ? "" : "s"}`,
      );
    }

    const requiredFacts = probe.requiredFactIds.map((factId) => byId.get(factId));
    if (requiredFacts.every((fact): fact is GoldFact => fact !== undefined)) {
      for (const fact of requiredFacts) {
        if (fact.userId !== probe.userId) {
          errors.push(`${probe.id}: required fact ${fact.id} belongs to user ${fact.userId}, not ${probe.userId}`);
        }
      }
      const expectedAnswer = expectedProbeAnswer(probe, requiredFacts);
      if (expectedAnswer !== null && probe.expectedAnswer !== expectedAnswer) {
        errors.push(`${probe.id}: expectedAnswer does not match the referenced facts`);
      }
      if (
        probe.category === "transition" &&
        requiredFacts.length === 2 &&
        requiredFacts[0]!.supersededBy !== requiredFacts[1]!.id
      ) {
        errors.push(`${probe.id}: transition probe facts are not linked by supersession`);
      }
      if (
        probe.category === "transition" &&
        requiredFacts.length === 2 &&
        requiredFacts[1]!.supersededEpoch !== null &&
        requiredFacts[1]!.supersededEpoch <= probe.epoch
      ) {
        errors.push(`${probe.id}: transition probe targets successor ${requiredFacts[1]!.id} already superseded at epoch ${requiredFacts[1]!.supersededEpoch}`);
      }

    }
    if (probe.category === "current") {
      const fact = byId.get(probe.requiredFactIds[0]);
      if (fact && fact.supersededEpoch !== null && fact.supersededEpoch <= probe.epoch) {
        errors.push(`${probe.id}: current probe targets fact ${fact.id} already superseded at epoch ${fact.supersededEpoch}`);
      }
    }
    if (probe.category === "historical") {
      const fact = byId.get(probe.requiredFactIds[0]);
      if (fact && (fact.supersededEpoch === null || fact.supersededEpoch > probe.epoch)) {
        errors.push(`${probe.id}: historical probe targets fact ${fact.id} not superseded by epoch ${probe.epoch}`);
      }
      const successor = fact?.supersededBy ? byId.get(fact.supersededBy) : undefined;
      if (successor?.supersededEpoch !== null && successor?.supersededEpoch !== undefined && successor.supersededEpoch <= probe.epoch) {
        errors.push(`${probe.id}: historical probe targets stale successor ${successor.id} superseded at epoch ${successor.supersededEpoch}`);
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

function checkEmbeddedFactProbes(loaded: LoadedSeed, errors: string[]): void {
  const canonicalById = new Map(loaded.probes.map((probe) => [probe.id, probe]));
  for (const fact of loaded.facts) {
    for (const probe of fact.probes) {
      if (!isGoldProbeShape(probe)) {
        errors.push(`${fact.id}: embedded probe does not match the expected record shape`);
        continue;
      }
      const canonical = canonicalById.get(probe.id);
      if (!canonical || JSON.stringify(canonical) !== JSON.stringify(probe)) {
        errors.push(`${fact.id}: embedded probe ${probe.id} does not match gold/probes.jsonl`);
      } else if (!canonical.requiredFactIds.includes(fact.id)) {
        errors.push(`${fact.id}: embedded probe ${probe.id} does not reference its owning fact`);
      }
    }
  }
}

function checkSessions(
  loaded: LoadedSeed,
  users: number,
  epochs: number,
  errors: string[],
): void {
  const sessionText = new Map<string, string>();
  const sessionIds = new Set<string>();
  for (const session of loaded.sessions) {
    if (sessionIds.has(session.sessionId)) {
      errors.push(`seed ${loaded.seed}: duplicate sessionId ${session.sessionId}`);
    }
    sessionIds.add(session.sessionId);
    if (session.epoch < 1 || session.epoch > epochs) {
      errors.push(`${session.sessionId}: epoch ${session.epoch} out of range`);
    } else {
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(session.date);
      const day = dateMatch ? Number(dateMatch[3]) : 0;
      if (
        !dateMatch ||
        day < 1 ||
        day > 28 ||
        session.date !== epochDate(session.epoch, day)
      ) {
        errors.push(`${session.sessionId}: date must be a valid canonical date in epoch ${session.epoch}`);
      }
    }
    const key = `${session.userId}|${session.epoch}`;
    if (sessionText.has(key)) {
      errors.push(`${session.sessionId}: duplicate session for ${key}`);
      continue;
    }
    sessionText.set(key, session.turns.map((t) => t.content).join("\n").toLowerCase());
  }
  if (sessionText.size !== users * epochs) {
    errors.push(
      `seed ${loaded.seed}: expected ${users * epochs} unique user/epoch sessions, found ${sessionText.size}`,
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
  const userIds = new Set(loaded.sessions.map((session) => session.userId));
  if (userIds.size !== manifest.counts.users) {
    errors.push(`seed ${loaded.seed}: expected ${manifest.counts.users} users, found ${userIds.size}`);
  }
  for (const userId of [...userIds].sort()) {
    for (let epoch = 1; epoch <= epochs; epoch++) {
      const key = `${userId}|${epoch}`;
      const count = perUserEpoch.get(key) ?? 0;
      if (Math.abs(count - target) > target * FACT_COUNT_TOLERANCE) {
        errors.push(`seed ${loaded.seed}: ${userId} epoch ${epoch} introduces ${count} facts, outside ±10% of target ${target}`);
      }
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
    const tolerance = Math.max(
      RATIO_TOLERANCE,
      3 * Math.sqrt((expected * (1 - expected)) / eligible.length),
    );
    if (delta <= tolerance) continue;
    const message = `seed ${loaded.seed}: ${label} ratio ${measured.toFixed(3)} deviates from ${expected} by more than ${tolerance.toFixed(3)} (eligible base ${eligible.length})`;
    if (eligible.length < MIN_STATISTICAL_BASE) {
      warnings.push(`${message} — base too small, reported as warning`);
    } else {
      errors.push(message);
    }
  }
}

function isIntegerAtLeast(value: unknown, minimum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function hasValidDriftRatios(driftingRatio: unknown, contradictedRatio: unknown): boolean {
  return (
    typeof driftingRatio === "number" &&
    Number.isFinite(driftingRatio) &&
    driftingRatio >= 0 &&
    driftingRatio <= 1 &&
    typeof contradictedRatio === "number" &&
    Number.isFinite(contradictedRatio) &&
    contradictedRatio >= 0 &&
    contradictedRatio <= 1 &&
    driftingRatio + contradictedRatio <= 1
  );
}

function isManifestShape(value: unknown): value is DriftGenManifest {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const counts = m.counts as Record<string, unknown> | undefined;
  const generator = m.generator as Record<string, unknown> | undefined;
  return (

    typeof m.name === "string" &&
    typeof m.version === "string" &&
    typeof m.generatorVersion === "string" &&
    typeof m.createdAt === "string" &&
    Array.isArray(m.licenses) &&
    m.licenses.length > 0 &&
    m.licenses.every(
      (license) =>
        typeof license === "object" &&
        license !== null &&
        typeof (license as Record<string, unknown>).source === "string" &&
        typeof (license as Record<string, unknown>).license === "string",
    ) &&
    Array.isArray(m.seeds) &&
    m.seeds.length > 0 &&
    m.seeds.every((s) => Number.isSafeInteger(s) && s >= 0) &&
    new Set(m.seeds).size === m.seeds.length &&
    typeof counts === "object" &&
    counts !== null &&
    !Array.isArray(counts) &&
    isIntegerAtLeast(counts.users, 1) &&
    isIntegerAtLeast(counts.epochs, 2) &&
    isIntegerAtLeast(counts.facts, 1) &&
    isIntegerAtLeast(counts.probes, 1) &&
    typeof generator === "object" &&
    generator !== null &&
    !Array.isArray(generator) &&
    isIntegerAtLeast(generator.factsPerEpoch, 1) &&
    hasValidDriftRatios(generator.driftingRatio, generator.contradictedRatio) &&
    typeof m.files === "object" &&
    m.files !== null &&
    !Array.isArray(m.files) &&
    Object.entries(m.files as Record<string, unknown>).every(
      ([k, v]) => typeof k === "string" && typeof v === "string",
    )
  );
}

async function checkFileHashes(
  corpusDir: string,
  manifest: DriftGenManifest,
  errors: string[],
): Promise<void> {
  const resolvedRoot = path.resolve(corpusDir);
  for (const [relPath, expected] of Object.entries(manifest.files)) {
    const absPath = path.resolve(corpusDir, relPath);
    if (absPath !== resolvedRoot && !absPath.startsWith(resolvedRoot + path.sep)) {
      errors.push(`manifest lists a path outside the corpus root: ${relPath}`);
      continue;
    }
    if (!await hasNoSymlinkComponents(resolvedRoot, absPath, errors, `manifest path ${relPath}`)) {
      continue;
    }
    let data: Buffer;
    try {
      data = await readFile(absPath);
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

function checkConsumedFilesAreHashed(
  loaded: LoadedSeed,
  manifest: DriftGenManifest,
  errors: string[],
): void {
  for (const relPath of loaded.consumedFiles) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, relPath)) {
      errors.push(`manifest is missing a sha256 entry for consumed corpus file: ${relPath}`);
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
    const rootStat = await lstat(corpusDir);
    if (rootStat.isSymbolicLink()) {
      return {
        ok: false,
        errors: [`corpus root must not be a symlink: ${corpusDir}`],
        warnings,
        stats: emptyStats,
      };
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, errors: [`not a directory: ${corpusDir}`], warnings, stats: emptyStats };
    }
  } catch {
    return { ok: false, errors: [`corpus directory not found: ${corpusDir}`], warnings, stats: emptyStats };
  }

  const manifestPath = path.join(corpusDir, "dataset.manifest.json");
  if (!(await hasNoSymlinkComponents(corpusDir, manifestPath, errors, "dataset manifest"))) {
    return { ok: false, errors, warnings, stats: emptyStats };
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return {
      ok: false,
      errors: [`missing or invalid dataset.manifest.json in ${corpusDir}`],
      warnings,
      stats: emptyStats,
    };
  }
  if (!isManifestShape(manifestRaw)) {
    return {
      ok: false,
      errors: ["dataset.manifest.json does not match the expected manifest shape (name, version, seeds, counts, generator, files)"],
      warnings,
      stats: emptyStats,
    };
  }
  const manifest: DriftGenManifest = manifestRaw;

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
    checkConsumedFilesAreHashed(loaded, manifest, errors);
    checkEmbeddedFactProbes(loaded, errors);
    checkFactIntegrity(loaded, manifest.counts.epochs, errors);
    checkProbeIntegrity(loaded, manifest.counts.epochs, errors);
    checkSessions(loaded, manifest.counts.users, manifest.counts.epochs, errors);
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
