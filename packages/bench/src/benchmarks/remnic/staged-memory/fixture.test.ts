/**
 * Behavior-focused tests for the staged-memory fixture (issue #2346):
 * byte determinism per seed, hash/structure tamper rejection, path-safety
 * rejection, distractor counts 3/5/7, and dataset hygiene on generated
 * fixtures.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateDriftCorpus } from "../../../generators/drift-gen/index.js";
import {
  buildStagedMemoryFixture,
  generateStagedMemoryFixture,
  runStagedMemoryCliCommand,
  validateStagedMemoryFixture,
} from "./fixture.js";
import { type StagedMemoryCaseV1, StagedMemoryCaseV1Schema, assertSafeSourceManifestName } from "./schema.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../");
const canonicalDriftDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/drift-gen-core");

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "staged-memory-fixture-"));
}

/** Generate a fresh drift corpus in a temp dir so tests never share state. */
async function makeDriftDir(seed = 11): Promise<string> {
  const dir = await makeTempDir();
  await generateDriftCorpus({ users: 2, epochs: 4, seed, outDir: dir });
  return dir;
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

test("same seed produces byte-identical fixtures in two directories", async () => {
  const driftDir = await makeDriftDir();
  const outA = await makeTempDir();
  const outB = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: outA,
    casesPerUser: 4,
    distractorCount: 3,
  });
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: outB,
    casesPerUser: 4,
    distractorCount: 3,
  });
  const casesA = await readFile(path.join(outA, "cases.jsonl"), "utf8");
  const casesB = await readFile(path.join(outB, "cases.jsonl"), "utf8");
  assert.equal(casesA, casesB, "cases.jsonl must be byte-identical");
  assert.equal(
    await readFile(path.join(outA, "manifest.json"), "utf8"),
    await readFile(path.join(outB, "manifest.json"), "utf8"),
    "manifest.json must be byte-identical"
  );
  assert.equal(sha256(casesA), sha256(casesB));
  await cleanup(driftDir, outA, outB);
});

test("a fresh fixture validates and carries the required manifest fields", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  const fixture = await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 4,
    distractorCount: 3,
  });
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, true, report.errors.join("; "));
  assert.equal(fixture.manifest.schemaVersion, 1);
  assert.equal(fixture.manifest.name, "staged-memory-synthetic");
  assert.equal(fixture.manifest.createdAt, "1970-01-01T00:00:00.000Z");
  assert.ok(fixture.manifest.namespaces.length >= 2);
  assert.ok(fixture.cases.length > 0);
  for (const fixtureCase of fixture.cases) {
    assert.ok(fixture.manifest.namespaces.includes(fixtureCase.namespace));
    assert.equal(fixtureCase.namespace, fixtureCase.scope.allowedNamespace);
    assert.equal(fixtureCase.exposure.goldMemories.length, fixtureCase.exposure.goldFacts.length);
    assert.equal(fixtureCase.task.answerFormat, "exact");
  }
  await cleanup(driftDir, out);
});

test("distractor counts 3, 5, and 7 all generate and validate", async () => {
  const driftDir = await makeDriftDir();
  for (const distractorCount of [3, 5, 7]) {
    const out = await makeTempDir();
    const fixture = await generateStagedMemoryFixture({
      driftDir,
      seed: 11,
      outDir: out,
      casesPerUser: 3,
      distractorCount,
    });
    const report = await validateStagedMemoryFixture(out);
    assert.equal(report.ok, true, `count ${distractorCount}: ${report.errors.join("; ")}`);
    assert.ok(fixture.cases.every((c) => c.distractors.length === distractorCount));
    await rm(out, { recursive: true, force: true });
  }
  await rm(driftDir, { recursive: true, force: true });
});

