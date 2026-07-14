import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  buildBenchmarkPublishFeed,
  deleteBenchmarkResults,
  defaultBenchmarkBaselineDir,
  defaultBenchmarkPublishPath,
  listBenchmarkBaselines,
  listBenchmarkResults,
  loadBenchmarkBaseline,
  loadBenchmarkResult,
  renderBenchmarkResultExport,
  resolveBenchmarkResultReference,
  saveBenchmarkBaseline,
  writeBenchmarkPublishFeed,
} from "../packages/bench/src/results-store.ts";
import type { BenchmarkResult } from "../packages/bench/src/types.ts";
import { hashString } from "../packages/bench/src/integrity/index.ts";

function buildResult(
  id: string,
  timestamp: string,
  benchmark = "longmemeval",
): BenchmarkResult {
  return {
    meta: {
      id,
      benchmark,
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "9.3.35",
      gitSha: "abc1234",
      timestamp,
      mode: "full",
      runCount: 5,
      seeds: [0, 1, 2, 3, 4],
      splitType: "holdout",
      qrelsSealedHash: hashString(`${benchmark}:qrels`),
      judgePromptHash: hashString(`${benchmark}:judge`),
      datasetHash: hashString(`${benchmark}:dataset`),
    },
    config: {
      runtimeProfile: null,
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "lightweight",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: "darwin",
      nodeVersion: process.version,
    },
  };
}

test("listBenchmarkResults sorts valid result files newest first and skips invalid JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-results-"));
  await mkdir(root, { recursive: true });

  const olderPath = path.join(root, "older.json");
  const newerPath = path.join(root, "newer.json");
  await writeFile(
    olderPath,
    `${JSON.stringify(buildResult("run-older", "2026-04-18T00:00:00.000Z"))}\n`,
  );
  await writeFile(
    newerPath,
    `${JSON.stringify(buildResult("run-newer", "2026-04-18T01:00:00.000Z"))}\n`,
  );
  await writeFile(path.join(root, "broken.json"), "{not json\n");

  const listed = await listBenchmarkResults(root);
  assert.deepEqual(
    listed.map((entry) => entry.id),
    ["run-newer", "run-older"],
  );
});

test("loadBenchmarkResult rejects invalid benchmark result files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-load-"));
  const invalidPath = path.join(root, "invalid.json");
  await writeFile(invalidPath, JSON.stringify({ hello: "world" }));

  await assert.rejects(
    () => loadBenchmarkResult(invalidPath),
    /Invalid benchmark result file/,
  );
});

test("loadBenchmarkResult rejects incomplete benchmark result payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-incomplete-"));
  const invalidPath = path.join(root, "incomplete.json");
  await writeFile(
    invalidPath,
    JSON.stringify({
      meta: {
        id: "incomplete-run",
        benchmark: "longmemeval",
        timestamp: "2026-04-18T00:00:00.000Z",
        mode: "full",
      },
    }),
  );

  await assert.rejects(
    () => loadBenchmarkResult(invalidPath),
    /Invalid benchmark result file/,
  );
});

test("loadBenchmarkResult preserves runtime profile metadata on stored results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-runtime-profile-"));
  const filePath = path.join(root, "runtime-profile.json");
  const result = buildResult("runtime-profile-run", "2026-04-18T00:30:00.000Z");
  result.config.runtimeProfile = "real";

  await writeFile(filePath, `${JSON.stringify(result)}\n`);

  const loaded = await loadBenchmarkResult(filePath);
  assert.equal(loaded.config.runtimeProfile, "real");
});

test("resolveBenchmarkResultReference matches by id, basename, or direct path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-resolve-"));
  const filePath = path.join(root, "candidate.json");
  await writeFile(
    filePath,
    `${JSON.stringify(buildResult("candidate-run", "2026-04-18T02:00:00.000Z"))}\n`,
  );

  const byId = await resolveBenchmarkResultReference(root, "candidate-run");
  const byBasename = await resolveBenchmarkResultReference(root, "candidate.json");
  const byPath = await resolveBenchmarkResultReference(root, filePath);

  assert.equal(byId?.id, "candidate-run");
  assert.equal(byBasename?.id, "candidate-run");
  assert.equal(byPath?.path, filePath);
});

