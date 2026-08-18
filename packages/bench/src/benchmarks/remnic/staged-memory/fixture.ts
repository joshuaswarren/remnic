/**
 * Staged-memory synthetic fixture (issue #2346).
 *
 * Derives `staged-memory-synthetic` cases from a verified drift-gen corpus
 * (issue #1954): references rows by stable ID, never copies or regenerates
 * them, and never creates a second fact store. Byte-identical for the same
 * inputs (fixed sentinel timestamp, sorted rows, seeded distractor pick).
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DRIFT_GEN_VERSION } from "../../../generators/drift-gen/index.js";
import { ATTRIBUTE_SPECS, formatFactStatement } from "../../../generators/drift-gen/schedule.js";
import type { DriftSession, GoldFact } from "../../../generators/drift-gen/types.js";
import { contentWords, questionAnswerLeakage } from "../../../generators/drift-gen/validate.js";
import { createSeededRandom, shuffled } from "../../../seeded-random.js";
import {
  STAGED_MEMORY_CREATED_AT,
  STAGED_MEMORY_FIXTURE_NAME,
  STAGED_MEMORY_GENERATOR_VERSION,
  STAGED_MEMORY_NAMESPACES,
  STAGED_MEMORY_TRUSTED_PRINCIPAL,
  type StagedMemoryCaseV1,
  StagedMemoryCaseV1Schema,
  type StagedMemoryDistractorV1,
  type StagedMemoryFixtureManifestV1,
  StagedMemoryFixtureManifestV1Schema,
  assertSafeSourceManifestName,
} from "./schema.js";

const MAX_QUESTION_ANSWER_LEAKAGE = 0.6;
const MANIFEST_FILE = "manifest.json";
const CASES_FILE = "cases.jsonl";

/** Repo-relative logical name for the canonical committed smoke corpus. */
export const CANONICAL_DRIFT_SOURCE = "drift-gen-core";

export function canonicalDriftDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/drift-gen-core");
}

export interface StagedMemoryFixtureOptions {
  /** Verified drift-gen corpus directory (contains dataset.manifest.json). */
  driftDir: string;
  seed: number;
  /** Number of users to cover; capped at the corpus user count. */
  users?: number;
  /** Task cases generated per user; capped at available current facts. */
  casesPerUser?: number;
  /** Distractors per case; the paper's configuration examples are 3, 5, 7. */
  distractorCount?: number;
}

export interface StagedMemoryFixture {
  manifest: StagedMemoryFixtureManifestV1;
  cases: StagedMemoryCaseV1[];
}

/**
 * Fixed deterministic distractor templates (issue #2346: no LLM distractor
 * generator). Synthetic entities only; clause shapes mirror the drift
 * attribute templates so distractors compete for retrieval rank without
 * carrying any target entity, value, or answer token.
 */
