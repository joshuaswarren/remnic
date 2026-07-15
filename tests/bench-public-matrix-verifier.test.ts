import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import type { BenchmarkResult, ProviderConfig } from "@remnic/bench";

interface VerifyPublicMatrixEvidenceOptions {
  resultsDir: string;
  benchmarks?: readonly string[];
  diagnosticsDir?: string;
  manifestPath?: string;
  requireManifest?: boolean;
  requireDiagnostics?: boolean;
  requireCodexCreditReceipt?: boolean;
  allowBoundedTrial?: boolean;
  requireInternalProvider?: boolean;
  expectedModel?: string;
  expectedSystemModel?: string;
  expectedJudgeModel?: string;
  expectedInternalModel?: string;
  expectedReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  expectedSystemReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  expectedJudgeReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  expectedInternalReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  expectedServiceTier?: string;
  expectedGitSha?: string;
  skipGitSha?: boolean;
}

interface PublicMatrixEvidenceReport {
  ok: boolean;
  issues: Array<{ code: string; message: string }>;
}

type VerifyPublicMatrixEvidence = (
  options: VerifyPublicMatrixEvidenceOptions,
) => Promise<PublicMatrixEvidenceReport>;

const CODEX_MODEL = "gpt-5.5";
const CODEX_REASONING_EFFORT = "xhigh";
const CODEX_SERVICE_TIER = "fast";

async function loadVerifier(): Promise<VerifyPublicMatrixEvidence> {
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "scripts", "bench", "verify-public-matrix.ts"),
  ).href;
  const verifierModule = await import(
    `${moduleUrl}?bench-public-matrix-verifier=${Date.now()}-${Math.random()}`
  ) as { verifyPublicMatrixEvidence: VerifyPublicMatrixEvidence };
  return verifierModule.verifyPublicMatrixEvidence;
}

function codexProvider(): ProviderConfig {
  return {
    provider: "codex-cli",
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
  };
}