test("resolveBenchmarkResultReference falls back to id matching when a same-named direct path is invalid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-fallback-"));
  const storedPath = path.join(root, "stored.json");
  await writeFile(
    storedPath,
    `${JSON.stringify(buildResult("candidate-run", "2026-04-18T03:00:00.000Z"))}\n`,
  );

  const cwd = process.cwd();
  const conflictingPath = path.join(root, "candidate-run");
  await writeFile(conflictingPath, "not benchmark json");

  try {
    process.chdir(root);
    const resolved = await resolveBenchmarkResultReference(root, "candidate-run");
    assert.equal(resolved?.id, "candidate-run");
    assert.equal(resolved?.path, storedPath);
  } finally {
    process.chdir(cwd);
  }
});

test("deleteBenchmarkResults removes matched stored results and reports unmatched references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-delete-"));
  const firstPath = path.join(root, "first.json");
  const secondPath = path.join(root, "second.json");
  await writeFile(
    firstPath,
    `${JSON.stringify(buildResult("run-first", "2026-04-18T03:00:00.000Z"))}\n`,
  );
  await writeFile(
    secondPath,
    `${JSON.stringify(buildResult("run-second", "2026-04-18T04:00:00.000Z"))}\n`,
  );

  const result = await deleteBenchmarkResults(root, ["run-first", "missing-run"]);
  const listed = await listBenchmarkResults(root);

  assert.deepEqual(result.deleted.map((entry) => entry.id), ["run-first"]);
  assert.deepEqual(result.missing, ["missing-run"]);
  assert.deepEqual(listed.map((entry) => entry.id), ["run-second"]);
});

test("saveBenchmarkBaseline persists a named baseline and listBenchmarkBaselines returns newest first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baselines-"));
  const firstPath = await saveBenchmarkBaseline(
    root,
    "main",
    buildResult("run-main", "2026-04-18T04:00:00.000Z"),
    { id: "run-main", path: "/tmp/run-main.json" },
  );

  await new Promise((resolve) => setTimeout(resolve, 5));

  const secondPath = await saveBenchmarkBaseline(
    root,
    "candidate",
    buildResult("run-candidate", "2026-04-18T05:00:00.000Z"),
    { id: "run-candidate", path: "/tmp/run-candidate.json" },
  );

  const stored = await loadBenchmarkBaseline(firstPath);
  const listed = await listBenchmarkBaselines(root);

  assert.equal(stored.name, "main");
  assert.equal(stored.source?.id, "run-main");
  assert.equal(listed[0]?.name, "candidate");
  assert.equal(listed[0]?.path, secondPath);
  assert.equal(listed[1]?.name, "main");
});

test("saveBenchmarkBaseline rejects invalid baseline names instead of sanitizing them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-invalid-"));

  await assert.rejects(
    () => saveBenchmarkBaseline(root, "main branch", buildResult("run-main", "2026-04-18T06:00:00.000Z")),
    /Invalid baseline name/,
  );
});

test("listBenchmarkBaselines rejects baseline paths that exist as files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-file-list-"));
  const baselinePath = path.join(root, "baselines.json");
  await writeFile(baselinePath, "not a directory");

  await assert.rejects(
    () => listBenchmarkBaselines(baselinePath),
    /Invalid benchmark baseline directory: .* is not a directory\./,
  );
});

test("saveBenchmarkBaseline rejects baseline paths that exist as files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-file-save-"));
  const baselinePath = path.join(root, "baselines.json");
  await writeFile(baselinePath, "not a directory");

  await assert.rejects(
    () => saveBenchmarkBaseline(
      baselinePath,
      "main",
      buildResult("run-main", "2026-04-18T06:30:00.000Z"),
    ),
    /Invalid benchmark baseline directory: .* is not a directory\./,
  );
});