const DISTRACTOR_TEMPLATES: readonly { templateId: string; text: string }[] = Object.freeze([
  { templateId: "dist-employer-1", text: "Marlow Petrov works at Quill Optical." },
  { templateId: "dist-employer-2", text: "Indira Calloway works at Ferroline Logistics." },
  { templateId: "dist-employer-3", text: "Otto Brandt works at Halyard Foods." },
  { templateId: "dist-role-1", text: "Priya Sundaram is a lighting technician." },
  { templateId: "dist-role-2", text: "Gustav Reyes is an archivist." },
  { templateId: "dist-role-3", text: "Nell Okafor is a hydrologist." },
  { templateId: "dist-city-1", text: "Tomas Lindqvist lives in Copper Hollow." },
  { templateId: "dist-city-2", text: "Yara Bennet lives in Port Saline." },
  { templateId: "dist-city-3", text: "Felix Amari lives in Greyfield." },
  { templateId: "dist-hobby-1", text: "Dessa Vidal has gotten into woodblock printing." },
  { templateId: "dist-hobby-2", text: "Ruben Castile has gotten into falconry." },
  { templateId: "dist-hobby-3", text: "Mira Holt has gotten into bonsai." },
  { templateId: "dist-pet-1", text: "Casper Iwu has a pair of canaries." },
  { templateId: "dist-pet-2", text: "Lotte Vermeer has a tarantula." },
  { templateId: "dist-pet-3", text: "Anya Petrova has a ferret." },
  { templateId: "dist-tool-1", text: "Silas Marsh relies on the cobalt ledger for daily planning." },
  { templateId: "dist-tool-2", text: "Juno Farrow relies on the paper compass for daily planning." },
  { templateId: "dist-tool-3", text: "Emeric Vale relies on the quiet almanac for daily planning." },
  { templateId: "dist-project-1", text: "Talía Ríos is leading the meadow inventory." },
  { templateId: "dist-project-2", text: "Bo Kwan is leading the harbor census." },
  { templateId: "dist-project-3", text: "Wren Osei is leading the lantern retrofit." },
  { templateId: "dist-noise-1", text: "Delphine Aron keeps spare pens in the blue drawer." },
  { templateId: "dist-noise-2", text: "Kit Serrano waters the office fern on Tuesdays." },
  { templateId: "dist-noise-3", text: "Petra Nyman alphabetizes the spice rack each month." },
]);

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function toStrictJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function activeFactsAtEpoch(facts: readonly GoldFact[], epoch: number): GoldFact[] {
  return facts.filter(
    (fact) => fact.introducedEpoch <= epoch && (fact.supersededEpoch === null || fact.supersededEpoch > epoch)
  );
}

function isCurrentAtEpoch(fact: GoldFact, epoch: number): boolean {
  return fact.introducedEpoch <= epoch && (fact.supersededEpoch === null || fact.supersededEpoch > epoch);
}

function factUserPrefixOk(factId: string, userId: string): boolean {
  return factId.startsWith(`gf-${userId}-`);
}

interface LoadedDriftCorpus {
  manifestName: string;
  manifestSha256: string;
  facts: GoldFact[];
  sessions: DriftSession[];
  seed: number;
}

async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((line) => JSON.parse(line) as unknown);
}

/**
 * Load and hash-verify the drift source corpus. A tampered or unverified
 * dataset fails preflight here — the staged fixture never builds on top of
 * unverified rows.
 */
async function loadVerifiedDriftCorpus(driftDir: string, seed: number): Promise<LoadedDriftCorpus> {
  // Error messages carry the basename only: the resolved drift directory can
  // be an operator home path and this is a public repo.
  const label = path.basename(driftDir);
  const manifestPath = path.join(driftDir, "dataset.manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown> & {
    name?: unknown;
    seeds?: unknown;
    files?: unknown;
  };
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    throw new Error(`drift corpus ${label} has no manifest name`);
  }
  if (!Array.isArray(manifest.seeds) || !manifest.seeds.includes(seed)) {
    throw new Error(`drift corpus ${label} does not carry seed ${seed}; generate it with drift-gen first`);
  }
  const files = (manifest.files ?? {}) as Record<string, string>;
  const seedDir = String(seed);
  const wanted = [path.posix.join(seedDir, "gold", "facts.jsonl"), path.posix.join(seedDir, "gold", "probes.jsonl")];
  for (const relPath of wanted) {
    const expected = files[relPath];
    if (typeof expected !== "string") {
      throw new Error(`drift manifest is missing a hash for ${relPath}`);
    }
    if (sha256(await readFile(path.join(driftDir, relPath), "utf8")) !== expected) {
      throw new Error(`drift corpus file ${relPath} fails its manifest hash`);
    }
  }
  const factRows = await readJsonlFile(path.join(driftDir, wanted[0] as string));
  const facts = factRows.map((row) => {
    const fact = row as Partial<GoldFact>;
    if (
      typeof fact.id !== "string" ||
      typeof fact.userId !== "string" ||
      typeof fact.statement !== "string" ||
      typeof fact.subject !== "string" ||
      typeof fact.attribute !== "string" ||
      typeof fact.value !== "string" ||
      typeof fact.introducedEpoch !== "number"
    ) {
      throw new Error(`drift corpus ${label} has a malformed gold fact row`);
    }
    return row as GoldFact;
  });
  const sessionFiles = Object.keys(files)
    .filter((relPath) => relPath.startsWith(`${seedDir}/users/`))
    .sort(compareStrings);
  const sessions: DriftSession[] = [];
  for (const relPath of sessionFiles) {
    const expected = files[relPath];
    if (sha256(await readFile(path.join(driftDir, relPath), "utf8")) !== expected) {
      throw new Error(`drift corpus file ${relPath} fails its manifest hash`);
    }
    sessions.push(...((await readJsonlFile(path.join(driftDir, relPath))) as DriftSession[]));
  }
  sessions.sort((a, b) => a.epoch - b.epoch || compareStrings(a.sessionId, b.sessionId));
  return {
    manifestName: manifest.name,
    manifestSha256: sha256(await readFile(manifestPath, "utf8")),
    facts,
    sessions,
    seed,
  };
}