function benchmarkResult(
  benchmark: string,
  overrides: Partial<BenchmarkResult> = {},
): BenchmarkResult {
  const base: BenchmarkResult = {
    meta: {
      id: `${benchmark}-test-result`,
      benchmark,
      benchmarkTier: "published",
      version: "test",
      remnicVersion: "test",
      gitSha: "abc123",
      timestamp: "2026-05-14T12:00:00.000Z",
      mode: "full",
      runCount: 1,
      seeds: [1],
      status: "complete",
    },
    config: {
      runtimeProfile: "real",
      systemProvider: codexProvider(),
      judgeProvider: codexProvider(),
      internalProvider: codexProvider(),
      adapterMode: "remnic",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 3,
      inputTokens: 2,
      outputTokens: 1,
      estimatedCostUsd: 0,
      totalLatencyMs: 1,
      meanQueryLatencyMs: 1,
    },
    results: {
      tasks: [
        {
          taskId: `${benchmark}-task-1`,
          question: "What should be recalled?",
          expected: "answer",
          actual: "answer",
          scores: { accuracy: 1 },
          latencyMs: 1,
          tokens: { input: 2, output: 1 },
        },
      ],
      aggregates: {
        accuracy: {
          mean: 1,
          median: 1,
          stdDev: 0,
          min: 1,
          max: 1,
        },
      },
    },
    environment: {
      os: "test",
      nodeVersion: process.version,
    },
  };

  return {
    ...base,
    ...overrides,
    meta: {
      ...base.meta,
      ...overrides.meta,
    },
    config: {
      ...base.config,
      ...overrides.config,
    },
    results: {
      ...base.results,
      ...overrides.results,
    },
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeResult(resultsDir: string, result: BenchmarkResult): Promise<void> {
  await writeJson(path.join(resultsDir, `${result.meta.id}.json`), result);
}

async function manifestResultEntry(
  resultsDir: string,
  benchmark: string,
  gitSha: string,
): Promise<Record<string, unknown>> {
  return manifestResultEntryForPath(
    resultsDir,
    `${benchmark}-test-result.json`,
    benchmark,
    gitSha,
  );
}

async function manifestResultEntryForPath(
  resultsDir: string,
  resultPath: string,
  benchmark: string,
  gitSha: string,
): Promise<Record<string, unknown>> {
  try {
    const bytes = await readFile(path.join(resultsDir, resultPath));
    const result = JSON.parse(bytes.toString("utf8")) as BenchmarkResult;
    return {
      benchmark: result.meta.benchmark,
      path: resultPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      resultId: result.meta.id,
      mode: result.meta.mode,
      gitSha: result.meta.gitSha,
      taskCount: result.results.tasks.length,
    };
  } catch {
    return {
      benchmark,
      path: resultPath,
      sha256: "b".repeat(64),
      sizeBytes: 1,
      resultId: `${benchmark}-test-result`,
      mode: "full",
      gitSha,
      taskCount: 1,
    };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function manifestArtifactHashIdentity(manifest: Record<string, unknown>): unknown {
  const run = manifest.run as Record<string, unknown> | undefined;
  const git = manifest.git as Record<string, unknown> | undefined;
  const command = manifest.command as Record<string, unknown> | undefined;
  const environment = manifest.environment as Record<string, unknown> | undefined;
  return {
    schemaVersion: manifest.schemaVersion,
    run: {
      id: run?.id,
      ...(run?.mode ? { mode: run.mode } : {}),
      selectedBenchmarks: run?.selectedBenchmarks,
      runtimeProfiles: run?.runtimeProfiles,
      selectedWorkItems: run?.selectedWorkItems,
      ...(run && Object.prototype.hasOwnProperty.call(run, "limit")
        ? { limit: run.limit }
        : {}),
      ...(run && Object.prototype.hasOwnProperty.call(run, "seed")
        ? { seed: run.seed }
        : {}),
    },
    git: {
      commit: git?.commit,
      shortCommit: git?.shortCommit,
    },
    command: {
      argv: command?.argv,
      envKeys: command?.envKeys,
    },
    environment: {
      platform: environment?.platform,
      arch: environment?.arch,
      nodeVersion: environment?.nodeVersion,
      ...(environment?.packageManager
        ? { packageManager: environment.packageManager }
        : {}),
    },
    ...(manifest.qmd ? { qmd: manifest.qmd } : {}),
    configFiles: manifest.configFiles,
    datasets: manifest.datasets,
    results: manifest.results,
    ...(manifest.codexCredit ? { codexCredit: manifest.codexCredit } : {}),
  };
}

function withManifestArtifactHash(
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...manifest,
    artifactHash: createHash("sha256")
      .update(stableStringify(manifestArtifactHashIdentity(manifest)))
      .digest("hex"),
  };
}

function validCodexCreditReceipt(): Record<string, unknown> {
  const usage = {
    inputTokens: 100_000,
    cachedInputTokens: 20_000,
    outputTokens: 10_000,
    reasoningOutputTokens: 8_000,
  };
  const models = [
    { model: "gpt-5.6-luna", calls: 1, credits: 3.55, ...usage },
    { model: "gpt-5.6-terra", calls: 1, credits: 8.875, ...usage },
  ];
  const scope = {
    calls: 2,
    credits: 12.425,
    inputTokens: 200_000,
    cachedInputTokens: 40_000,
    outputTokens: 20_000,
    reasoningOutputTokens: 16_000,
    models,
  };
  return {
    schemaVersion: 1,
    ledgerSha256: "c".repeat(64),
    budgetCredits: 2_473,
    reserveCredits: 473,
    plannedSpendCeilingCredits: 2_000,
    totalSpentCredits: 12.425,
    totalRemainingCredits: 2_460.575,
    blocked: false,
    cumulative: scope,
    run: { id: "test-public-matrix-run", ...scope },
  };
}

function codexCreditReceiptWithUnexpectedModel(): Record<string, unknown> {
  const receipt = validCodexCreditReceipt();
  const usage = {
    inputTokens: 100_000,
    cachedInputTokens: 20_000,
    outputTokens: 10_000,
    reasoningOutputTokens: 8_000,
  };
  const extraModel = { model: "gpt-5.5", calls: 1, credits: 17.75, ...usage };
  for (const key of ["cumulative", "run"] as const) {
    const scope = receipt[key] as Record<string, unknown>;
    scope.calls = (scope.calls as number) + 1;
    scope.credits = (scope.credits as number) + extraModel.credits;
    for (const tokenKey of Object.keys(usage) as Array<keyof typeof usage>) {
      scope[tokenKey] = (scope[tokenKey] as number) + usage[tokenKey];
    }
    scope.models = [...(scope.models as unknown[]), extraModel];
  }
  receipt.totalSpentCredits = 30.175;
  receipt.totalRemainingCredits = 2_442.825;
  return receipt;
}

async function writeManifest(
  resultsDir: string,
  benchmarks: readonly string[],
  gitSha = "abc123",
  limit?: number,
  runId = "test-public-matrix-run",
  codexCredit?: Record<string, unknown>,
): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    git: {
      commit: gitSha,
      shortCommit: gitSha,
      dirty: false,
    },
    run: {
      id: runId,
      mode: "full",
      runtimeProfiles: ["real"],
      selectedBenchmarks: benchmarks,
      selectedWorkItems: benchmarks.map((benchmark) => ({
        benchmark,
        runtimeProfile: "real",
      })),
      ...(limit !== undefined ? { limit } : {}),
    },
    datasets: benchmarks.map((benchmark) => ({
      benchmark,
      status: "hashed",
      fileCount: 1,
      sha256: "a".repeat(64),
    })),
    results: await Promise.all(
      benchmarks.map((benchmark) => manifestResultEntry(resultsDir, benchmark, gitSha)),
    ),
    ...(codexCredit ? { codexCredit } : {}),
  };
  await writeJson(path.join(resultsDir, "MANIFEST.json"), withManifestArtifactHash(manifest));
}

async function writeDiagnostic(
  diagnosticsDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const fileName = typeof overrides.runId === "string"
    ? `codex-cli-${overrides.runId}-${String(overrides.model ?? "default")}.json`
    : "codex-cli.json";
  await writeJson(path.join(diagnosticsDir, fileName), {
    runId: "test-public-matrix-run",
    provider: "codex-cli",
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
    serviceTier: CODEX_SERVICE_TIER,
    result: {
      status: 0,
      signal: null,
    },
    ...overrides,
  });
}

test("verifies a complete Codex CLI public matrix evidence subset", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-ok-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmarks = ["longmemeval", "locomo"];
  for (const benchmark of benchmarks) {
    await writeResult(resultsDir, benchmarkResult(benchmark));
  }
  await writeResult(
    resultsDir,
    benchmarkResult("longmemeval", {
      meta: {
        id: "longmemeval-newer-unmanifested",
        timestamp: "2026-05-14T13:00:00.000Z",
      },
      config: {
        runtimeProfile: "baseline",
        systemProvider: {
          provider: "openai",
          model: "gpt-4.1",
        },
      },
    }),
  );
  await writeManifest(
    resultsDir,
    benchmarks,
    "abc123",
    undefined,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );
  await writeDiagnostic(diagnosticsDir);
  await writeDiagnostic(diagnosticsDir, {
    runId: "stale-run",
    serviceTier: "auto",
    error: "stale failure from previous run",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks,
    expectedGitSha: "abc123",
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(report.issues, []);

  const skipGitReport = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks,
    skipGitSha: true,
  });
  assert.equal(skipGitReport.ok, true, JSON.stringify(skipGitReport.issues, null, 2));
});