test("defaultBenchmarkBaselineDir resolves under the Remnic home directory", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const customHomeDir = path.join(path.sep, "tmp", "remnic-home");

  process.env.HOME = customHomeDir;
  delete process.env.USERPROFILE;

  try {
    const baselineDir = defaultBenchmarkBaselineDir();
    assert.equal(
      baselineDir,
      path.join(customHomeDir, ".remnic", "bench", "baselines"),
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("renderBenchmarkResultExport returns JSON and aggregate-metric CSV representations", () => {
  const result = buildResult("candidate-run", "2026-04-18T07:00:00.000Z");
  result.results.aggregates = {
    answerAccuracy: {
      mean: 0.8,
      median: 0.8,
      stdDev: 0.1,
      min: 0.6,
      max: 0.9,
    },
  };

  const json = renderBenchmarkResultExport(result, "json");
  const csv = renderBenchmarkResultExport(result, "csv");
  const html = renderBenchmarkResultExport(result, "html");

  assert.match(json, /"candidate-run"/);
  assert.match(csv, /^result_id,benchmark,timestamp,mode,metric,mean,median,std_dev,min,max$/m);
  assert.match(csv, /candidate-run,longmemeval,2026-04-18T07:00:00.000Z,full,answerAccuracy,0.8,0.8,0.1,0.6,0.9/);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<title>Remnic Bench Report: longmemeval<\/title>/);
  assert.match(html, /candidate-run/);
  assert.match(html, /answerAccuracy/);
  assert.match(html, /Aggregate Metrics/);
  assert.match(html, /Task Count/);
});

test("renderBenchmarkResultExport handles older results without seed metadata", () => {
  const result = buildResult("older-run", "2026-04-18T08:00:00.000Z");
  delete (result.meta as { seeds?: number[] }).seeds;
  result.config.remnicConfig = {
    authToken: "secret-token",
    endpoint: "https://internal.example.com",
  };

  const html = renderBenchmarkResultExport(result, "html");

  assert.match(html, /Older-run|older-run/i);
  assert.match(html, /Seeds/);
  assert.match(html, /Not recorded/);
  assert.match(html, /\[redacted 2 keys\]/);
  assert.doesNotMatch(html, /secret-token/);
  assert.doesNotMatch(html, /internal\.example\.com/);
});

test("HTML export renders a byte-identical offline memory report card with correction receipts", () => {
  const result = buildResult("memcorrect-card", "2026-07-15T12:00:00.000Z", "memcorrect-v1");
  result.config.adapterMode = "mcp-demo";
  result.config.systemProvider = { provider: "openai", model: "gpt-5.6" };
  result.config.judgeProvider = {
    provider: "openai",
    model: "gpt-5.6",
    rubricVersion: "openai-responses-bench-v1",
  };
  result.config.benchmarkOptions = {
    aggregateMetrics: {
      uptake_at_next: 0.75,
      non_resurrection: 1,
      false_apply: 0,
    },
  };
  result.results.tasks = [
    {
      taskId: "scenario-b",
      question: "What database do we use?",
      expected: "PostgreSQL",
      actual: "PostgreSQL",
      scores: { uptake_at_next: 1, non_resurrection: 1, false_apply: 0 },
      latencyMs: 12,
      tokens: { input: 0, output: 0 },
      details: { shape: "replacement", category: "preference" },
    },
    {
      taskId: "scenario-a",
      question: "What region is active?",
      expected: "us-east-2",
      actual: "us-east-1",
      scores: { uptake_at_next: 0, non_resurrection: 1, false_apply: 0 },
      latencyMs: 9,
      tokens: { input: 0, output: 0 },
      details: { shape: "scoped", category: "location" },
    },
  ];
  result.results.aggregates = {
    uptake_at_next: { mean: 0.5, median: 0.5, stdDev: 0.5, min: 0, max: 1 },
    non_resurrection: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
    false_apply: { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 },
    stale_memory_harm_rate: { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 },
  };

  const first = renderBenchmarkResultExport(result, "html");
  const second = renderBenchmarkResultExport(result, "html");

  assert.equal(first, second);
  assert.equal(
    createHash("sha256").update(first).digest("hex"),
    "09e38f40f483b60424fd2b2e1d54b547c55197a96c268c8524fce6ac5596ee75",
  );
  assert.match(first, /Overall score · uptake_at_next/);
  assert.match(first, /no cross-metric composite/);
  assert.match(first, /Correction ledger/);
  assert.match(first, /Stale fact stayed retired/);
  assert.match(first, /Did stale memory harm the answer\?/);
  assert.match(first, /No pass threshold is recorded in the result/);
  assert.match(first, /openai \/ gpt-5\.6/);
  assert.match(first, /openai-responses-bench-v1/);
  assert.match(first, /Manifest reference/);
  assert.match(first, /Not available/);
  assert.ok(first.indexOf("scenario-a") < first.indexOf("scenario-b"));
  assert.doesNotMatch(first, /<(?:script|link)\b/i);
  assert.doesNotMatch(first, /(?:src|href)=["']https?:/i);
});

test("HTML export renders backend-unusable and partial runs without zero-score claims", () => {
  const unusable = buildResult("failed-mcp", "2026-07-15T12:30:00.000Z", "memcorrect-v1");
  unusable.meta.status = "partial";
  unusable.meta.failureReason = "backend_unusable: missing <update_memory> tool";
  unusable.results.tasks = [];
  unusable.results.aggregates = {};

  const html = renderBenchmarkResultExport(unusable, "html");

  assert.match(html, /Backend unusable/);
  assert.match(html, /No defensible score/);
  assert.match(html, /N\/A/);
  assert.match(html, /Missing evidence stays missing/);
  assert.match(html, /No aggregate metrics were recorded/);
  assert.match(html, /missing &lt;update_memory&gt; tool/);
  assert.doesNotMatch(html, /Overall score ·/);
  assert.doesNotMatch(html, />0%<\/span>/);

  const partial = buildResult("partial-run", "2026-07-15T12:45:00.000Z");
  partial.meta.status = "partial";
  partial.meta.failureReason = "judge timeout after task 1 of 4";
  partial.results.tasks = [{
    taskId: "completed-task",
    question: "q",
    expected: "a",
    actual: "a",
    scores: { accuracy: 1 },
    latencyMs: 10,
    tokens: { input: 1, output: 1 },
  }];
  partial.results.aggregates = {
    accuracy: { mean: 1, median: 1, stdDev: 0, min: 1, max: 1 },
  };
  const partialHtml = renderBenchmarkResultExport(partial, "html");
  assert.match(partialHtml, /Partial run/);
  assert.match(partialHtml, /completed tasks only and are not a full result/);
  assert.match(partialHtml, /Overall score · accuracy/);

  for (const code of ["transport_failure", "tool_failure", "invalid_response"]) {
    const failed = buildResult(`failed-${code}`, "2026-07-15T12:50:00.000Z");
    failed.meta.status = "partial";
    failed.meta.failureReason = `${code}: backend rejected request`;
    failed.results.tasks = [];
    const failedHtml = renderBenchmarkResultExport(failed, "html");
    assert.match(failedHtml, /Backend unusable/);

    failed.results.tasks = partial.results.tasks;
    failed.results.aggregates = partial.results.aggregates;
    const evidencedHtml = renderBenchmarkResultExport(failed, "html");
    assert.match(evidencedHtml, /Partial run/);
    assert.doesNotMatch(evidencedHtml, /Backend unusable/);
  }
});

test("HTML export does not invent an overall score from an undeclared aggregate", () => {
  const result = buildResult("latency-only", "2026-07-15T13:00:00.000Z");
  result.results.tasks = [{
    taskId: "completed-task",
    question: "q",
    expected: "a",
    actual: "a",
    scores: { uptake_latency: 0.5 },
    latencyMs: 10,
    tokens: { input: 0, output: 0 },
  }];
  result.results.aggregates = {
    uptake_latency: { mean: 0.5, median: 0.5, stdDev: 0, min: 0.5, max: 0.5 },
  };

  const html = renderBenchmarkResultExport(result, "html");
  assert.match(html, /No defensible score/);
  assert.doesNotMatch(html, /Overall score · uptake_latency/);
  assert.match(html, /<th scope="row">uptake_latency<\/th><td>0\.5<\/td>/);
});

test("buildBenchmarkPublishFeed keeps only the latest full published result per benchmark", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-publish-"));
  const olderLongMemEval = buildResult("run-old", "2026-04-18T07:00:00.000Z");
  olderLongMemEval.results.aggregates = {
    answerAccuracy: { mean: 0.5, median: 0.5, stdDev: 0, min: 0.5, max: 0.5 },
  };

  const newerPublishedQuick = buildResult("run-quick", "2026-04-18T09:00:00.000Z");
  newerPublishedQuick.meta.mode = "quick";
  newerPublishedQuick.results.aggregates = {
    answerAccuracy: { mean: 0.8, median: 0.8, stdDev: 0, min: 0.8, max: 0.8 },
  };

  const newerRemnicFull = buildResult("run-remnic", "2026-04-18T10:00:00.000Z");
  newerRemnicFull.meta.benchmarkTier = "remnic";
  newerRemnicFull.results.aggregates = {
    answerAccuracy: { mean: 0.9, median: 0.9, stdDev: 0, min: 0.9, max: 0.9 },
  };

  const locomo = buildResult("run-locomo", "2026-04-18T06:00:00.000Z", "locomo");
  locomo.results.tasks = [{ taskId: "1", question: "q", expected: "e", actual: "a", scores: { exactMatch: 1 }, latencyMs: 10, tokens: { input: 1, output: 1 } }];

  await writeFile(path.join(root, "old.json"), `${JSON.stringify(olderLongMemEval)}\n`);
  await writeFile(path.join(root, "new-quick.json"), `${JSON.stringify(newerPublishedQuick)}\n`);
  await writeFile(path.join(root, "new-remnic.json"), `${JSON.stringify(newerRemnicFull)}\n`);
  await writeFile(path.join(root, "locomo.json"), `${JSON.stringify(locomo)}\n`);
  const artifactHash = "a".repeat(64);
  await writeFile(path.join(root, "MANIFEST.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifactHash,
    results: [{ resultId: "run-old" }, { resultId: "run-locomo" }],
  })}\n`);

  const feed = await buildBenchmarkPublishFeed(root, "remnic-ai");

  assert.equal(feed.target, "remnic-ai");
  assert.deepEqual(
    feed.benchmarks.map((entry) => [entry.benchmark, entry.resultId]),
    [["longmemeval", "run-old"], ["locomo", "run-locomo"]],
  );
  assert.equal(feed.benchmarks[0]?.aggregateMetrics.answerAccuracy?.mean, 0.5);
  assert.equal(feed.benchmarks[1]?.taskCount, 1);
  assert.match(feed.benchmarks[0]?.reportCardHtml ?? "", /<!doctype html>/i);
  assert.match(feed.benchmarks[0]?.reportCardHtml ?? "", /MANIFEST\.json/);
  assert.match(feed.benchmarks[0]?.reportCardHtml ?? "", new RegExp(artifactHash));
  assert.equal("source" in (feed.benchmarks[0] ?? {}), false);
});

test("defaultBenchmarkPublishPath resolves under the Remnic published directory", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const customHomeDir = path.join(path.sep, "tmp", "remnic-publish-home");

  process.env.HOME = customHomeDir;
  delete process.env.USERPROFILE;

  try {
    const publishPath = defaultBenchmarkPublishPath("remnic-ai");
    assert.equal(
      publishPath,
      path.join(customHomeDir, ".remnic", "published", "benchmarks.json"),
    );
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("writeBenchmarkPublishFeed persists the generated feed as JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-feed-write-"));
  const feed = {
    target: "remnic-ai" as const,
    generatedAt: "2026-04-18T09:00:00.000Z",
    benchmarks: [],
  };

  const outputPath = path.join(root, "published", "benchmarks.json");
  const writtenPath = await writeBenchmarkPublishFeed(feed, outputPath);
  const written = JSON.parse(await readFile(writtenPath, "utf8")) as typeof feed;

  assert.equal(writtenPath, outputPath);
  assert.equal(written.target, "remnic-ai");
  assert.deepEqual(written.benchmarks, []);
});
