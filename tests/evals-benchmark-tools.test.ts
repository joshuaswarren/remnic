import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  runBenchmarkImportCliCommand,
  runBenchmarkStatusCliCommand,
  runBenchmarkValidateCliCommand,
} from "../src/cli.js";
import { validateEvalBenchmarkManifest } from "../packages/remnic-core/src/evals.js";

async function writeManifest(
  filePath: string,
  benchmarkId = "ama-memory",
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify(
      Object.assign({
        schemaVersion: 1,
        benchmarkId,
        title: "AMA-style benchmark pack",
        tags: ["trajectory", "objective-state"],
        sourceLinks: ["https://arxiv.org/abs/2602.22769"],
        cases: [
          {
            id: "case-1",
            prompt: "Recover the last changed system state and explain the next action.",
          },
        ],
      }, overrides),
      null,
      2,
    ),
    "utf8",
  );
}

test("validateEvalBenchmarkManifest rejects unsafe benchmarkId path segments", () => {
  const baseManifest = {
    schemaVersion: 1,
    benchmarkId: "ama-memory",
    title: "AMA-style benchmark pack",
    cases: [
      {
        id: "case-1",
        prompt: "Recover the last changed system state and explain the next action.",
      },
    ],
  };

  assert.equal(validateEvalBenchmarkManifest(baseManifest).benchmarkId, "ama-memory");

  for (const benchmarkId of [".", "..", "../x", "a/b"]) {
    assert.throws(
      () => validateEvalBenchmarkManifest({ ...baseManifest, benchmarkId }),
      /benchmarkId must be a safe path segment/,
      `${benchmarkId} should be rejected`,
    );
  }
});

test("benchmark-validate accepts a manifest JSON file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-file-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  const summary = await runBenchmarkValidateCliCommand({ path: manifestPath, memoryRedTeamBenchEnabled: false });

  assert.equal(summary.manifestPath, manifestPath);
  assert.equal(summary.benchmarkId, "ama-memory");
  assert.equal(summary.totalCases, 1);
  assert.deepEqual(summary.tags, ["trajectory", "objective-state"]);
});

test("benchmark-validate accepts a directory pack with root manifest.json", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-dir-"));
  const packDir = path.join(tmpDir, "ama-memory-pack");
  await mkdir(packDir, { recursive: true });
  await writeManifest(path.join(packDir, "manifest.json"));

  const summary = await runBenchmarkValidateCliCommand({ path: packDir, memoryRedTeamBenchEnabled: false });

  assert.equal(summary.sourcePath, packDir);
  assert.equal(summary.manifestPath, path.join(packDir, "manifest.json"));
  assert.equal(summary.benchmarkId, "ama-memory");
});

test("benchmark-validate accepts a memory red-team benchmark pack with attack metadata", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-red-team-"));
  const manifestPath = path.join(tmpDir, "memory-red-team.json");
  await writeManifest(manifestPath, "poisoning-corroboration-pack", {
    benchmarkType: "memory-red-team",
    attackClass: "provenance-spoofing",
    targetSurface: "trust-zone-promotion",
    tags: ["poisoning", "trust-zone"],
    sourceLinks: ["https://arxiv.org/abs/2602.16901"],
  });

  const summary = await runBenchmarkValidateCliCommand({ path: manifestPath, memoryRedTeamBenchEnabled: true });

  assert.equal(summary.benchmarkType, "memory-red-team");
  assert.equal(summary.attackClass, "provenance-spoofing");
  assert.equal(summary.targetSurface, "trust-zone-promotion");
});

test("benchmark-validate rejects memory red-team packs without attack metadata", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-red-team-bad-"));
  const manifestPath = path.join(tmpDir, "memory-red-team.json");
  await writeManifest(manifestPath, "poisoning-corroboration-pack", {
    benchmarkType: "memory-red-team",
  });

  await assert.rejects(
    () => runBenchmarkValidateCliCommand({ path: manifestPath, memoryRedTeamBenchEnabled: true }),
    /attackClass must be a non-empty string/i,
  );
});

test("benchmark-validate rejects memory red-team packs when the feature flag is off", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-validate-red-team-flag-off-"));
  const manifestPath = path.join(tmpDir, "memory-red-team.json");
  await writeManifest(manifestPath, "poisoning-corroboration-pack", {
    benchmarkType: "memory-red-team",
    attackClass: "provenance-spoofing",
    targetSurface: "trust-zone-promotion",
  });

  await assert.rejects(
    () => runBenchmarkValidateCliCommand({ path: manifestPath, memoryRedTeamBenchEnabled: false }),
    /memory-red-team benchmark packs require memoryRedTeamBenchEnabled/i,
  );
});