test("accepts a manifest whose artifact hash binds a Codex credit receipt", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-credit-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "longmemeval";
  const result = benchmarkResult(benchmark);
  result.config.systemProvider = {
    ...codexProvider(),
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };
  result.config.judgeProvider = {
    ...codexProvider(),
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
  };
  result.config.internalProvider = {
    ...codexProvider(),
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };
  result.config.benchmarkOptions = { limit: 1 };
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );
  await writeDiagnostic(diagnosticsDir, {
    runId: "test-public-matrix-run",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    serviceTier: "default",
  });
  await writeDiagnostic(diagnosticsDir, {
    runId: "test-public-matrix-run",
    model: "gpt-5.6-terra",
    reasoningEffort: "high",
    serviceTier: "default",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
    expectedSystemModel: "gpt-5.6-luna",
    expectedJudgeModel: "gpt-5.6-terra",
    expectedInternalModel: "gpt-5.6-luna",
    expectedSystemReasoningEffort: "medium",
    expectedJudgeReasoningEffort: "high",
    expectedInternalReasoningEffort: "medium",
    expectedServiceTier: "default",
    requireCodexCreditReceipt: true,
    allowBoundedTrial: true,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));

  result.config.internalProvider = undefined;
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );
  const optionalInternalOptions: VerifyPublicMatrixEvidenceOptions = {
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
    expectedSystemModel: "gpt-5.6-luna",
    expectedJudgeModel: "gpt-5.6-terra",
    expectedInternalModel: "gpt-5.5",
    expectedSystemReasoningEffort: "medium",
    expectedJudgeReasoningEffort: "high",
    expectedInternalReasoningEffort: "xhigh",
    expectedServiceTier: "default",
    requireCodexCreditReceipt: true,
    allowBoundedTrial: true,
    requireInternalProvider: false,
  };
  const optionalInternal = await verifyPublicMatrixEvidence(optionalInternalOptions);
  assert.equal(optionalInternal.ok, true, JSON.stringify(optionalInternal.issues, null, 2));

  const strictMissingInternal = await verifyPublicMatrixEvidence({
    ...optionalInternalOptions,
    requireInternalProvider: true,
  });
  assert.equal(
    strictMissingInternal.issues.some((issue) => issue.code === "missing-internalProvider"),
    true,
    JSON.stringify(strictMissingInternal.issues, null, 2),
  );

  result.config.internalProvider = {
    provider: "openai",
    model: "gpt-4.1",
  };
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );
  const optionalNonCodexInternal = await verifyPublicMatrixEvidence(optionalInternalOptions);
  assert.equal(
    optionalNonCodexInternal.ok,
    true,
    JSON.stringify(optionalNonCodexInternal.issues, null, 2),
  );
  const strictNonCodexInternal = await verifyPublicMatrixEvidence({
    ...optionalInternalOptions,
    requireInternalProvider: true,
  });
  assert.equal(
    strictNonCodexInternal.issues.some(
      (issue) => issue.code === "wrong-internalProvider-provider",
    ),
    true,
    JSON.stringify(strictNonCodexInternal.issues, null, 2),
  );

  result.config.internalProvider = {
    ...codexProvider(),
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
  };
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    codexCreditReceiptWithUnexpectedModel(),
  );
  await writeDiagnostic(diagnosticsDir, {
    runId: "test-public-matrix-run",
    model: "gpt-5.5",
    reasoningEffort: "xhigh",
    serviceTier: "default",
  });
  const optionalDistinctCodexInternal = await verifyPublicMatrixEvidence(
    optionalInternalOptions,
  );
  assert.equal(
    optionalDistinctCodexInternal.ok,
    true,
    JSON.stringify(optionalDistinctCodexInternal.issues, null, 2),
  );
  await rm(
    path.join(diagnosticsDir, "codex-cli-test-public-matrix-run-gpt-5.5.json"),
  );

  result.config.internalProvider = {
    ...codexProvider(),
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  };

  result.config.benchmarkOptions = {
    limit: 1,
    trialLimit: 1,
    taskFilter: "task-1",
  };
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );
  const filteredTrial = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
    expectedSystemModel: "gpt-5.6-luna",
    expectedJudgeModel: "gpt-5.6-terra",
    expectedInternalModel: "gpt-5.6-luna",
    expectedSystemReasoningEffort: "medium",
    expectedJudgeReasoningEffort: "high",
    expectedInternalReasoningEffort: "medium",
    expectedServiceTier: "default",
    requireCodexCreditReceipt: true,
    allowBoundedTrial: true,
  });
  const limitedIssues = filteredTrial.issues.filter((issue) => issue.code === "limited-result");
  assert.equal(limitedIssues.length, 1, JSON.stringify(filteredTrial.issues, null, 2));
  assert.match(limitedIssues[0]!.message, /taskFilter/);

  result.config.benchmarkOptions = { limit: 1 };
  await writeResult(resultsDir, result);
  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
    validCodexCreditReceipt(),
  );

  const noManifestBypass = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    requireManifest: false,
    requireDiagnostics: false,
    allowBoundedTrial: true,
    skipGitSha: true,
  });
  assert.equal(
    noManifestBypass.issues.some(
      (issue) => issue.code === "manifest-required-for-credit-evidence",
    ),
    true,
    JSON.stringify(noManifestBypass.issues, null, 2),
  );

  await rm(
    path.join(
      diagnosticsDir,
      "codex-cli-test-public-matrix-run-gpt-5.6-terra.json",
    ),
  );
  const missingProfile = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
    expectedSystemModel: "gpt-5.6-luna",
    expectedJudgeModel: "gpt-5.6-terra",
    expectedInternalModel: "gpt-5.6-luna",
    expectedSystemReasoningEffort: "medium",
    expectedJudgeReasoningEffort: "high",
    expectedInternalReasoningEffort: "medium",
    expectedServiceTier: "default",
    allowBoundedTrial: true,
  });
  assert.equal(
    missingProfile.issues.some(
      (issue) => issue.code === "missing-codex-diagnostic-profile",
    ),
    true,
    JSON.stringify(missingProfile.issues, null, 2),
  );

  await writeManifest(
    resultsDir,
    [benchmark],
    "abc123",
    1,
    "test-public-matrix-run",
  );
  const missingReceipt = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
    requireDiagnostics: false,
    allowBoundedTrial: true,
  });
  assert.equal(
    missingReceipt.issues.some(
      (issue) => issue.code === "manifest-missing-codex-credit-receipt",
    ),
    true,
    JSON.stringify(missingReceipt.issues, null, 2),
  );
});

