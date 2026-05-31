import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import {
  comparePublicBenchmarkSota,
  roundedJsonNumberReplacer,
} from "../scripts/bench/public-sota/compare-public-benchmark-sota.mjs";
import { manifestArtifactHashIdentity } from "../scripts/bench/public-sota/evidence-integrity.mjs";
import {
  assertNoInvalidRawScores,
  buildDiagnosticsSummary,
  statusTimes,
} from "../scripts/bench/public-sota/evidence-run-utils.mjs";

const execFileAsync = promisify(execFile);

const CODEX_PROVIDER = {
  provider: "codex-cli",
  model: "gpt-5.5",
  reasoningEffort: "xhigh",
};

const RUN_ID = "public-sota-diagnostics-test";
const STARTED_AT = "2026-05-16T00:00:00.000Z";
const FINISHED_AT = "2026-05-16T00:01:00.000Z";

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

async function createRunDirs(prefix: string): Promise<{
  root: string;
  datasetDir: string;
  diagnosticsDir: string;
  outDir: string;
  resultsDir: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const datasetDir = path.join(root, "dataset");
  const resultsDir = path.join(root, RUN_ID);
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const outDir = path.join(root, "out");
  const datasetFixture = "{}\n";
  await mkdir(datasetDir, { recursive: true });
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(datasetDir, "fixture.json"), datasetFixture, "utf8");
  return { root, datasetDir, diagnosticsDir, outDir, resultsDir };
}

async function writeBaseManifest(
  resultsDir: string,
  benchmark: string,
  resultPath: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const datasetFile = {
    path: "fixture.json",
    kind: "file",
    sizeBytes: Buffer.byteLength("{}\n", "utf8"),
    sha256: sha256String("{}\n"),
  };
  const dataset = {
    benchmark,
    status: "hashed",
    fileCount: 1,
    totalBytes: datasetFile.sizeBytes,
    sha256: sha256String(stableStringify([datasetFile])),
    files: [datasetFile],
    ...overrides,
  };
  const rawResult = JSON.parse(await readFile(resultPath, "utf8"));
  const resultBody = await readFile(resultPath);
  const resultEntry = {
    path: path.relative(resultsDir, resultPath).split(path.sep).join("/"),
    sha256: createHash("sha256").update(resultBody).digest("hex"),
    sizeBytes: resultBody.byteLength,
    resultId: rawResult.meta.id,
    benchmark,
    mode: rawResult.meta.mode,
    gitSha: rawResult.meta.gitSha,
    runCount: rawResult.meta.runCount,
    seeds: rawResult.meta.seeds,
    taskCount: rawResult.results.tasks.length,
    configHash: sha256String(stableStringify(rawResult.config)),
  };
  await writeJson(path.join(resultsDir, "MANIFEST.json"), {
    schemaVersion: 1,
    run: {
      id: RUN_ID,
      selectedBenchmarks: [benchmark],
      runtimeProfiles: ["real"],
    },
    datasets: [dataset],
    results: [resultEntry],
  });
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function writeGenericVerifierFixture(
  root: string,
  benchmark: string,
  artifact: Record<string, unknown>,
  comparison: Record<string, unknown>,
  targetMap: Record<string, unknown>,
): Promise<string> {
  const evidenceDir = path.join(root, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  const artifactName = `${benchmark}-artifact.json`;
  const artifactPath = path.join(evidenceDir, artifactName);
  await writeJson(artifactPath, artifact);
  const artifactBody = await readFile(artifactPath);
  const taskCount = Array.isArray(artifact.perTaskScores) ? artifact.perTaskScores.length : 0;
  const diagnosticsCount = Math.max(1, taskCount);

  await writeJson(path.join(evidenceDir, `${benchmark}-sota-comparison.json`), comparison);
  await writeJson(path.join(evidenceDir, `${benchmark}-diagnostics-summary.json`), {
    runId: RUN_ID,
    benchmark,
    checked: diagnosticsCount,
    complete: diagnosticsCount,
    inFlight: 0,
    afterCutoff: 0,
    invalidTimestamps: 0,
    errored: 0,
    nonzero: 0,
    providers: { "codex-cli": diagnosticsCount },
    models: { "gpt-5.5": diagnosticsCount },
    reasoningEfforts: { xhigh: diagnosticsCount },
    serviceTiers: { fast: diagnosticsCount },
  });
  await writeJson(path.join(evidenceDir, "current-target-map.json"), targetMap);

  const gitSha = String((artifact.system as { gitSha?: string } | undefined)?.gitSha ?? "0123456789abcdef0123456789abcdef01234567");
  const rawEntry = {
    path: `${benchmark}-raw-result.json`,
    sha256: "a".repeat(64),
    sizeBytes: 123,
    resultId: `${benchmark}-fixture`,
    benchmark,
    mode: "full",
    gitSha,
    runCount: 1,
    seeds: [1],
    taskCount,
    configHash: "b".repeat(64),
  };
  const manifestWithoutHash = {
    schemaVersion: 1,
    run: {
      id: RUN_ID,
      mode: "full",
      selectedBenchmarks: [benchmark],
      runtimeProfiles: ["real"],
    },
    git: {
      commit: gitSha,
      shortCommit: gitSha.slice(0, 8),
      dirty: false,
      dirtyEntryCount: 0,
    },
    command: {
      cwd: "<repo-root>",
      argv: ["bench", "published", "--name", benchmark],
      envKeys: ["OPENAI_API_KEY"],
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    configFiles: [],
    datasets: [
      {
        benchmark,
        status: "hashed",
        path: "fixture",
        realpath: "fixture",
        fileCount: 0,
        totalBytes: 0,
        sha256: "c".repeat(64),
        files: [],
      },
    ],
    results: [rawEntry],
    publicArtifacts: [
      {
        path: artifactName,
        sha256: createHash("sha256").update(artifactBody).digest("hex"),
        sizeBytes: artifactBody.byteLength,
        resultId: rawEntry.resultId,
        benchmark,
        mode: "full",
        gitSha,
        runCount: 1,
        seeds: [1],
        taskCount,
        publicSafe: true,
        sourceResultPath: rawEntry.path,
        sourceResultSha256: rawEntry.sha256,
        sourceResultSizeBytes: rawEntry.sizeBytes,
      },
    ],
  };
  const manifest = {
    ...manifestWithoutHash,
    artifactHash: sha256String(stableStringify(manifestArtifactHashIdentity(manifestWithoutHash))),
  };
  await writeJson(path.join(evidenceDir, `MANIFEST.${benchmark}.json`), manifest);
  assert.equal(await sha256File(artifactPath), manifest.publicArtifacts[0].sha256);
  return evidenceDir;
}

async function runGenericVerifiers(evidenceDir: string, benchmark: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [
      path.join("scripts", "bench", "public-sota", "verify-public-benchmark-sota-evidence.mjs"),
      evidenceDir,
      path.join(evidenceDir, "current-target-map.json"),
      benchmark,
    ],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
  );
  await execFileAsync(
    process.execPath,
    [
      path.join("scripts", "bench", "public-sota", "verify-public-generic-sota-evidence.template.mjs"),
      evidenceDir,
      benchmark,
    ],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
  );
}

async function assertRejectsGenericVerifier(
  evidenceDir: string,
  benchmark: string,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "verify-public-benchmark-sota-evidence.mjs"),
        evidenceDir,
        path.join(evidenceDir, "current-target-map.json"),
        benchmark,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    ),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, pattern);
      return true;
    },
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "verify-public-generic-sota-evidence.template.mjs"),
        evidenceDir,
        benchmark,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    ),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, pattern);
      return true;
    },
  );
}

async function writeDiagnostics(diagnosticsDir: string): Promise<void> {
  await writeValidDiagnostics(diagnosticsDir);
  await writeJson(path.join(diagnosticsDir, "invalid-started-at.json"), {
    runId: RUN_ID,
    finishedAt: "2026-05-16T00:00:30.000Z",
    provider: "codex-cli",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "fast",
    result: { status: 0 },
  });
}

async function writeValidDiagnostics(diagnosticsDir: string, count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const suffix = count === 1 ? "valid" : `valid-${String(index + 1).padStart(2, "0")}`;
    await writeJson(path.join(diagnosticsDir, `${suffix}.json`), {
      runId: RUN_ID,
      startedAt: new Date(Date.parse("2026-05-16T00:00:10.000Z") + index * 1000).toISOString(),
      finishedAt: new Date(Date.parse("2026-05-16T00:00:20.000Z") + index * 1000).toISOString(),
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });
  }
}

async function writeInstantDiagnostics(diagnosticsDir: string, timestamp: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeJson(path.join(diagnosticsDir, `instant-${String(index + 1).padStart(2, "0")}.json`), {
      runId: RUN_ID,
      startedAt: timestamp,
      finishedAt: timestamp,
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });
  }
}