/** Total string order: equality returns 0 so equal keys stay stable. */
function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
function forbiddenDistractorTokens(fact: GoldFact, relatedFacts: readonly GoldFact[]): Set<string> {
  const tokens = new Set<string>();
  for (const word of contentWords(fact.subject)) tokens.add(word);
  for (const word of contentWords(fact.value)) tokens.add(word);
  for (const word of contentWords(fact.statement)) tokens.add(word);
  for (const related of relatedFacts) {
    if (related.subject === fact.subject) {
      for (const word of contentWords(related.value)) tokens.add(word);
    }
  }
  return tokens;
}

function pickDistractors(
  rngOptions: { seed: number; caseOrdinal: number },
  count: number,
  forbidden: ReadonlySet<string>,
  requiredFactIds: readonly string[],
  sessionId: string
): StagedMemoryDistractorV1[] {
  const rng = createSeededRandom((rngOptions.seed ^ (rngOptions.caseOrdinal * 0x9e3779b1)) >>> 0);
  const candidates = shuffled(rng, [...DISTRACTOR_TEMPLATES]);
  const distractors: StagedMemoryDistractorV1[] = [];
  for (const template of candidates) {
    if (distractors.length >= count) break;
    const words = [...contentWords(template.text)];
    if (words.some((word) => forbidden.has(word))) continue;
    distractors.push({
      id: `${template.templateId}-${rngOptions.caseOrdinal}`,
      sessionId,
      text: template.text,
      forbiddenFactIds: [...requiredFactIds],
      templateId: template.templateId,
    });
  }
  if (distractors.length < count) {
    throw new Error(`only ${distractors.length} of ${count} requested distractors pass target-overlap checks`);
  }
  return distractors;
}

/**
 * Build the staged-memory fixture in memory from a verified drift corpus.
 * Pure: no filesystem writes (see `generateStagedMemoryFixture`).
 */