test("rejects malformed, blocked, over-ceiling, and wrong-run Codex receipts", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-invalid-credit-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const resultsDir = path.join(tmpDir, "results");
  const benchmark = "longmemeval";
  await writeResult(resultsDir, benchmarkResult(benchmark));
  const variants: Array<Record<string, unknown>> = [
    { ...validCodexCreditReceipt(), blocked: true },
    {
      ...validCodexCreditReceipt(),
      totalSpentCredits: 2_001,
      totalRemainingCredits: 472,
    },
    { ...validCodexCreditReceipt(), ledgerSha256: "not-a-sha" },
    {
      ...validCodexCreditReceipt(),
      budgetCredits: 2_300,
      reserveCredits: 300,
      totalRemainingCredits: 2_287.575,
    },
    {
      ...validCodexCreditReceipt(),
      run: {
        ...(validCodexCreditReceipt().run as Record<string, unknown>),
        id: "different-run",
      },
    },
    {
      ...validCodexCreditReceipt(),
      run: {
        id: "test-public-matrix-run",
        calls: 0,
        credits: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        models: [],
      },
    },
    {
      ...validCodexCreditReceipt(),
      run: {
        id: "test-public-matrix-run",
        calls: 1,
        credits: 3.55,
        inputTokens: 100_000,
        cachedInputTokens: 20_000,
        outputTokens: 10_000,
        reasoningOutputTokens: 8_000,
        models: [
          {
            model: "gpt-5.6-luna",
            calls: 1,
            credits: 3.55,
            inputTokens: 100_000,
            cachedInputTokens: 20_000,
            outputTokens: 10_000,
            reasoningOutputTokens: 8_000,
          },
          {
            model: "gpt-5.6-terra",
            calls: 0,
            credits: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ],
      },
    },
    {
      ...validCodexCreditReceipt(),
      run: {
        id: "test-public-matrix-run",
        calls: 2,
        credits: 11.36,
        inputTokens: 140_000,
        cachedInputTokens: 28_000,
        outputTokens: 14_000,
        reasoningOutputTokens: 11_200,
        models: [
          {
            model: "gpt-5.6-luna",
            calls: 1,
            credits: 0.71,
            inputTokens: 20_000,
            cachedInputTokens: 4_000,
            outputTokens: 2_000,
            reasoningOutputTokens: 1_600,
          },
          {
            model: "gpt-5.6-terra",
            calls: 1,
            credits: 10.65,
            inputTokens: 120_000,
            cachedInputTokens: 24_000,
            outputTokens: 12_000,
            reasoningOutputTokens: 9_600,
          },
        ],
      },
    },
    codexCreditReceiptWithUnexpectedModel(),
  ];
  const verifyPublicMatrixEvidence = await loadVerifier();
  for (const receipt of variants) {
    await writeManifest(
      resultsDir,
      [benchmark],
      "abc123",
      undefined,
      "test-public-matrix-run",
      receipt,
    );
    const report = await verifyPublicMatrixEvidence({
      resultsDir,
      benchmarks: [benchmark],
      expectedGitSha: "abc123",
      expectedSystemModel: "gpt-5.6-luna",
      expectedJudgeModel: "gpt-5.6-terra",
      expectedInternalModel: "gpt-5.6-luna",
      requireDiagnostics: false,
      requireCodexCreditReceipt: true,
    });
    assert.equal(
      report.issues.some((issue) => issue.code === "manifest-invalid-codex-credit-receipt"),
      true,
      JSON.stringify(report.issues, null, 2),
    );
  }
});