async function assertRejectsInvalidDiagnostics(
  script: string,
  args: string[],
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, /diagnostics must have zero invalid timestamps/);
      return true;
    },
  );
}

async function assertRejectsDiagnosticsCoverage(
  script: string,
  args: string[],
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, /diagnostics checked count must cover published task count/);
      return true;
    },
  );
}

async function assertRejectsDatasetDrift(
  script: string,
  args: string[],
  benchmark: string,
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, new RegExp(`dataset hash for ${benchmark} does not match the run manifest`));
      return true;
    },
  );
}

async function assertRejectsRawResultDrift(
  script: string,
  args: string[],
): Promise<void> {
  await assert.rejects(
    execFileAsync(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      maxBuffer: 1024 * 1024,
    }),
    (error: unknown) => {
      assert(error && typeof error === "object");
      const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
      assert.match(output, /raw result sha256 .* does not match the run manifest/);
      return true;
    },
  );
}

async function writeAmemGymResult(
  resultPath: string,
  taskCountOrScores: number | number[] = 1,
): Promise<void> {
  const scores = Array.isArray(taskCountOrScores)
    ? taskCountOrScores
    : Array.from({ length: taskCountOrScores }, () => 1);
  const meanScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  await writeJson(resultPath, {
    meta: {
      id: "amemgym-test-result",
      benchmark: "amemgym",
      mode: "full",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      remnicVersion: "test",
      runCount: 1,
      seeds: [1],
      timestamp: FINISHED_AT,
    },
    config: {
      runtimeProfile: "real",
      systemProvider: CODEX_PROVIDER,
      judgeProvider: CODEX_PROVIDER,
      internalProvider: CODEX_PROVIDER,
      remnicConfig: {},
    },
    environment: {
      nodeVersion: process.version,
      os: process.platform,
      hardware: process.arch,
    },
    results: {
      aggregates: {
        normalized_memory_score: { mean: meanScore },
      },
      tasks: scores.map((score, index) => ({
        taskId: `profile-q${index + 1}`,
        details: { profileId: "profile", questionIndex: index + 1 },
        scores: { normalized_memory_score: score },
      })),
    },
  });
}

async function writeMemoryArenaResult(resultPath: string): Promise<void> {
  await writeJson(resultPath, {
    meta: {
      id: "memory-arena-test-result",
      benchmark: "memory-arena",
      mode: "full",
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      remnicVersion: "test",
      runCount: 1,
      seeds: [1],
      timestamp: FINISHED_AT,
    },
    config: {
      runtimeProfile: "real",
      systemProvider: CODEX_PROVIDER,
      judgeProvider: CODEX_PROVIDER,
      internalProvider: CODEX_PROVIDER,
      remnicConfig: {},
    },
    environment: {
      nodeVersion: process.version,
      os: process.platform,
      hardware: process.arch,
    },
    results: {
      aggregates: {
        process_score: { mean: 1 },
      },
      tasks: [
        memoryArenaTask("bundled_shopping", 1),
        memoryArenaTask("group_travel_planner", 2, { plan_field_recall: 1 }),
        memoryArenaTask("progressive_search", 3),
        memoryArenaTask("formal_reasoning_math", 4),
        memoryArenaTask("formal_reasoning_phys", 5),
      ],
    },
  });
}

test("public raw score validation scopes failure sentinels to AMemGym", () => {
  assertNoInvalidRawScores({
    meta: { benchmark: "amemgym" },
    results: {
      aggregates: {
        normalized_memory_score: { mean: -0.5 },
      },
      tasks: [
        {
          taskId: "amemgym-failed-task",
          scores: {
            normalized_memory_score: -1,
          },
        },
      ],
    },
  });

  assert.throws(
    () => assertNoInvalidRawScores({
      meta: { benchmark: "personamem" },
      results: {
        aggregates: {
          llm_judge: { mean: -1 },
        },
        tasks: [
          {
            taskId: "personamem-failed-task",
            scores: {
              llm_judge: -1,
            },
          },
        ],
      },
    }),
    /raw aggregate llm_judge\.mean must be finite, non-negative, or an accepted failure sentinel aggregate/,
  );
});