test("a tampered cases file fails its manifest hash", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  const casesPath = path.join(out, "cases.jsonl");
  const original = await readFile(casesPath, "utf8");
  await writeFile(casesPath, `${original}{"tampered":true}\n`, "utf8");
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("fails its manifest hash")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

test("a symlinked cases file is rejected", async (t) => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  const casesPath = path.join(out, "cases.jsonl");
  await rm(casesPath);
  try {
    await symlink("elsewhere.jsonl", casesPath);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${(error as Error).message}`);
    return;
  }
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("symlink")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

/** Re-hash a tampered fixture so structural checks (not hash checks) fire. */
async function tamperAndRehash(out: string, tamper: (fixtureCases: StagedMemoryCaseV1[]) => void): Promise<void> {
  const casesPath = path.join(out, "cases.jsonl");
  const rows = (await readFile(casesPath, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => StagedMemoryCaseV1Schema.parse(JSON.parse(line)));
  tamper(rows);
  const rewritten = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(casesPath, rewritten, "utf8");
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    files: Record<string, string>;
  };
  manifest.files["cases.jsonl"] = sha256(rewritten);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("duplicate case IDs are rejected", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  await tamperAndRehash(out, (rows) => {
    rows[1].caseId = rows[0].caseId;
  });
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("duplicate caseId")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

test("cross-user fact references are rejected", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  await tamperAndRehash(out, (rows) => {
    const foreignCase = rows.find((row) => row.userId !== rows[0].userId);
    assert.ok(foreignCase, "fixture must contain more than one user");
    const foreignId = foreignCase.task.requiredFactIds[0];
    const target = rows[0];
    target.task.requiredFactIds = [foreignId];
    target.exposure.salientFactIds = [foreignId, ...target.exposure.salientFactIds];
    target.exposure.goldFacts = [...target.exposure.goldFacts, { ...target.exposure.goldFacts[0], factId: foreignId }];
  });
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("cross-user")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

test("goldMemories that disagree with goldFacts are rejected", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  await tamperAndRehash(out, (rows) => {
    rows[0].exposure.goldMemories[0] = "tampered gold statement";
  });
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("goldMemories disagree")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

test("unknown manifest fields are rejected by the strict schema", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  const manifestPath = path.join(out, "manifest.json");
  const manifest: Record<string, unknown> = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.surpriseField = true;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const report = await validateStagedMemoryFixture(out);
  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((error) => error.includes("surpriseField")),
    report.errors.join("; ")
  );
  await cleanup(driftDir, out);
});

test("home-like, absolute, and .. source manifest names are rejected", () => {
  assert.throws(() => assertSafeSourceManifestName("/home/user/fixture/source-manifest.json"), /repo-relative/);
  assert.throws(() => assertSafeSourceManifestName("/Users/JaneDoe/datasets/manifest.json"), /repo-relative/);
  assert.throws(() => assertSafeSourceManifestName("a/../../etc/passwd"), /\.\./);
  assert.throws(() => assertSafeSourceManifestName(""), /empty/);
  assert.doesNotThrow(() => assertSafeSourceManifestName("drift-gen-core"));
});

test("unverified drift source fails fixture preflight", async () => {
  const driftDir = await makeDriftDir();
  const factsPath = path.join(driftDir, "11", "gold", "facts.jsonl");
  const facts = await readFile(factsPath, "utf8");
  await writeFile(factsPath, `${facts}\n`, "utf8");
  await assert.rejects(buildStagedMemoryFixture({ driftDir, seed: 11, casesPerUser: 3 }), /manifest hash/);
  await rm(driftDir, { recursive: true, force: true });
});

test("generated fixtures pass the repo dataset hygiene scanner", async () => {
  const driftDir = await makeDriftDir();
  const out = await makeTempDir();
  await generateStagedMemoryFixture({
    driftDir,
    seed: 11,
    outDir: out,
    casesPerUser: 3,
  });
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [path.join(repoRoot, "scripts", "check-dataset-hygiene.mjs")],
    { env: { ...process.env, REMNIC_HYGIENE_ROOTS: out } }
  );
  assert.equal(
    /violation|FAIL/i.test(`${stdout}${stderr}`),
    false,
    `hygiene scanner flagged the fixture: ${stdout}${stderr}`
  );
  await cleanup(driftDir, out);
});

test("generate/validate commands round-trip on the committed corpus", async () => {
  const out = await makeTempDir();
  const result = await runStagedMemoryCliCommand({
    action: "generate",
    driftDir: canonicalDriftDir,
    seed: 11,
    casesPerUser: 4,
    out,
    distractorCount: 3,
  });
  assert.equal(result.exitCode, 0, result.output);
  const validation = await runStagedMemoryCliCommand({
    action: "validate",
    dir: out,
  });
  assert.equal(validation.exitCode, 0, validation.output);
  assert.match(validation.output, /VALID/);
  await rm(out, { recursive: true, force: true });
});

test("generate without --out is rejected", async () => {
  const result = await runStagedMemoryCliCommand({ action: "generate" });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /--out/);
});