test("selects the expected runtime profile from multi-profile manifests", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-profile-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "longmemeval";
  await writeResult(
    resultsDir,
    benchmarkResult(benchmark, {
      meta: {
        id: "longmemeval-baseline-result",
      },
      config: {
        runtimeProfile: "baseline",
      },
    }),
  );
  await writeResult(resultsDir, benchmarkResult(benchmark));
  await writeJson(path.join(resultsDir, "MANIFEST.json"), withManifestArtifactHash({
    schemaVersion: 1,
    git: {
      commit: "abc123",
      shortCommit: "abc123",
      dirty: false,
    },
    run: {
      id: "test-public-matrix-run",
      mode: "full",
      runtimeProfiles: ["baseline", "real"],
      selectedBenchmarks: [benchmark],
    },
    datasets: [
      {
        benchmark,
        status: "hashed",
        fileCount: 1,
        sha256: "a".repeat(64),
      },
    ],
    results: [
      await manifestResultEntryForPath(
        resultsDir,
        "longmemeval-baseline-result.json",
        benchmark,
        "abc123",
      ),
      await manifestResultEntryForPath(
        resultsDir,
        "longmemeval-test-result.json",
        benchmark,
        "abc123",
      ),
    ],
  }));
  await writeDiagnostic(diagnosticsDir);

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
  });

  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
  assert.deepEqual(report.issues, []);
});