test("generic public SOTA packager rejects diagnostics with invalid timestamps", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-");
  try {
    await writeDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);

    await assertRejectsInvalidDiagnostics(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects diagnostics with invalid timestamps", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-");
  try {
    await writeDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await assertRejectsInvalidDiagnostics(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects diagnostics that do not cover published tasks", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-coverage-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath, 2);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);

    await assertRejectsDiagnosticsCoverage(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager preserves AMemGym failure sentinels", async () => {
  const dirs = await createRunDirs("remnic-public-sota-amemgym-failure-sentinel-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir, 2);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath, [0, -1]);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const manifest = JSON.parse(await readFile(path.join(dirs.outDir, "MANIFEST.amemgym.json"), "utf8"));
    const artifact = JSON.parse(await readFile(path.join(dirs.outDir, manifest.publicArtifacts[0].path), "utf8"));
    assert.equal(artifact.metrics.normalized_memory_score, -0.5);
    assert.deepEqual(
      artifact.perTaskScores.map((task: { scores: { normalized_memory_score: number } }) => task.scores.normalized_memory_score),
      [0, -1],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects non-sentinel negative scores", async () => {
  const dirs = await createRunDirs("remnic-public-sota-negative-score-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir, 2);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath, [1, -0.5]);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
          "--result", resultPath,
          "--results-dir", dirs.resultsDir,
          "--dataset-dir", dirs.datasetDir,
          "--repo-root", process.cwd(),
          "--out-dir", dirs.outDir,
        ],
        { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      ),
      (error: unknown) => {
        assert(error && typeof error === "object");
        const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
        assert.match(output, /score normalized_memory_score must be finite, non-negative, or an accepted failure sentinel/);
        return true;
      },
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects diagnostics that do not cover published tasks", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-coverage-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await assertRejectsDiagnosticsCoverage(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("diagnostics summary excludes records that started before benchmark start", async () => {
  const dirs = await createRunDirs("remnic-public-sota-diagnostics-window-");
  try {
    await writeJson(path.join(dirs.diagnosticsDir, "before-start.json"), {
      runId: RUN_ID,
      startedAt: "2026-05-15T23:59:50.000Z",
      finishedAt: "2026-05-16T00:00:10.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });
    await writeValidDiagnostics(dirs.diagnosticsDir);

    const summary = buildDiagnosticsSummary(
      dirs.resultsDir,
      RUN_ID,
      "amemgym",
      STARTED_AT,
      FINISHED_AT,
      "2026-05-16T00:02:00.000Z",
    );

    assert.equal(summary?.beforeStart, 1);
    assert.equal(summary?.checked, 1);
    assert.equal(summary?.providers["codex-cli"], 1);
    assert.equal(summary?.minStartedAt, "2026-05-16T00:00:10.000Z");
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("diagnostics summary excludes transient retry failure records", async () => {
  const dirs = await createRunDirs("remnic-public-sota-diagnostics-retry-");
  try {
    await writeJson(path.join(dirs.diagnosticsDir, "retry-sigterm.json"), {
      runId: RUN_ID,
      startedAt: "2026-05-16T00:00:10.000Z",
      finishedAt: "2026-05-16T00:00:20.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      retry: { attempt: 1, maxAttempts: 3, transientFailure: true },
      result: { status: null, signal: "SIGTERM" },
      error: "Codex CLI completion failed (signal SIGTERM)",
    });
    await writeJson(path.join(dirs.diagnosticsDir, "retry-success.json"), {
      runId: RUN_ID,
      startedAt: "2026-05-16T00:00:21.000Z",
      finishedAt: "2026-05-16T00:00:30.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      retry: { attempt: 2, maxAttempts: 3 },
      result: { status: 0 },
    });

    const summary = buildDiagnosticsSummary(
      dirs.resultsDir,
      RUN_ID,
      "amemgym",
      STARTED_AT,
      FINISHED_AT,
      "2026-05-16T00:02:00.000Z",
    );

    assert.equal(summary?.totalFiles, 2);
    assert.equal(summary?.checked, 1);
    assert.equal(summary?.complete, 1);
    assert.equal(summary?.errored, 0);
    assert.equal(summary?.nonzero, 0);
    assert.equal(summary?.providers["codex-cli"], 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("public evidence diagnostics use the latest restart lifecycle start", async () => {
  const dirs = await createRunDirs("remnic-public-sota-diagnostics-restart-window-");
  try {
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      [
        "benchmark\tstatus\ttimestamp",
        "memory-arena\tstart\t2026-05-17T00:00:00.000Z",
        "memory-arena\trestart-after-reboot\t2026-05-17T02:00:00.000Z",
        "memory-arena\tsuccess\t2026-05-17T03:00:00.000Z",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeJson(path.join(dirs.diagnosticsDir, "pre-restart-failed.json"), {
      runId: RUN_ID,
      startedAt: "2026-05-17T01:59:00.000Z",
      finishedAt: "2026-05-17T01:59:30.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      error: "Codex CLI completion failed (signal SIGTERM)",
    });
    await writeJson(path.join(dirs.diagnosticsDir, "post-restart-ok.json"), {
      runId: RUN_ID,
      startedAt: "2026-05-17T02:00:10.000Z",
      finishedAt: "2026-05-17T02:00:20.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });

    const times = statusTimes(dirs.resultsDir, "memory-arena", FINISHED_AT);
    assert.equal(times.startedAt, "2026-05-17T00:00:00.000Z");
    assert.equal(times.lifecycleStartedAt, "2026-05-17T02:00:00.000Z");
    assert.equal(times.successAt, "2026-05-17T03:00:00.000Z");

    const summary = buildDiagnosticsSummary(
      dirs.resultsDir,
      RUN_ID,
      "memory-arena",
      times.lifecycleStartedAt,
      times.successAt,
      "2026-05-17T03:01:00.000Z",
    );
    assert.equal(summary?.beforeStart, 1);
    assert.equal(summary?.checked, 1);
    assert.equal(summary?.errored, 0);
    assert.equal(summary?.complete, 1);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("public evidence packagers keep artifact start separate from diagnostics restart window", async () => {
  const generic = await readFile(
    path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
    "utf8",
  );
  const memoryArena = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
    "utf8",
  );

  assert.match(generic, /const artifact = buildArtifact\(result, dataset, comparison, times\.startedAt\)/);
  assert.match(generic, /const filename = `\$\{times\.startedAt\.slice\(0, 10\)\}-\$\{benchmark\}-gpt-5\.5-real-/);
  assert.match(generic, /buildDiagnosticsSummary\([\s\S]*times\.lifecycleStartedAt[\s\S]*result\.meta\.timestamp/);

  assert.match(memoryArena, /const times = statusTimes\(resultsDir, 'memory-arena', result\.meta\.timestamp\)/);
  assert.match(memoryArena, /const startedAt = times\.startedAt \?\? result\.meta\.timestamp/);
  assert.match(memoryArena, /buildPublicArtifact\(result, dataset, derived, comparison, startedAt\)/);
  assert.match(memoryArena, /buildDiagnosticsSummary\([\s\S]*times\.lifecycleStartedAt[\s\S]*finishedAt/);
});

test("MemoryArena public SOTA packager falls back when status.tsv is missing", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-no-status-");
  try {
    await writeInstantDiagnostics(dirs.diagnosticsDir, FINISHED_AT, 5);
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const manifest = JSON.parse(await readFile(path.join(dirs.outDir, "MANIFEST.memory-arena.json"), "utf8"));
    const artifact = JSON.parse(await readFile(path.join(dirs.outDir, manifest.publicArtifacts[0].path), "utf8"));
    const diagnostics = JSON.parse(await readFile(path.join(dirs.outDir, "memory-arena-diagnostics-summary.json"), "utf8"));

    assert.equal(artifact.startedAt, FINISHED_AT);
    assert.equal(diagnostics.checked, 5);
    assert.equal(diagnostics.minStartedAt, FINISHED_AT);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects dataset drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-dataset-");
  try {
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath, { sha256: "different-dataset-hash" });

    await assertRejectsDatasetDrift(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      "amemgym",
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects dataset drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-dataset-");
  try {
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath, { sha256: "different-dataset-hash" });

    await assertRejectsDatasetDrift(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      "memory-arena",
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager rejects raw result drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-result-");
  try {
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.meta.id = "amemgym-drifted-result";
    await writeJson(resultPath, result);

    await assertRejectsRawResultDrift(
      path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager rejects raw result drift from the run manifest", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-result-");
  try {
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    result.meta.id = "memory-arena-drifted-result";
    await writeJson(resultPath, result);

    await assertRejectsRawResultDrift(
      path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
      [
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena public SOTA packager redacts local temp paths from public manifests", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-redact-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir, 5);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);
    const manifestPath = path.join(dirs.resultsDir, "MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.command = {
      cwd: dirs.root,
      argv: [
        "bench",
        "published",
        "--name",
        "memory-arena",
        "--dataset",
        dirs.datasetDir,
        "--results-dir",
        dirs.resultsDir,
        "--out",
        dirs.outDir,
      ],
      envKeys: ["OPENAI_API_KEY"],
    };
    await writeJson(manifestPath, manifest);

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const publicManifest = JSON.parse(await readFile(path.join(dirs.outDir, "MANIFEST.memory-arena.json"), "utf8"));
    const publicManifestBody = JSON.stringify(publicManifest);
    assert.equal(publicManifest.datasets[0].path, "<dataset-dir>");
    assert.equal(publicManifest.datasets[0].realpath, "<dataset-dir>");
    assert.deepEqual(publicManifest.command.argv, [
      "bench",
      "published",
      "--name",
      "memory-arena",
      "--dataset",
      "<dataset-dir>",
      "--results-dir",
      "<results-dir>",
      "--out",
      "<out-dir>",
    ]);
    assert.doesNotMatch(publicManifestBody, /remnic-public-sota-memoryarena-redact-/);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic public SOTA packager redacts local temp paths from public manifests", async () => {
  const dirs = await createRunDirs("remnic-public-sota-generic-redact-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\namemgym\tstart\t${STARTED_AT}\namemgym\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "amemgym-result.json");
    await writeAmemGymResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "amemgym", resultPath);
    const manifestPath = path.join(dirs.resultsDir, "MANIFEST.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.command = {
      cwd: dirs.root,
      argv: [
        "bench",
        "published",
        "--name",
        "amemgym",
        "--dataset",
        dirs.datasetDir,
        "--results-dir",
        dirs.resultsDir,
        "--out",
        dirs.outDir,
      ],
      envKeys: ["OPENAI_API_KEY"],
    };
    await writeJson(manifestPath, manifest);
    const targetMapPath = path.join(dirs.root, "target-map.json");
    await writeJson(targetMapPath, {
      benchmarks: {
        amemgym: {
          targets: {
            memoryAgent: { score: 0.5 },
            nativeLlm: { score: 0.25 },
          },
        },
      },
    });

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
        "--target-map", targetMapPath,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const publicManifest = JSON.parse(await readFile(path.join(dirs.outDir, "MANIFEST.amemgym.json"), "utf8"));
    const publicManifestBody = JSON.stringify(publicManifest);
    assert.equal(publicManifest.datasets[0].path, "<dataset-dir>");
    assert.equal(publicManifest.datasets[0].realpath, "<dataset-dir>");
    assert.deepEqual(publicManifest.command.argv, [
      "bench",
      "published",
      "--name",
      "amemgym",
      "--dataset",
      "<dataset-dir>",
      "--results-dir",
      "<results-dir>",
      "--out",
      "<out-dir>",
    ]);
    assert.doesNotMatch(publicManifestBody, /remnic-public-sota-generic-redact-/);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena SOTA verifier rejects raw result git SHA drift", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-gitsha-verify-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir, 5);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const manifestPath = path.join(dirs.outDir, "MANIFEST.memory-arena.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.git.dirty = false;
    manifest.git.dirtyEntryCount = 0;
    manifest.artifactHash = sha256String(stableStringify(manifestArtifactHashIdentity(manifest)));
    await writeJson(manifestPath, manifest);

    await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "memoryarena", "verify-memoryarena-sota-evidence.mjs"), dirs.outDir],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    manifest.results[0].gitSha = "fedcba9876543210fedcba9876543210fedcba98";
    manifest.artifactHash = sha256String(stableStringify(manifestArtifactHashIdentity(manifest)));
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join("scripts", "bench", "public-sota", "memoryarena", "verify-memoryarena-sota-evidence.mjs"), dirs.outDir],
        { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      ),
      (error: unknown) => {
        assert(error && typeof error === "object");
        const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
        assert.match(output, /raw result git SHA must match manifest commit/);
        return true;
      },
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("MemoryArena SOTA verifier rejects unsafe public task fields", async () => {
  const dirs = await createRunDirs("remnic-public-sota-memoryarena-safe-verify-");
  try {
    await writeValidDiagnostics(dirs.diagnosticsDir, 5);
    await writeFile(
      path.join(dirs.resultsDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmemory-arena\tstart\t${STARTED_AT}\nmemory-arena\tsuccess\t${FINISHED_AT}\n`,
      "utf8",
    );
    const resultPath = path.join(dirs.resultsDir, "memory-arena-result.json");
    await writeMemoryArenaResult(resultPath);
    await writeBaseManifest(dirs.resultsDir, "memory-arena", resultPath);

    await execFileAsync(
      process.execPath,
      [
        path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
        "--result", resultPath,
        "--results-dir", dirs.resultsDir,
        "--dataset-dir", dirs.datasetDir,
        "--repo-root", process.cwd(),
        "--out-dir", dirs.outDir,
      ],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );

    const manifestPath = path.join(dirs.outDir, "MANIFEST.memory-arena.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.git.dirty = false;
    manifest.git.dirtyEntryCount = 0;
    const artifactPath = path.join(dirs.outDir, manifest.publicArtifacts[0].path);
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    artifact.perTaskScores[0].question = "Leaked prompt text";
    await writeJson(artifactPath, artifact);
    const artifactBody = await readFile(artifactPath);
    manifest.publicArtifacts[0].sha256 = createHash("sha256").update(artifactBody).digest("hex");
    manifest.publicArtifacts[0].sizeBytes = artifactBody.byteLength;
    manifest.artifactHash = sha256String(stableStringify(manifestArtifactHashIdentity(manifest)));
    await writeJson(manifestPath, manifest);

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join("scripts", "bench", "public-sota", "memoryarena", "verify-memoryarena-sota-evidence.mjs"), dirs.outDir],
        { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
      ),
      (error: unknown) => {
        assert(error && typeof error === "object");
        const output = `${(error as { stdout?: string }).stdout ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`;
        assert.match(output, /artifact\.perTaskScores\[0\]\.question is not public-safe/);
        return true;
      },
    );
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test("generic SOTA verifier preserves MemoryAgentBench aggregate units from comparison metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-memoryagentbench-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        memoryagentbench: {
          targets: {
            overallScore: { score: 80 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "memoryagentbench",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "memoryagentbench-public-task",
            details: {
              source: "aggregate_fixture",
              officialProtocol: "aggregate",
            },
            scores: {
              official_protocol_ready: 1,
            },
          },
        ],
        aggregates: {
          overall_score: {
            mean: 87,
            units: "percent",
          },
        },
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "memoryagentbench",
      {
        schemaVersion: 1,
        benchmarkId: "memoryagentbench",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: {
          overall_score: 87,
        },
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: "aggregate",
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );

    await runGenericVerifiers(evidenceDir, "memoryagentbench");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic SOTA verifier preserves MemoryAgentBench fractional aggregate scaling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-memoryagentbench-fraction-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        memoryagentbench: {
          targets: {
            overallScore: { score: 40 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "memoryagentbench",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "memoryagentbench-fraction-task",
            details: {
              source: "aggregate_fixture",
              officialProtocol: "aggregate",
            },
            scores: {
              official_protocol_ready: 1,
            },
          },
        ],
        aggregates: {
          overall_score: {
            mean: 0.496,
          },
        },
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "memoryagentbench",
      {
        schemaVersion: 1,
        benchmarkId: "memoryagentbench",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: {
          overall_score: 0.496,
        },
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: "aggregate",
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );

    await runGenericVerifiers(evidenceDir, "memoryagentbench");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic SOTA verifier uses MemBench split aggregate metrics without per-task re-derivation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-membench-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        membench: {
          targets: {
            FirstAgentLowLevel: { score: 0.5 },
            ThirdAgentLowLevel: { score: 0.5 },
            FirstAgentHighLevel: { score: 0.5 },
            ThirdAgentHighLevel: { score: 0.5 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "membench",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "membench-factual-participant",
            details: { memoryType: "factual", scenario: "participant" },
            scores: { membench_accuracy: 0.1 },
          },
          {
            taskId: "membench-factual-observation",
            details: { memoryType: "factual", scenario: "observation" },
            scores: { membench_accuracy: 0.2 },
          },
          {
            taskId: "membench-reflective-participant",
            details: { memoryType: "reflective", scenario: "participant" },
            scores: { membench_accuracy: 0.3 },
          },
          {
            taskId: "membench-reflective-observation",
            details: { memoryType: "reflective", scenario: "observation" },
            scores: { membench_accuracy: 0.4 },
          },
        ],
        aggregates: {
          membench_accuracy_factual_participant: { mean: 0.91 },
          membench_accuracy_factual_observation: { mean: 0.92 },
          membench_accuracy_reflective_participant: { mean: 0.93 },
          membench_accuracy_reflective_observation: { mean: 0.94 },
        },
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "membench",
      {
        schemaVersion: 1,
        benchmarkId: "membench",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: Object.fromEntries(
          Object.entries(rawResult.results.aggregates).map(([metric, aggregate]) => [metric, aggregate.mean]),
        ),
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: `${task.details.memoryType}/${task.details.scenario}`,
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );

    await runGenericVerifiers(evidenceDir, "membench");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public SOTA comparison JSON serializer rejects non-finite numbers", () => {
  assert.equal(roundedJsonNumberReplacer("delta", 1.23456789), 1.234568);
  assert.throws(
    () => roundedJsonNumberReplacer("delta", Number.POSITIVE_INFINITY),
    /delta must be finite before JSON serialization/,
  );
  assert.throws(
    () => roundedJsonNumberReplacer("actual", Number.NaN),
    /actual must be finite before JSON serialization/,
  );
});

test("generic SOTA verifier mirrors BEAM incomplete llm_judge split fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-beam-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        beam: {
          targets: {
            "4k": { score: 0.2 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "beam",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "4k-1",
            details: { scale: "4k" },
            scores: {
              llm_judge: 1,
              rubric_coverage: 0.2,
            },
          },
          {
            taskId: "4k-2",
            details: { scale: "4k" },
            scores: {
              rubric_coverage: 0.4,
            },
          },
        ],
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "beam",
      {
        schemaVersion: 1,
        benchmarkId: "beam",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: {
          rubric_coverage: 0.3,
        },
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: "4k",
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );

    await runGenericVerifiers(evidenceDir, "beam");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic SOTA verifier rejects diagnostics that do not cover public tasks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-diagnostics-coverage-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        beam: {
          targets: {
            "4k": { score: 0.2 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "beam",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "4k-1",
            details: { scale: "4k" },
            scores: { rubric_coverage: 0.4 },
          },
          {
            taskId: "4k-2",
            details: { scale: "4k" },
            scores: { rubric_coverage: 0.5 },
          },
        ],
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "beam",
      {
        schemaVersion: 1,
        benchmarkId: "beam",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: {
          rubric_coverage: 0.45,
        },
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: "4k",
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );
    await writeJson(path.join(evidenceDir, "beam-diagnostics-summary.json"), {
      runId: RUN_ID,
      benchmark: "beam",
      checked: 1,
      complete: 1,
      inFlight: 0,
      afterCutoff: 0,
      invalidTimestamps: 0,
      errored: 0,
      nonzero: 0,
      providers: { "codex-cli": 1 },
      models: { "gpt-5.5": 1 },
      reasoningEfforts: { xhigh: 1 },
      serviceTiers: { fast: 1 },
    });

    await assertRejectsGenericVerifier(evidenceDir, "beam", /diagnostics checked count must cover published task count/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic SOTA verifier rejects raw/public artifact git SHA drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-gitsha-verify-"));
  try {
    const targetMap = {
      benchmarks: {
        beam: {
          targets: {
            "4k": { score: 0.2 },
          },
        },
      },
    };
    const rawResult = {
      meta: {
        benchmark: "beam",
        mode: "full",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      results: {
        tasks: [
          {
            taskId: "4k-1",
            details: { scale: "4k" },
            scores: {
              rubric_coverage: 0.4,
            },
          },
        ],
      },
    };
    const comparison = comparePublicBenchmarkSota(rawResult, targetMap);
    const evidenceDir = await writeGenericVerifierFixture(
      root,
      "beam",
      {
        schemaVersion: 1,
        benchmarkId: "beam",
        datasetVersion: `sha256:${"c".repeat(64)}`,
        system: {
          name: "remnic",
          version: "test",
          gitSha: rawResult.meta.gitSha,
        },
        model: "gpt-5.5",
        seed: 1,
        metrics: {
          rubric_coverage: 0.4,
        },
        perTaskScores: rawResult.results.tasks.map((task) => ({
          taskId: task.taskId,
          category: "4k",
          scores: task.scores,
          details: task.details,
        })),
        startedAt: STARTED_AT,
        finishedAt: FINISHED_AT,
        durationMs: 60_000,
        env: {
          node: process.version,
          os: process.platform,
          arch: process.arch,
        },
        note: "Fixture public artifact.",
        sotaComparison: comparison,
      },
      comparison,
      targetMap,
    );

    const manifestPath = path.join(evidenceDir, "MANIFEST.beam.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.results[0].gitSha = "fedcba9876543210fedcba9876543210fedcba98";
    manifest.artifactHash = sha256String(stableStringify(manifestArtifactHashIdentity(manifest)));
    await writeJson(manifestPath, manifest);

    await assertRejectsGenericVerifier(evidenceDir, "beam", /raw result git SHA must match manifest commit/);

    manifest.results[0].gitSha = rawResult.meta.gitSha;
    manifest.publicArtifacts[0].gitSha = "fedcba9876543210fedcba9876543210fedcba98";
    manifest.artifactHash = sha256String(stableStringify(manifestArtifactHashIdentity(manifest)));
    await writeJson(manifestPath, manifest);

    await assertRejectsGenericVerifier(evidenceDir, "beam", /public artifact git SHA must match manifest commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public SOTA publish helpers resume clean committed branches without a PR", async () => {
  const generic = await readFile(
    path.join("scripts", "bench", "public-sota", "publish-public-benchmark-evidence-pr.sh"),
    "utf8",
  );
  const memoryArena = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "publish-memoryarena-evidence-pr.sh"),
    "utf8",
  );

  for (const [label, source] of [
    ["generic", generic],
    ["memoryarena", memoryArena],
  ] as const) {
    assert.match(source, /gh pr list --repo "\$\{REPO\}" --head "\$\{BRANCH\}" --base "\$\{BASE_BRANCH\}" --state open/);
    assert.doesNotMatch(source, /gh pr list[^\n]+--state all/);
    assert.match(source, /resuming: .*evidence commit exists on clean .*\$\{BRANCH\}; pushing and creating PR/);
    assert.match(source, /pr_head_matches_worktree\(\)/);
    assert.match(source, /gh pr view "\$\{pr_number\}" --repo "\$\{REPO\}" --json headRefOid --jq '\.headRefOid'/);
    assert.match(source, /evidence commit on clean \$\{BRANCH\} is newer than PR #\$\{existing_pr\}/);
    assert.match(source, /publish_or_update_pr\(\)/);
    assert.doesNotMatch(
      source,
      new RegExp(`if \\[\\[ -z "\\$\\{existing_pr\\}" \\]\\]; then\\n\\s*echo "waiting: no staged or unstaged ${label === "generic" ? "\\$\\{benchmark\\}" : "MemoryArena"} evidence changes[^\\n]+and no PR exists`),
    );
  }
});

test("public benchmark publish watcher does not baseline completed successes", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "watch-public-benchmark-publish.sh"),
    "utf8",
  );

  assert.match(source, /status_file="\$\{RESULTS_ROOT\}\/\$\{run_id\}\/status\.tsv"/);
  assert.match(source, /awk -F '\\t' -v benchmark="\$\{BENCHMARK\}" '\$1 == benchmark && \$2 == "success"/);
  assert.match(source, /return 1[\s\S]*return 0/);
});

test("public SOTA completion audit aligns MemoryAgentBench target freshness with comparison metrics", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "audit-public-sota-completion.mjs"),
    "utf8",
  );

  assert.match(source, /process\.env\.TARGET_MAP \?\? path\.join\(os\.tmpdir\(\), 'remnic-public-sota-audit-target-map\.json'\)/);
  assert.doesNotMatch(source, /process\.env\.TARGET_MAP \?\? path\.join\(scriptDir, 'current-target-map\.json'\)/);
  assert.match(source, /function expectedComparisonTargets\(benchmark, checks = \[\]\)/);
  assert.match(source, /const comparisonMetrics = new Set\(checks\.map\(\(check\) => check\.metric\)\)/);
  assert.match(source, /comparisonMetrics\.has\('memoryagentbench_overall_score'\)/);
  assert.match(source, /comparisonMetrics\.has\('memoryagentbench_table3_overall_score'\)/);
  assert.match(source, /expectedComparisonTargets\(item\.benchmark, comparison\.checks \?\? \[\]\)/);
  assert.match(source, /\+refs\/heads\/\$\{branch\}:refs\/remotes\/origin\/\$\{branch\}/);
  assert.match(source, /function ensureAuditWorktree\(\)[\s\S]*fetchBranchRef\(\);[\s\S]*checkout', '--detach', branchRef/);
  assert.doesNotMatch(source, /'fetch', 'origin', 'bench\/public-matrix-codex'/);
});

test("public SOTA completion audit skips closed publication PRs", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "audit-public-sota-completion.mjs"),
    "utf8",
  );

  assert.match(source, /branchPrefix: 'codex\/publish-memoryarena-sota-'/);
  assert.match(source, /branchPrefix: `codex\/publish-\$\{benchmark\}-sota-`/);
  assert.match(source, /--limit', '100'/);
  assert.match(source, /row\.headRefName\.startsWith\(item\.branchPrefix\)/);
  assert.match(source, /return row\.headRefName === item\.branch/);
  assert.match(source, /--state', 'all'/);
  assert.match(source, /if \(row\.state !== 'OPEN' && row\.state !== 'MERGED'\)/);
  assert.match(source, /activeRows\.sort\(\(a, b\) => Number\(b\.number\) - Number\(a\.number\)\)/);
  assert.match(source, /return activeRows\[0\]/);
  assert.doesNotMatch(source, /rows\.sort\(\(a, b\) => Number\(b\.number\) - Number\(a\.number\)\);\n\s*return rows\[0\]/);
});

test("chained public benchmark watcher retries active-session launch collisions", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "watch-next-after-benchmark.sh"),
    "utf8",
  );

  assert.match(source, /PREVIOUS_BRANCH="\$\{PREVIOUS_BRANCH:-\}"/);
  assert.match(source, /PREVIOUS_BRANCH_PREFIX="\$\{PREVIOUS_BRANCH_PREFIX:-codex\/publish-\$\{PREVIOUS\}-sota-\}"/);
  assert.match(source, /--limit 100/);
  assert.match(source, /headRefName \| startswith/);
  assert.match(source, /branch_label="\$\{PREVIOUS_BRANCH_PREFIX\}\*"/);
  assert.match(source, /--state all/);
  assert.match(source, /select\(\.state == "OPEN" or \.state == "MERGED"\)/);
  assert.match(source, /if \[\[ "\$\{launch_status\}" -eq 3 \]\]; then/);
  assert.match(source, /waiting: active public benchmark scoring session blocked \$\{NEXT\} launch; retrying/);
  assert.match(source, /sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue[\s\S]*if \[\[ "\$\{launch_status\}" -ne 0 \]\]; then/);
});

test("MemoryArena transition helper retries active-session launch collisions", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "launch-next-after-memoryarena.sh"),
    "utf8",
  );

  assert.match(source, /RUN_ID="\$\{RUN_ID:-\$\{ACTIVE_SESSION\}\}"/);
  assert.match(source, /RUN_BRANCH_SUFFIX="\$\(printf '%s' "\$\{RUN_ID\}" \| sed -E/);
  assert.match(source, /MEMORYARENA_BRANCH="\$\{MEMORYARENA_BRANCH:-codex\/publish-memoryarena-sota-\$\{RUN_BRANCH_SUFFIX\}\}"/);
  assert.doesNotMatch(source, /MEMORYARENA_BRANCH="\$\{MEMORYARENA_BRANCH:-codex\/publish-memoryarena-sota-bf9b264\}"/);
  assert.match(source, /--state all/);
  assert.match(source, /select\(\.state == "OPEN" or \.state == "MERGED"\)/);
  assert.match(source, /launch_status=\$\?/);
  assert.match(source, /if \[\[ "\$\{launch_status\}" -eq 3 \]\]; then/);
  assert.match(source, /waiting: active public benchmark scoring session blocked \$\{BENCHMARK\} launch; retrying/);
  assert.match(source, /exit 0[\s\S]*if \[\[ "\$\{launch_status\}" -ne 0 \]\]; then/);
});

test("next public benchmark launcher falls back to a base-branch worktree with datasets", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "launch-next-public-benchmark.sh"),
    "utf8",
  );

  assert.match(source, /EXPLICIT_LAUNCH_REPO_ROOT="\$\{LAUNCH_REPO_ROOT:-\}"/);
  assert.match(source, /BASE_BRANCH="\$\{BASE_BRANCH:-bench\/public-matrix-codex\}"/);
  assert.match(source, /resolve_launch_repo_root\(\)/);
  assert.match(source, /if \[\[ -n "\$\{EXPLICIT_LAUNCH_REPO_ROOT\}" \]\]; then[\s\S]*printf '%s\\n' "\$\{EXPLICIT_LAUNCH_REPO_ROOT\}"/);
  assert.match(source, /if \[\[ -d "\$\{REPO_ROOT\}\/evals\/datasets\/\$\{benchmark\}" \]\]; then[\s\S]*printf '%s\\n' "\$\{REPO_ROOT\}"/);
  assert.match(source, /git -C "\$\{REPO_ROOT\}" worktree list --porcelain/);
  assert.match(source, /"\$\{branch\}" == "refs\/heads\/\$\{BASE_BRANCH\}"/);
  assert.match(source, /-d "\$\{worktree\}\/evals\/datasets\/\$\{benchmark\}"/);
  assert.match(source, /LAUNCH_REPO_ROOT="\$\(resolve_launch_repo_root\)"/);
  assert.doesNotMatch(source, /LAUNCH_REPO_ROOT="\$\{LAUNCH_REPO_ROOT:-\$\{REPO_ROOT\}\}"/);
});

test("MemoryArena publish watcher ignores derived evidence JSON files", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "watch-and-publish-memoryarena.sh"),
    "utf8",
  );
  const publish = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "publish-memoryarena-evidence-pr.sh"),
    "utf8",
  );

  assert.match(source, /-name 'memory-arena-\*\.json'/);
  assert.match(source, /! -name 'memory-arena-sota-comparison\.json'/);
  assert.match(source, /! -name 'memory-arena-diagnostics-summary\.json'/);
  assert.match(source, /RUN_ID="\$\(basename "\$\{RESULTS_DIR%\/\}"\)"/);
  assert.match(source, /RUN_ID="\$\{RUN_ID\}" RESULTS_DIR="\$\{RESULTS_DIR\}" SESSION="\$\{SESSION\}" OUT_ROOT="\$\{EVIDENCE_ROOT\}" bash "\$\{SCRIPT_DIR\}\/complete-memoryarena-if-ready\.sh"/);
  assert.match(source, /stage_output="\$\(RUN_ID="\$\{RUN_ID\}" EVIDENCE_ROOT="\$\{EVIDENCE_ROOT\}" bash "\$\{SCRIPT_DIR\}\/stage-memoryarena-evidence-pr\.sh" 2>&1\)"/);
  assert.match(source, /publish_output="\$\(RUN_ID="\$\{RUN_ID\}" bash "\$\{SCRIPT_DIR\}\/publish-memoryarena-evidence-pr\.sh" 2>&1\)"/);
  assert.match(publish, /RUN_ID="\$\{RUN_ID:-public-matrix-codex-bf9b2643-20260515T052919Z\}"/);
  assert.match(publish, /RUN_BRANCH_SUFFIX="\$\(printf '%s' "\$\{RUN_ID\}" \| sed -E/);
  assert.match(publish, /BRANCH="\$\{BRANCH:-codex\/publish-memoryarena-sota-\$\{RUN_BRANCH_SUFFIX\}\}"/);
  assert.doesNotMatch(publish, /BRANCH="\$\{BRANCH:-codex\/publish-memoryarena-sota-bf9b264\}"/);
  assert.match(source, /if ! grep -q '\^ready: MemoryArena evidence PR worktree staged ' <<< "\$\{stage_output\}"; then[\s\S]*sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue/);
  assert.match(source, /if ! grep -q '\^ready: verified ' <<< "\$\{complete_output\}"; then[\s\S]*sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue/);
  assert.match(source, /if grep -q '\^done:' <<< "\$\{stage_output\}"; then[\s\S]*exit 0[\s\S]*fi/);
  assert.match(source, /if \[\[ "\$\{complete_status\}" -eq 4 \]\]; then[\s\S]*stopping: MemoryArena completion helper exited \$\{complete_status\}[\s\S]*exit "\$\{complete_status\}"/);
  assert.match(source, /waiting: MemoryArena completion helper exited \$\{complete_status\}; will retry[\s\S]*sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue/);
});

test("public SOTA status maps MemoryArena publish watcher sessions with run suffixes", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "status-public-sota-pipeline.mjs"),
    "utf8",
  );

  assert.match(source, /function publishWatcherSessionFor\(benchmark\)/);
  assert.match(source, /session === 'remnic-memoryarena-publish-watcher'/);
  assert.match(source, /session\.startsWith\('remnic-memoryarena-publish-watcher-'\)/);
  assert.match(source, /publishWatcher: publishWatcherSessionFor\(benchmark\)/);
  assert.doesNotMatch(source, /publishWatcher: watcherSessions\.find\(\(session\) => session === `remnic-\$\{benchmark\}-publish-watcher`\)/);
});

test("public SOTA status exposes active run and MemoryArena session states", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "status-public-sota-pipeline.mjs"),
    "utf8",
  );

  assert.match(source, /const legacyMemoryArenaRunId = 'public-matrix-codex-bf9b2643-20260515T052919Z'/);
  assert.match(source, /function latestRunIdForBenchmark\(benchmark, activeRunId, activeRunStatus\)/);
  assert.match(source, /activeRunStatus\?\.benchmark === benchmark && activeRunId/);
  assert.match(source, /latestDirForBenchmark\(benchmark\) \?\? legacyMemoryArenaRunId/);
  assert.match(source, /const memoryArenaRunId = latestRunIdForBenchmark\('memory-arena', activeRunId, activeRunStatus\)/);
  assert.match(source, /execFileSync\('node', \[activeRunChecker, path\.join\(resultsRoot, memoryArenaRunId\)\]/);
  assert.match(source, /const runId = latestRunIdForBenchmark\(benchmark, activeRunId, activeRunStatus\)/);
  assert.doesNotMatch(source, /const runId = benchmark === 'memory-arena'[\s\S]*'public-matrix-codex-bf9b2643-20260515T052919Z'/);
  assert.match(source, /benchmarkSession: activeRunStatus\.benchmarkSession/);
  assert.match(source, /monitorSession: activeRunStatus\.monitorSession/);
  assert.match(source, /monitorSessionName: activeRunStatus\.monitorSessionName/);
  assert.match(source, /finished: activeRunStatus\.diagnostics\?\.finished/);
  assert.match(source, /transientRetryFailures: activeRunStatus\.diagnostics\?\.transientRetryFailures/);
  assert.match(source, /benchmarkSession: memoryArenaStatus\.benchmarkSession/);
  assert.match(source, /monitorSession: memoryArenaStatus\.monitorSession/);
  assert.match(source, /monitorSessionName: memoryArenaStatus\.monitorSessionName/);
  assert.match(source, /finished: memoryArenaStatus\.diagnostics\?\.finished/);
  assert.match(source, /transientRetryFailures: memoryArenaStatus\.diagnostics\?\.transientRetryFailures/);
});

test("public SOTA health check accepts run-suffixed MemoryArena watcher sessions", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "assert-public-sota-pipeline-healthy.mjs"),
    "utf8",
  );

  assert.match(source, /publishPrefix: 'remnic-memoryarena-publish-watcher-'/);
  assert.match(source, /transitionPrefix: 'remnic-next-after-memoryarena-watcher-'/);
  assert.match(source, /entry\.publishPrefix, entry\.transitionPrefix/);
  assert.match(source, /session\.endsWith\('-'\)/);
  assert.match(source, /watcherSession\.startsWith\(session\)/);
  assert.doesNotMatch(source, /publish: 'remnic-memoryarena-publish-watcher-bf9b2643'/);
});