test("benchmark-import copies a manifest file into the eval benchmark store", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-file-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  const result = await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: false,
  });

  const importedManifest = JSON.parse(await readFile(path.join(result.targetDir, "manifest.json"), "utf8")) as {
    benchmarkId: string;
  };

  assert.equal(result.targetDir, path.join(tmpDir, "state", "evals", "benchmarks", "ama-memory"));
  assert.equal(result.overwritten, false);
  assert.equal(importedManifest.benchmarkId, "ama-memory");
});

test("benchmark-import preserves extra files when importing a directory pack", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-dir-"));
  const packDir = path.join(tmpDir, "pack");
  await mkdir(path.join(packDir, "fixtures"), { recursive: true });
  await writeManifest(path.join(packDir, "manifest.json"));
  await writeFile(path.join(packDir, "fixtures", "notes.md"), "# notes\n", "utf8");
  await writeFile(path.join(packDir, "fixtures", "case-data.json"), JSON.stringify({ fixture: true }, null, 2), "utf8");

  const result = await runBenchmarkImportCliCommand({
    path: packDir,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: false,
  });

  const fixture = await readFile(path.join(result.targetDir, "fixtures", "notes.md"), "utf8");
  const status = await runBenchmarkStatusCliCommand({
    memoryDir: tmpDir,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
    benchmarkBaselineSnapshotsEnabled: false,
    memoryRedTeamBenchEnabled: false,
  });

  assert.equal(fixture, "# notes\n");
  assert.equal(status.benchmarks.total, 1);
  assert.equal(status.benchmarks.invalid, 0);
  assert.deepEqual(status.invalidBenchmarks, []);
});

test("benchmark-status accounts for imported memory red-team benchmark packs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-status-red-team-"));
  const redTeamManifestPath = path.join(tmpDir, "memory-red-team.json");
  await writeManifest(redTeamManifestPath, "poisoning-corroboration-pack", {
    benchmarkType: "memory-red-team",
    attackClass: "provenance-spoofing",
    targetSurface: "trust-zone-promotion",
    tags: ["poisoning", "trust-zone"],
    sourceLinks: ["https://arxiv.org/abs/2602.16901"],
  });
  await runBenchmarkImportCliCommand({
    path: redTeamManifestPath,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: true,
  });

  const status = await runBenchmarkStatusCliCommand({
    memoryDir: tmpDir,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
    benchmarkBaselineSnapshotsEnabled: false,
    memoryRedTeamBenchEnabled: true,
  });

  assert.equal(status.benchmarks.redTeam, 1);
  assert.deepEqual(status.benchmarks.attackClasses, ["provenance-spoofing"]);
  assert.deepEqual(status.benchmarks.targetSurfaces, ["trust-zone-promotion"]);
});

test("benchmark-status ignores attack metadata on standard benchmark packs", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-status-standard-attack-fields-"));
  const standardManifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(standardManifestPath, "ama-memory", {
    attackClass: "should-not-count",
    targetSurface: "should-not-surface",
    tags: ["trajectory"],
  });
  await runBenchmarkImportCliCommand({
    path: standardManifestPath,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: false,
  });

  const status = await runBenchmarkStatusCliCommand({
    memoryDir: tmpDir,
    evalHarnessEnabled: true,
    evalShadowModeEnabled: false,
    benchmarkBaselineSnapshotsEnabled: false,
    memoryRedTeamBenchEnabled: false,
  });

  assert.equal(status.benchmarks.redTeam, 0);
  assert.deepEqual(status.benchmarks.attackClasses, []);
  assert.deepEqual(status.benchmarks.targetSurfaces, []);
});

test("benchmark-import rejects overwrite without force", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-no-force-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: false,
  });

  await assert.rejects(
    () =>
      runBenchmarkImportCliCommand({
        path: manifestPath,
        memoryDir: tmpDir,
        memoryRedTeamBenchEnabled: false,
      }),
    /rerun with force/i,
  );
});

test("benchmark-import allows overwrite with force", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "engram-bench-import-force-"));
  const manifestPath = path.join(tmpDir, "ama-memory.json");
  await writeManifest(manifestPath);

  await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
    memoryRedTeamBenchEnabled: false,
  });

  await writeManifest(manifestPath, "ama-memory");
  const result = await runBenchmarkImportCliCommand({
    path: manifestPath,
    memoryDir: tmpDir,
    force: true,
    memoryRedTeamBenchEnabled: false,
  });

  assert.equal(result.overwritten, true);
});