test("rejects manifest result files swapped after manifest generation", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-hash-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "longmemeval";
  await writeResult(resultsDir, benchmarkResult(benchmark));
  await writeManifest(resultsDir, [benchmark]);
  await writeJson(
    path.join(resultsDir, `${benchmark}-test-result.json`),
    benchmarkResult(benchmark, {
      meta: {
        id: `${benchmark}-swapped-result`,
      },
      results: {
        tasks: [
          {
            taskId: `${benchmark}-task-1`,
            question: "What should be recalled?",
            expected: "answer",
            actual: "different answer",
            scores: { accuracy: 0.5 },
            latencyMs: 1,
            tokens: { input: 2, output: 1 },
          },
        ],
        aggregates: {
          accuracy: {
            mean: 0.5,
            median: 0.5,
            stdDev: 0,
            min: 0.5,
            max: 0.5,
          },
        },
      },
    }),
  );
  await writeDiagnostic(diagnosticsDir);

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("manifest-result-hash-mismatch"), true);
  assert.equal(issueCodes.has("manifest-result-id-mismatch"), true);
});

test("rejects tampered manifest run ids before trusting diagnostics", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-runid-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "longmemeval";
  await writeResult(resultsDir, benchmarkResult(benchmark));
  await writeManifest(resultsDir, [benchmark], "abc123", undefined, "original-run");

  const manifestPath = path.join(resultsDir, "MANIFEST.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    run: { id: string };
  };
  manifest.run.id = "borrowed-fast-run";
  await writeJson(manifestPath, manifest);
  await writeDiagnostic(diagnosticsDir, {
    runId: "borrowed-fast-run",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("manifest-artifact-hash-mismatch"), true);
});