test("generic public benchmark publish watcher keeps completion and staging evidence roots aligned", async () => {
  const source = await readFile(
    path.join("scripts", "bench", "public-sota", "watch-public-benchmark-publish.sh"),
    "utf8",
  );
  const publish = await readFile(
    path.join("scripts", "bench", "public-sota", "publish-public-benchmark-evidence-pr.sh"),
    "utf8",
  );

  assert.match(source, /OUT_ROOT="\$\{EVIDENCE_ROOT\}" bash "\$\{SCRIPT_DIR\}\/complete-public-benchmark-if-ready\.sh"/);
  assert.match(source, /EVIDENCE_ROOT="\$\{EVIDENCE_ROOT\}" bash "\$\{SCRIPT_DIR\}\/stage-public-benchmark-evidence-pr\.sh"/);
  assert.match(source, /publish-public-benchmark-evidence-pr\.sh" "\$\{BENCHMARK\}" "\$\{run_id\}"/);
  assert.match(publish, /run_id="\$\{2:-\}"/);
  assert.match(publish, /RUN_BRANCH_SUFFIX="\$\(printf '%s' "\$\{run_id\}" \| sed -E/);
  assert.match(publish, /BRANCH="\$\{BRANCH:-codex\/publish-\$\{benchmark\}-sota-\$\{RUN_BRANCH_SUFFIX\}\}"/);
  assert.doesNotMatch(publish, /BRANCH="\$\{BRANCH:-codex\/publish-\$\{benchmark\}-sota-bf9b264\}"/);
  assert.match(source, /if \[\[ "\$\{complete_status\}" -eq 4 \]\]; then[\s\S]*stopping: \$\{BENCHMARK\} completion helper exited \$\{complete_status\}[\s\S]*exit "\$\{complete_status\}"/);
  assert.match(source, /waiting: \$\{BENCHMARK\} completion helper exited \$\{complete_status\}; will retry[\s\S]*sleep "\$\{INTERVAL_SECONDS\}"[\s\S]*continue/);
  assert.match(source, /if grep -q '\^done:' <<< "\$\{stage_output\}"; then[\s\S]*exit 0[\s\S]*fi/);
});

test("public SOTA staging helpers start from base and prune stale evidence", async () => {
  const generic = await readFile(
    path.join("scripts", "bench", "public-sota", "stage-public-benchmark-evidence-pr.sh"),
    "utf8",
  );
  const memoryArena = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "stage-memoryarena-evidence-pr.sh"),
    "utf8",
  );

  for (const source of [generic, memoryArena]) {
    assert.match(source, /worktree add -B "\$\{BRANCH\}" "\$\{WORKTREE\}" "origin\/\$\{BASE_BRANCH\}"/);
    assert.match(source, /reset --hard "origin\/\$\{BASE_BRANCH\}"/);
    assert.match(source, /git -C "\$\{WORKTREE\}" clean -fd/);
    assert.match(source, /find docs\/benchmarks\/results[\s\S]*-exec rm -rf \{\} \+/);
    assert.match(source, /rm -f "\$\{EVIDENCE_DOC_REL\}" "\$\{VERIFY_SCRIPT_REL\}"/);
    assert.match(source, /cp "\$\{INTEGRITY_MODULE\}" "\$\{WORKTREE\}\/\$\{INTEGRITY_MODULE_REL\}"/);
    assert.match(source, /cp "\$\{EVIDENCE_RUN_UTILS_MODULE\}" "\$\{WORKTREE\}\/\$\{EVIDENCE_RUN_UTILS_MODULE_REL\}"/);
    assert.match(source, /staged_status="\$\(git -C "\$\{WORKTREE\}" status --porcelain --untracked-files=all\)"/);
    assert.match(source, /if \[\[ -z "\$\{staged_status\}" \]\]; then[\s\S]*done: .* no PR staging changes[\s\S]*exit 0/);
    assert.match(source, /printf '%s\\n' "\$\{staged_status\}"/);
  }
  assert.match(generic, /cp "\$\{VERIFY_CORE_SCRIPT\}" "\$\{WORKTREE\}\/\$\{VERIFY_CORE_SCRIPT_REL\}"/);
  assert.match(generic, /cp "\$\{COMPARE_MODULE\}" "\$\{WORKTREE\}\/\$\{COMPARE_MODULE_REL\}"/);
  assert.match(generic, /cp "\$\{COMPARISON_JSON_MODULE\}" "\$\{WORKTREE\}\/\$\{COMPARISON_JSON_MODULE_REL\}"/);
  assert.doesNotMatch(generic, /rm -rf "\$\{MEMORYARENA_MODULE_DIR_REL\}"/);
  assert.match(generic, /cp "\$\{MEMORYARENA_COMPARE_MODULE\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/compare-memoryarena-sota\.mjs"/);
  assert.match(generic, /cp "\$\{MEMORYARENA_DERIVE_MODULE\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/derive-memoryarena-official-metrics\.mjs"/);
  assert.match(generic, /cp "\$\{MEMORYARENA_VERIFY_MODULE\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/verify-memoryarena-sota-evidence\.mjs"/);
  assert.match(generic, /RUN_BRANCH_SUFFIX="\$\(printf '%s' "\$\{run_id\}" \| sed -E/);
  assert.match(generic, /BRANCH="\$\{BRANCH:-codex\/publish-\$\{benchmark\}-sota-\$\{RUN_BRANCH_SUFFIX\}\}"/);
  assert.doesNotMatch(generic, /BRANCH="\$\{BRANCH:-codex\/publish-\$\{benchmark\}-sota-bf9b264\}"/);
  assert.match(memoryArena, /rm -rf "\$\{MEMORYARENA_MODULE_DIR_REL\}"/);
  assert.match(memoryArena, /cp "\$\{VERIFY_CORE_SCRIPT\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/verify-memoryarena-sota-evidence\.mjs"/);
  assert.match(memoryArena, /cp "\$\{COMPARE_MODULE\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/compare-memoryarena-sota\.mjs"/);
  assert.match(memoryArena, /cp "\$\{DERIVE_MODULE\}" "\$\{WORKTREE\}\/\$\{MEMORYARENA_MODULE_DIR_REL\}\/derive-memoryarena-official-metrics\.mjs"/);
  assert.match(memoryArena, /cp "\$\{COMPARISON_JSON_MODULE\}" "\$\{WORKTREE\}\/\$\{COMPARISON_JSON_MODULE_REL\}"/);
  assert.match(memoryArena, /EVIDENCE_ROOT="\$\{EVIDENCE_ROOT:-\$\{TMP_ROOT\}\/remnic-memoryarena-evidence\}"/);
  assert.match(memoryArena, /SOURCE_EVIDENCE_DIR="\$\{SOURCE_EVIDENCE_DIR:-\$\{EVIDENCE_ROOT\}\/\$\{RUN_ID\}\}"/);
  assert.match(memoryArena, /RUN_BRANCH_SUFFIX="\$\(printf '%s' "\$\{RUN_ID\}" \| sed -E/);
  assert.match(memoryArena, /BRANCH="\$\{BRANCH:-codex\/publish-memoryarena-sota-\$\{RUN_BRANCH_SUFFIX\}\}"/);
  assert.doesNotMatch(memoryArena, /BRANCH="\$\{BRANCH:-codex\/publish-memoryarena-sota-bf9b264\}"/);
});

test("published SOTA verifier templates delegate to copied core verifier modules", async () => {
  const genericTemplate = await readFile(
    path.join("scripts", "bench", "public-sota", "verify-public-generic-sota-evidence.template.mjs"),
    "utf8",
  );
  const memoryArenaTemplate = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "verify-public-memoryarena-sota-evidence.template.mjs"),
    "utf8",
  );
  const memoryArenaComparator = await readFile(
    path.join("scripts", "bench", "public-sota", "memoryarena", "compare-memoryarena-sota.mjs"),
    "utf8",
  );

  assert.match(genericTemplate, /verify-public-benchmark-sota-evidence\.mjs/);
  assert.match(genericTemplate, /spawnSync/);
  assert.doesNotMatch(genericTemplate, /function comparePublicBenchmarkSota/);
  assert.match(memoryArenaTemplate, /verify-memoryarena-sota-evidence\.mjs/);
  assert.match(memoryArenaTemplate, /spawnSync/);
  assert.doesNotMatch(memoryArenaTemplate, /function compareMemoryArenaSota/);
  assert.doesNotMatch(memoryArenaTemplate, /function deriveMemoryArenaOfficialMetrics/);
  assert.match(memoryArenaComparator, /import \{ roundedJsonNumberReplacer \} from '\.\.\/comparison-json\.mjs'/);
  assert.doesNotMatch(memoryArenaComparator, /function roundedJsonNumberReplacer/);
  assert.match(memoryArenaComparator, /const publishableChecks = checks\.filter\(\(check\) => check\.publishAsSota !== false\)/);
  assert.match(memoryArenaComparator, /sota: delta > 1e-9/);
  assert.doesNotMatch(memoryArenaComparator, /zeroTargetTie/);
});