export async function buildStagedMemoryFixture(options: StagedMemoryFixtureOptions): Promise<StagedMemoryFixture> {
  const distractorCount = options.distractorCount ?? 3;
  if (!Number.isSafeInteger(distractorCount) || distractorCount < 1 || distractorCount > 7) {
    throw new Error("distractorCount must be an integer in [1, 7]");
  }
  const corpus = await loadVerifiedDriftCorpus(options.driftDir, options.seed);
  const userIds = [...new Set(corpus.facts.map((fact) => fact.userId))].sort();
  const users = Math.min(options.users ?? userIds.length, userIds.length);
  if (users < 1) {
    throw new Error("drift corpus has no users");
  }
  const casesPerUser = options.casesPerUser ?? 12;

  const cases: StagedMemoryCaseV1[] = [];
  let caseOrdinal = 0;
  for (let userIndex = 0; userIndex < users; userIndex += 1) {
    const userId = userIds[userIndex] as string;
    const userFacts = corpus.facts.filter((fact) => fact.userId === userId).sort((a, b) => compareStrings(a.id, b.id));
    const userSessions = corpus.sessions
      .filter((session) => session.userId === userId)
      .sort((a, b) => a.epoch - b.epoch || compareStrings(a.sessionId, b.sessionId));
    const exposureEpoch = userSessions.at(-1)?.epoch ?? 0;
    if (exposureEpoch < 1) {
      throw new Error(`drift user ${userId} has no exposure sessions`);
    }
    const active = activeFactsAtEpoch(userFacts, exposureEpoch);
    const salientFactIds = active.map((fact) => fact.id);
    // Gold rows cover the whole exposure window: current facts plus facts
    // superseded inside it (transitions need both sides).
    const goldFacts = userFacts
      .filter((fact) => fact.introducedEpoch <= exposureEpoch)
      .map((fact) => ({
        factId: fact.id,
        subject: fact.subject,
        attribute: fact.attribute,
        value: fact.value,
        statement: fact.statement,
        introducedEpoch: fact.introducedEpoch,
      }));
    const goldMemories = goldFacts.map((fact) => fact.statement);
    const transitions = userFacts
      .filter(
        (fact) => fact.supersededEpoch !== null && fact.supersededEpoch <= exposureEpoch && fact.supersededBy !== null
      )
      .map((fact) => {
        const successor = userFacts.find((candidate) => candidate.id === fact.supersededBy);
        // A supersession pointer without a live successor is a broken link:
        // reject it instead of silently dropping the transition.
        if (!successor || !isCurrentAtEpoch(successor, exposureEpoch)) {
          throw new Error(`fact ${fact.id} supersession link is broken at epoch ${exposureEpoch}`);
        }
        return {
          oldFactId: fact.id,
          newFactId: fact.supersededBy as string,
          epoch: fact.supersededEpoch as number,
          kind: fact.kind === "contradicted" ? ("contradicted" as const) : ("drifting" as const),
        };
      });
    const sourceSessionRefs = userSessions.map((session) => session.sessionId);
    const namespace = STAGED_MEMORY_NAMESPACES[userIndex % STAGED_MEMORY_NAMESPACES.length] as string;
    const lastSession = userSessions.at(-1);
    if (!lastSession || lastSession.date.length === 0) {
      throw new Error(`drift user ${userId} has no pinned effective timestamp`);
    }
    const effectiveTimestamp = lastSession.date;

    const taskFacts = active.slice(0, Math.min(casesPerUser, active.length));
    for (const fact of taskFacts) {
      caseOrdinal += 1;
      const spec = ATTRIBUTE_SPECS.find((candidate) => candidate.attribute === fact.attribute);
      if (!spec) {
        throw new Error(`fact ${fact.id} carries an unknown attribute ${fact.attribute}`);
      }
      const forbiddenFactIds = userFacts
        .filter((candidate) => candidate.supersededBy === fact.id)
        .map((candidate) => candidate.id);
      const question = spec.questionCurrent(fact.subject);
      const leakage = questionAnswerLeakage(question, fact.value);
      if (leakage > MAX_QUESTION_ANSWER_LEAKAGE) {
        throw new Error(`task for fact ${fact.id} leaks its answer into the question (${leakage.toFixed(2)})`);
      }
      const caseId = `sm-${userId}-${String(caseOrdinal).padStart(4, "0")}`;
      const exposureSessionId = `staged-${caseId}`;
      cases.push({
        schemaVersion: 1,
        caseId,
        userId,
        namespace,
        seed: options.seed,
        exposure: {
          sessionId: exposureSessionId,
          sourceSessionRefs,
          salientFactIds,
          goldFacts,
          goldMemories,
          exposureEpoch,
          effectiveTimestamp,
        },
        transitions,
        distractors: pickDistractors(
          { seed: options.seed, caseOrdinal },
          distractorCount,
          forbiddenDistractorTokens(fact, userFacts),
          [fact.id],
          `${exposureSessionId}-stage2`
        ),
        task: {
          question,
          expectedAnswer: fact.value,
          requiredFactIds: [fact.id],
          forbiddenFactIds,
          answerFormat: "exact",
        },
        scope: {
          principal: STAGED_MEMORY_TRUSTED_PRINCIPAL,
          allowedUserId: userId,
          allowedNamespace: namespace,
        },
      });
    }
  }
  if (cases.length === 0) {
    throw new Error("staged-memory fixture derived zero cases from the drift corpus");
  }

  const files: Record<string, string> = {
    [CASES_FILE]: sha256(toCaseJsonl(cases)),
  };
  const manifest: StagedMemoryFixtureManifestV1 = {
    schemaVersion: 1,
    name: STAGED_MEMORY_FIXTURE_NAME,
    version: STAGED_MEMORY_GENERATOR_VERSION,
    generatorVersion: DRIFT_GEN_VERSION,
    seeds: [options.seed],
    source: {
      kind: "drift-gen",
      manifestName: corpus.manifestName,
      manifestSha256: corpus.manifestSha256,
    },
    counts: {
      users,
      cases: cases.length,
      distractors: distractorCount,
    },
    files,
    createdAt: STAGED_MEMORY_CREATED_AT,
    licenses: [{ source: "synthetic", license: "MIT (repo)" }],
    namespaces: [...STAGED_MEMORY_NAMESPACES],
  };
  assertSafeSourceManifestName(manifest.source.manifestName);
  return { manifest, cases };
}