test("reports missing and wrong public matrix evidence", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-bad-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  await writeResult(
    resultsDir,
    benchmarkResult("longmemeval", {
      config: {
        runtimeProfile: "baseline",
        systemProvider: {
          provider: "openai",
          model: "gpt-4.1",
          reasoningEffort: "high",
        },
        benchmarkOptions: {
          limit: 1,
        },
      },
    }),
  );
  await writeManifest(resultsDir, ["longmemeval", "locomo"], "abc123", 1);
  await writeDiagnostic(diagnosticsDir, {
    serviceTier: "auto",
  });

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: ["longmemeval", "locomo"],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("wrong-runtime-profile"), true);
  assert.equal(issueCodes.has("wrong-systemProvider-provider"), true);
  assert.equal(issueCodes.has("limited-result"), true);
  assert.equal(issueCodes.has("manifest-limited-run"), true);
  assert.equal(issueCodes.has("wrong-diagnostic-service-tier"), true);
  assert.equal(issueCodes.has("manifest-result-unreadable"), true);
});

test("rejects task-level failure sentinels even when aggregates are finite", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-sentinel-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "longmemeval";
  await writeResult(
    resultsDir,
    benchmarkResult(benchmark, {
      results: {
        tasks: [
          {
            taskId: `${benchmark}-task-1`,
            question: "What should be recalled?",
            expected: "answer",
            actual: "",
            scores: { judge_accuracy: -1 },
            latencyMs: 1,
            tokens: { input: 2, output: 1 },
            details: { error: "judge failed" },
          },
        ],
        aggregates: {
          judge_accuracy: {
            mean: -1,
            median: -1,
            stdDev: 0,
            min: -1,
            max: -1,
          },
        },
      },
    }),
  );
  await writeManifest(resultsDir, [benchmark]);
  await writeDiagnostic(diagnosticsDir);

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("task-error"), true);
  assert.equal(issueCodes.has("negative-task-score"), true);
  assert.equal(issueCodes.has("negative-aggregate-metric"), true);
});

test("rejects MemoryAgentBench tasks without official protocol scoring", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-protocol-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const diagnosticsDir = path.join(resultsDir, "codex-cli-diagnostics");
  const benchmark = "memoryagentbench";
  await writeResult(
    resultsDir,
    benchmarkResult(benchmark, {
      results: {
        tasks: [
          {
            taskId: `${benchmark}-redial-missing-mapping`,
            question: "Which movie should be recommended?",
            expected: "The Matrix",
            actual: "The Matrix",
            scores: {
              official_protocol_ready: 0,
            },
            latencyMs: 1,
            tokens: { input: 2, output: 1 },
          },
        ],
        aggregates: {
          official_protocol_ready: {
            mean: 0,
            median: 0,
            stdDev: 0,
            min: 0,
            max: 0,
          },
        },
      },
    }),
  );
  await writeManifest(resultsDir, [benchmark]);
  await writeDiagnostic(diagnosticsDir);

  const verifyPublicMatrixEvidence = await loadVerifier();
  const report = await verifyPublicMatrixEvidence({
    resultsDir,
    benchmarks: [benchmark],
    expectedGitSha: "abc123",
  });
  const issueCodes = new Set(report.issues.map((issue) => issue.code));

  assert.equal(report.ok, false);
  assert.equal(issueCodes.has("official-protocol-not-ready"), true);
});

test("fails closed when the current git sha cannot be resolved", async (t) => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-public-matrix-no-git-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));

  const resultsDir = path.join(tmpDir, "results");
  const benchmarks = ["longmemeval"];
  await writeResult(resultsDir, benchmarkResult("longmemeval"));
  await writeManifest(resultsDir, benchmarks);

  const verifyPublicMatrixEvidence = await loadVerifier();
  const previousCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    const report = await verifyPublicMatrixEvidence({
      resultsDir,
      benchmarks,
      requireDiagnostics: false,
    });
    const issueCodes = new Set(report.issues.map((issue) => issue.code));

    assert.equal(report.ok, false);
    assert.equal(issueCodes.has("missing-current-git-sha"), true);
  } finally {
    process.chdir(previousCwd);
  }
});