test("active public run diagnostics picks latest finished record from full scan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-active-run-"));
  try {
    const runDir = path.join(root, "public-membench-codex-20260516T000000Z");
    const diagnosticsDir = path.join(runDir, "codex-cli-diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(
      path.join(runDir, "status.tsv"),
      `benchmark\tstatus\ttimestamp\nmembench\tstart\t${STARTED_AT}\n`,
      "utf8",
    );
    await writeJson(path.join(diagnosticsDir, "finished.json"), {
      runId: path.basename(runDir),
      startedAt: "2026-05-16T00:00:10.000Z",
      finishedAt: "2026-05-16T00:01:00.000Z",
      durationMs: 50_000,
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });
    await utimes(
      path.join(diagnosticsDir, "finished.json"),
      new Date("2026-05-16T00:01:00.000Z"),
      new Date("2026-05-16T00:01:00.000Z"),
    );
    for (let index = 0; index < 31; index += 1) {
      const file = path.join(diagnosticsDir, `in-flight-${String(index).padStart(2, "0")}.json`);
      await writeJson(file, {
        runId: path.basename(runDir),
        startedAt: "2026-05-16T00:02:00.000Z",
        provider: "codex-cli",
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      });
      await utimes(
        file,
        new Date(`2026-05-16T00:02:${String(index).padStart(2, "0")}.000Z`),
        new Date(`2026-05-16T00:02:${String(index).padStart(2, "0")}.000Z`),
      );
    }

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.diagnostics.sampleSize, 30);
    assert.equal(status.diagnostics.latestFinished[0].name, "finished.json");
    assert.equal(status.diagnostics.latestFinished[0].finishedAt, "2026-05-16T00:01:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active public run diagnostics ignore records before latest lifecycle start", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-active-run-restart-"));
  try {
    const runDir = path.join(root, "public-memory-arena-codex-20260517T000000Z");
    const diagnosticsDir = path.join(runDir, "codex-cli-diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(
      path.join(runDir, "status.tsv"),
      [
        "benchmark\tstatus\ttimestamp",
        "memory-arena\tstart\t2026-05-17T00:00:00Z",
        "memory-arena\trestart-after-reboot\t2026-05-17T02:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeJson(path.join(diagnosticsDir, "pre-restart-failed.json"), {
      runId: path.basename(runDir),
      startedAt: "2026-05-17T01:59:00.000Z",
      finishedAt: "2026-05-17T01:59:30.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      error: "Codex CLI completion failed (signal SIGTERM)",
    });
    await writeJson(path.join(diagnosticsDir, "post-restart-ok.json"), {
      runId: path.basename(runDir),
      startedAt: "2026-05-17T02:00:10.000Z",
      finishedAt: "2026-05-17T02:00:20.000Z",
      durationMs: 10_000,
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      result: { status: 0 },
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.diagnostics.countsMode, "diagnostics-since-lifecycle-start");
    assert.equal(status.diagnostics.lifecycleStart.status, "restart-after-reboot");
    assert.equal(status.diagnostics.lifecycleStart.timestamp, "2026-05-17T02:00:00Z");
    assert.equal(status.diagnostics.allDiagnostics, 2);
    assert.equal(status.diagnostics.beforeLifecycleStart, 1);
    assert.equal(status.diagnostics.total, 1);
    assert.equal(status.diagnostics.errors, 0);
    assert.equal(status.diagnostics.nonzero, 0);
    assert.equal(status.diagnostics.latestFinished[0].name, "post-restart-ok.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active public run diagnostics ignore transient retry failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-active-run-retry-"));
  try {
    const runDir = path.join(root, "public-memory-arena-codex-20260517T000000Z");
    const diagnosticsDir = path.join(runDir, "codex-cli-diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(
      path.join(runDir, "status.tsv"),
      [
        "benchmark\tstatus\ttimestamp",
        "memory-arena\tstart\t2026-05-17T00:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeJson(path.join(diagnosticsDir, "retry-sigterm.json"), {
      runId: path.basename(runDir),
      startedAt: "2026-05-17T00:00:10.000Z",
      finishedAt: "2026-05-17T00:00:20.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      retry: { attempt: 1, maxAttempts: 3, transientFailure: true },
      result: { status: null, signal: "SIGTERM" },
      error: "Codex CLI completion failed (signal SIGTERM)",
    });
    await writeJson(path.join(diagnosticsDir, "retry-success.json"), {
      runId: path.basename(runDir),
      startedAt: "2026-05-17T00:00:21.000Z",
      finishedAt: "2026-05-17T00:00:30.000Z",
      durationMs: 9_000,
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
      retry: { attempt: 2, maxAttempts: 3 },
      result: { status: 0 },
    });

    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.diagnostics.total, 2);
    assert.equal(status.diagnostics.finished, 1);
    assert.equal(status.diagnostics.transientRetryFailures, 1);
    assert.equal(status.diagnostics.errors, 0);
    assert.equal(status.diagnostics.nonzero, 0);
    assert.equal(status.diagnostics.sampleErrors, 0);
    assert.equal(status.diagnostics.sampleNonzero, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active public run progress ignores pre-restart checkpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-public-sota-active-run-restart-progress-"));
  try {
    const runDir = path.join(root, "public-memory-arena-codex-20260517T000000Z");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, "status.tsv"),
      [
        "benchmark\tstatus\ttimestamp",
        "memory-arena\tstart\t2026-05-17T00:00:00Z",
        "memory-arena\trestart-after-reboot\t2026-05-17T02:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );
    const activeRunEnv = {
      ...process.env,
      CHECK_ACTIVE_PUBLIC_RUN_NOW: "2026-05-17T04:00:00.000Z",
    };
    const monitorPath = path.join(runDir, "monitor-30m.log");
    await writeFile(monitorPath, "status monitor\n", "utf8");
    await utimes(
      monitorPath,
      new Date("2026-05-17T03:50:00.000Z"),
      new Date("2026-05-17T03:50:00.000Z"),
    );
    const diagnosticsDir = path.join(runDir, "codex-cli-diagnostics");
    await mkdir(diagnosticsDir, { recursive: true });
    await writeJson(path.join(diagnosticsDir, "in-flight.json"), {
      startedAt: "2026-05-17T03:55:00.000Z",
      provider: "codex-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    });
    await writeFile(
      path.join(runDir, "run.log"),
      [
        "  [memory-arena] 1850/4209 tasks (142365s elapsed, ~181535s remaining)",
        "=== restart-after-reboot 2026-05-17T02:00:00Z ===",
        "",
      ].join("\n"),
      "utf8",
    );

    const beforeCheckpoint = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), env: activeRunEnv, maxBuffer: 1024 * 1024 },
    );
    const beforeStatus = JSON.parse(beforeCheckpoint.stdout);
    assert.equal(beforeStatus.progress, null);
    assert.equal(beforeStatus.checkedAt, "2026-05-17T04:00:00.000Z");
    assert.equal(beforeStatus.monitor.ageSeconds, 600);
    assert.equal(beforeStatus.diagnostics.inFlightRecords[0].ageSeconds, 300);
    assert.equal(beforeStatus.progressSource.mode, "run-log-lines-since-lifecycle-start");
    assert.equal(beforeStatus.progressSource.markerFound, true);
    assert.equal(beforeStatus.progressSource.scannedLines, 0);

    await writeFile(
      path.join(runDir, "run.log"),
      [
        "  [memory-arena] 1850/4209 tasks (142365s elapsed, ~181535s remaining)",
        "=== restart-after-reboot 2026-05-17T02:00:00Z ===",
        "  [memory-arena] 50/4209 tasks (2400s elapsed, ~199632s remaining)",
        "",
      ].join("\n"),
      "utf8",
    );

    const afterCheckpoint = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), env: activeRunEnv, maxBuffer: 1024 * 1024 },
    );
    const afterStatus = JSON.parse(afterCheckpoint.stdout);
    assert.equal(afterStatus.progress.completed, 50);
    assert.equal(afterStatus.progress.total, 4209);
    assert.equal(afterStatus.progress.remaining, 4159);
    assert.equal(afterStatus.progress.checkpointAt, "2026-05-17T02:40:00.000Z");
    assert.equal(afterStatus.progress.checkpointAgeSeconds, 4800);
    assert.equal(afterStatus.progress.remainingSecondsAtCheckpoint, 199632);
    assert.equal(afterStatus.progress.remainingSeconds, 194832);
    assert.equal(afterStatus.progress.estimatedFinishAt, "2026-05-19T10:07:12.000Z");
    assert.equal(afterStatus.progressSource.scannedLines, 1);
    assert.doesNotMatch(afterStatus.progress.line, /1850\/4209/);

    await writeFile(
      path.join(runDir, "run.log"),
      [
        "  [memory-arena] 1850/4209 tasks (142365s elapsed, ~181535s remaining)",
        "=== restart-after-reboot 2026-05-17T02:00:00Z ===",
        ...Array.from({ length: 5001 }, (_, index) => `post-restart detail ${index}`),
        "  [memory-arena] 100/4209 tasks (4800s elapsed, ~197232s remaining)",
        "",
      ].join("\n"),
      "utf8",
    );

    const longLogCheckpoint = await execFileAsync(
      process.execPath,
      [path.join("scripts", "bench", "public-sota", "check-active-public-run.mjs"), runDir],
      { cwd: process.cwd(), env: activeRunEnv, maxBuffer: 1024 * 1024 },
    );
    const longLogStatus = JSON.parse(longLogCheckpoint.stdout);
    assert.equal(longLogStatus.progress.completed, 100);
    assert.equal(longLogStatus.progress.total, 4209);
    assert.equal(longLogStatus.progress.checkpointAt, "2026-05-17T03:20:00.000Z");
    assert.equal(longLogStatus.progress.checkpointAgeSeconds, 2400);
    assert.equal(longLogStatus.progress.remainingSecondsAtCheckpoint, 197232);
    assert.equal(longLogStatus.progress.remainingSeconds, 194832);
    assert.equal(longLogStatus.progress.estimatedFinishAt, "2026-05-19T10:07:12.000Z");
    assert.equal(longLogStatus.progressSource.markerFound, true);
    assert.equal(longLogStatus.progressSource.scannedLines, 5002);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public SOTA evidence scripts share manifest hash identity helpers", async () => {
  const files = [
    path.join("scripts", "bench", "public-sota", "package-public-benchmark-evidence.mjs"),
    path.join("scripts", "bench", "public-sota", "memoryarena", "package-memoryarena-evidence.mjs"),
    path.join("scripts", "bench", "public-sota", "verify-public-benchmark-sota-evidence.mjs"),
    path.join("scripts", "bench", "public-sota", "memoryarena", "verify-memoryarena-sota-evidence.mjs"),
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.match(source, /evidence-integrity\.mjs/);
    assert.doesNotMatch(source, /function (artifactHashIdentity|buildArtifactHashIdentity|manifestArtifactHashIdentity)\(/);
  }
});

function memoryArenaTask(
  domain: string,
  taskId: number,
  extraScores: Record<string, number> = {},
): unknown {
  return {
    taskId: `${domain}-${taskId}-0`,
    details: {
      domain,
      taskId,
      subtaskIndex: 0,
      category: "fixture",
    },
    scores: {
      process_score: 1,
      task_success_rate: 1,
      ...extraScores,
    },
  };
}