function toCaseJsonl(cases: readonly StagedMemoryCaseV1[]): string {
  return `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Write the fixture to `outDir` deterministically (staged write + rename). */
export async function generateStagedMemoryFixture(
  options: StagedMemoryFixtureOptions & { outDir: string }
): Promise<StagedMemoryFixture> {
  const fixture = await buildStagedMemoryFixture(options);
  const staging = `${options.outDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, CASES_FILE), toCaseJsonl(fixture.cases), "utf8");
  await writeFile(path.join(staging, MANIFEST_FILE), toStrictJson(fixture.manifest), "utf8");
  await rm(options.outDir, { recursive: true, force: true });
  await rename(staging, options.outDir);
  return fixture;
}

export interface StagedMemoryValidationStats {
  users: number;
  cases: number;
  distractorsPerCase: number;
  transitions: number;
}

export interface StagedMemoryValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: StagedMemoryValidationStats;
}

/**
 * Validate an on-disk fixture against the strict v1 schemas plus the issue's
 * integrity rules: file hashes, symlinks, duplicate IDs, namespace binding,
 * cross-user fact references, broken supersession links, question/answer
 * leakage, and distractor target overlap.
 */
export async function validateStagedMemoryFixture(fixtureDir: string): Promise<StagedMemoryValidationReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dirStat = await lstat(fixtureDir).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    return {
      ok: false,
      errors: [`fixture directory not found: ${path.basename(fixtureDir)}`],
      warnings,
      stats: { users: 0, cases: 0, distractorsPerCase: 0, transitions: 0 },
    };
  }
  if (dirStat.isSymbolicLink()) {
    errors.push("fixture directory must not be a symlink");
  }

  const manifestPath = path.join(fixtureDir, MANIFEST_FILE);
  const rawManifest: unknown = await readFile(manifestPath, "utf8").catch(() => undefined);
  if (rawManifest === undefined) {
    return {
      ok: false,
      errors: ["fixture manifest.json is missing"],
      warnings,
      stats: { users: 0, cases: 0, distractorsPerCase: 0, transitions: 0 },
    };
  }
  const manifestParse = StagedMemoryFixtureManifestV1Schema.safeParse(
    typeof rawManifest === "string" ? JSON.parse(rawManifest) : rawManifest
  );
  if (!manifestParse.success) {
    return {
      ok: false,
      errors: manifestParse.error.issues.map(
        (issue) => `manifest: ${issue.path.join(".") || "<root>"} ${issue.message}`
      ),
      warnings,
      stats: { users: 0, cases: 0, distractorsPerCase: 0, transitions: 0 },
    };
  }
  const manifest = manifestParse.data;
  try {
    assertSafeSourceManifestName(manifest.source.manifestName);
  } catch (error) {
    errors.push((error as Error).message);
  }
  const namespaceSet = new Set(manifest.namespaces);
  if (namespaceSet.size < 2) {
    errors.push("manifest.namespaces must contain at least two distinct values");
  }
  for (const namespace of manifest.namespaces) {
    if (!(STAGED_MEMORY_NAMESPACES as readonly string[]).includes(namespace)) {
      errors.push(`namespace is outside the benchmark allowlist: ${namespace}`);
    }
  }
  if (!(CASES_FILE in manifest.files)) {
    errors.push(`manifest.files must hash ${CASES_FILE}`);
  }
  for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
    const filePath = path.join(fixtureDir, relPath);
    const stat = await lstat(filePath).catch(() => undefined);
    if (!stat) {
      errors.push(`fixture file listed in manifest is missing: ${relPath}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`fixture file must not be a symlink: ${relPath}`);
      continue;
    }
    if (sha256(await readFile(filePath, "utf8")) !== expectedHash) {
      errors.push(`fixture file fails its manifest hash: ${relPath}`);
    }
  }

  const rawCases = await readFile(path.join(fixtureDir, CASES_FILE), "utf8").catch(() => undefined);
  if (rawCases === undefined) {
    return {
      ok: false,
      errors: [...errors, "fixture cases.jsonl is missing"],
      warnings,
      stats: { users: 0, cases: 0, distractorsPerCase: 0, transitions: 0 },
    };
  }
  const seenCaseIds = new Set<string>();
  const cases: StagedMemoryCaseV1[] = [];
  for (const [index, line] of rawCases
    .split("\n")
    .filter((l) => l.trim())
    .entries()) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      errors.push(`cases.jsonl line ${index + 1} is not valid JSON`);
      continue;
    }
    const parsed = StagedMemoryCaseV1Schema.safeParse(row);
    if (!parsed.success) {
      errors.push(
        `case at line ${index + 1}: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
          .join("; ")}`
      );
      continue;
    }
    const fixtureCase = parsed.data;
    if (seenCaseIds.has(fixtureCase.caseId)) {
      errors.push(`duplicate caseId: ${fixtureCase.caseId}`);
    }
    seenCaseIds.add(fixtureCase.caseId);
    cases.push(fixtureCase);

    if (!namespaceSet.has(fixtureCase.namespace)) {
      errors.push(`case ${fixtureCase.caseId} binds an unallowlisted namespace`);
    }
    if (fixtureCase.namespace !== fixtureCase.scope.allowedNamespace) {
      errors.push(`case ${fixtureCase.caseId} namespace disagrees with scope.allowedNamespace`);
    }
    if (fixtureCase.scope.principal !== STAGED_MEMORY_TRUSTED_PRINCIPAL) {
      errors.push(`case ${fixtureCase.caseId} uses a non-benchmark principal`);
    }
    if (fixtureCase.scope.allowedUserId !== fixtureCase.userId) {
      errors.push(`case ${fixtureCase.caseId} scope user does not match its user`);
    }
    const referencedIds = [
      ...fixtureCase.exposure.salientFactIds,
      ...fixtureCase.transitions.flatMap((t) => [t.oldFactId, t.newFactId]),
      ...fixtureCase.task.requiredFactIds,
      ...fixtureCase.task.forbiddenFactIds,
    ];
    for (const factId of referencedIds) {
      if (!factUserPrefixOk(factId, fixtureCase.userId)) {
        errors.push(`case ${fixtureCase.caseId} references cross-user fact ${factId}`);
      }
    }
    const salient = new Set(fixtureCase.exposure.salientFactIds);
    const goldFactIds = new Set(fixtureCase.exposure.goldFacts.map((gold) => gold.factId));
    if (
      fixtureCase.exposure.goldMemories.length !== fixtureCase.exposure.goldFacts.length ||
      fixtureCase.exposure.goldMemories.some(
        (statement, index) => statement !== (fixtureCase.exposure.goldFacts[index]?.statement ?? "")
      )
    ) {
      errors.push(`case ${fixtureCase.caseId} goldMemories disagree with goldFacts`);
    }
    if (new Set([...goldFactIds]).size !== goldFactIds.size) {
      errors.push(`case ${fixtureCase.caseId} goldFacts contain duplicate fact IDs`);
    }
    for (const factId of fixtureCase.exposure.salientFactIds) {
      if (!goldFactIds.has(factId)) {
        errors.push(`case ${fixtureCase.caseId} salient fact ${factId} is missing from goldFacts`);
      }
    }
    for (const transition of fixtureCase.transitions) {
      if (!goldFactIds.has(transition.oldFactId) || !goldFactIds.has(transition.newFactId)) {
        errors.push(`case ${fixtureCase.caseId} transition references a fact outside goldFacts`);
      }
    }
    for (const transition of fixtureCase.transitions) {
      if (salient.has(transition.oldFactId)) {
        errors.push(`case ${fixtureCase.caseId} transition lists superseded fact ${transition.oldFactId} as salient`);
      }
      if (!salient.has(transition.newFactId)) {
        errors.push(
          `case ${fixtureCase.caseId} transition successor ${transition.newFactId} is missing from salient facts`
        );
      }
    }
    for (const requiredId of fixtureCase.task.requiredFactIds) {
      if (!salient.has(requiredId)) {
        errors.push(`case ${fixtureCase.caseId} task requires non-salient fact ${requiredId}`);
      }
    }
    if (
      questionAnswerLeakage(fixtureCase.task.question, fixtureCase.task.expectedAnswer) > MAX_QUESTION_ANSWER_LEAKAGE
    ) {
      errors.push(`case ${fixtureCase.caseId} task question leaks its answer`);
    }
    const answerTokens = contentWords(fixtureCase.task.expectedAnswer);
    // Target tokens: subject, value, and statement words of the task's
    // required AND forbidden (superseded) facts — the entities, attributes,
    // and values a distractor must not carry. Unrelated gold statements that
    // merely share a clause verb ("gotten into", "lives in") are not target
    // overlap; the deterministic templates intentionally reuse clause shapes.
    const goldByFactId = new Map(fixtureCase.exposure.goldFacts.map((row) => [row.factId, row]));
    const targetTokens = new Set<string>();
    for (const factId of [...fixtureCase.task.requiredFactIds, ...fixtureCase.task.forbiddenFactIds]) {
      const row = goldByFactId.get(factId);
      if (!row) continue;
      for (const word of [...contentWords(row.subject), ...contentWords(row.value), ...contentWords(row.statement)]) {
        targetTokens.add(word);
      }
    }
    for (const distractor of fixtureCase.distractors) {
      const distractorWords = contentWords(distractor.text);
      let overlapsGold = false;
      let carriesAnswer = false;
      for (const word of distractorWords) {
        if (targetTokens.has(word)) overlapsGold = true;
        if (answerTokens.has(word)) carriesAnswer = true;
      }
      if (overlapsGold) {
        errors.push(
          `case ${fixtureCase.caseId} distractor ${distractor.id} carries target entity, attribute, or value tokens`
        );
      }
      if (carriesAnswer) {
        errors.push(`case ${fixtureCase.caseId} distractor ${distractor.id} carries answer tokens`);
      }
      if (!fixtureCase.task.requiredFactIds.every((id) => distractor.forbiddenFactIds.includes(id))) {
        errors.push(`case ${fixtureCase.caseId} distractor ${distractor.id} does not forbid all required facts`);
      }
    }
  }

  const perCaseDistractors = new Set(cases.map((c) => c.distractors.length));
  if (perCaseDistractors.size > 1) {
    warnings.push("distractor counts vary across cases");
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      users: new Set(cases.map((c) => c.userId)).size,
      cases: cases.length,
      distractorsPerCase: cases[0]?.distractors.length ?? 0,
      transitions: cases.reduce((sum, c) => sum + c.transitions.length, 0),
    },
  };
}

/** Load a fixture for execution: validation failure is a preflight failure. */
export async function loadStagedMemoryFixture(
  fixtureDir: string
): Promise<StagedMemoryFixture & { fixtureHash: string }> {
  const report = await validateStagedMemoryFixture(fixtureDir);
  if (!report.ok) {
    throw new Error(`staged-memory fixture failed preflight:\n${report.errors.map((e) => `  - ${e}`).join("\n")}`);
  }
  const rawManifest = JSON.parse(
    await readFile(path.join(fixtureDir, MANIFEST_FILE), "utf8")
  ) as StagedMemoryFixtureManifestV1;
  const rawCases = await readFile(path.join(fixtureDir, CASES_FILE), "utf8");
  const cases = rawCases
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as StagedMemoryCaseV1);
  return {
    manifest: rawManifest,
    cases,
    fixtureHash: sha256(rawCases),
  };
}

export interface StagedMemoryCliOptions {
  action: "generate" | "validate";
  dir?: string;
  driftDir?: string;
  users?: number;
  casesPerUser?: number;
  seed?: number;
  distractorCount?: number;
  out?: string;
  json?: boolean;
}

export async function runStagedMemoryCliCommand(
  options: StagedMemoryCliOptions
): Promise<{ exitCode: number; output: string }> {
  if (options.action === "validate") {
    if (!options.dir) {
      return {
        exitCode: 1,
        output: "staged-memory validate requires a fixture directory",
      };
    }
    const report = await validateStagedMemoryFixture(options.dir);
    const lines = [
      report.ok ? "staged-memory fixture: VALID" : "staged-memory fixture: INVALID",
      `  users=${report.stats.users} cases=${report.stats.cases} distractorsPerCase=${report.stats.distractorsPerCase} transitions=${report.stats.transitions}`,
      ...report.warnings.map((warning) => `  warning: ${warning}`),
      ...report.errors.map((error) => `  error: ${error}`),
    ];
    return {
      exitCode: report.ok ? 0 : 1,
      output: options.json ? JSON.stringify(report, null, 2) : lines.join("\n"),
    };
  }

  if (!options.out) {
    return {
      exitCode: 1,
      output: "staged-memory generate requires --out <dir>",
    };
  }
  const driftDir = options.driftDir ?? canonicalDriftDir();
  const fixture = await generateStagedMemoryFixture({
    driftDir,
    seed: options.seed ?? 11,
    users: options.users,
    casesPerUser: options.casesPerUser,
    distractorCount: options.distractorCount,
    outDir: options.out,
  });
  if (options.json) {
    return { exitCode: 0, output: JSON.stringify(fixture.manifest, null, 2) };
  }
  return {
    exitCode: 0,
    output: [
      `staged-memory v${STAGED_MEMORY_GENERATOR_VERSION}: wrote fixture to ${options.out}`,
      `  users=${fixture.manifest.counts.users} cases=${fixture.manifest.counts.cases} distractors=${fixture.manifest.counts.distractors} seed=${fixture.manifest.seeds[0]}`,
      `  source=${fixture.manifest.source.manifestName}@${fixture.manifest.source.manifestSha256.slice(0, 12)}`,
      `  run with: remnic bench run staged-memory-synthetic-v1 --dataset-dir ${options.out}`,
    ].join("\n"),
  };
}

// formatFactStatement is re-exported for the runner's oracle arm, which must
// render gold evidence exactly as drift-gen rendered it into sessions.
export { formatFactStatement };
