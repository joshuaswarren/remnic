import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as benchPackage from "../packages/bench/src/index.js";

test("bench root exports every H6 CLI entrypoint", async () => {

  for (const symbol of [
    "runRepeatedFailureCliCommand",
    "replayRepeatedFailureStatistics",
    "runTrapAuditCliCommand",
  ] as const) {
    assert.equal(typeof benchPackage[symbol], "function");
  }
});

test("remnic CLI source wires the new bench command and keeps benchmark as an alias", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /\| "bench"/);
  assert.match(source, /case "bench": \{/);
  assert.match(source, /case "benchmark": \{/);
  assert.match(source, /await cmdBench\(rest\);/);
  assert.match(
    source,
    /remnic bench <list\|run\|published\|datasets\|runs\|compare\|results\|baseline\|export\|publish\|ui\|providers\|judge-calibrate\|attribute\|drift-gen\|coding>/
  );
  assert.match(source, /benchmark is kept as a compatibility alias/i);
});

test("bench surface publishes the phase-1 benchmark catalog and quick-run fallback mapping", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const fallbackSource = await readFile("packages/remnic-cli/src/bench-fallback.ts", "utf8");

  for (const benchmarkId of ["ama-bench", "memory-arena", "amemgym", "longmemeval", "locomo"]) {
    assert.match(source, new RegExp(`id: "${benchmarkId}"`));
  }
  for (const datasetBenchmarkId of [
    "ama-bench",
    "memory-arena",
    "amemgym",
    "longmemeval",
    "locomo",
    "beam",
    "personamem",
    "membench",
    "memoryagentbench",
  ]) {
    assert.match(source, new RegExp(`"${datasetBenchmarkId}"`));
  }
  assert.match(
    fallbackSource,
    /if \(parsed\.quick\) \{\s*args\.push\("--lightweight"\);\s*\}[\s\S]*else if \(parsed\.quick\) \{\s*args\.push\("--limit", "1"\);\s*\}/
  );
  assert.match(fallbackSource, /args\.push\("--dataset-dir", parsed\.datasetDir\)/);
  assert.match(source, /Use 'remnic bench list' to see available\./);
});

test("workspace scripts expose bench list, bench run, and a quick smoke path", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const helper = await readFile("scripts/run-bench-cli.mjs", "utf8");
  const buildHelper = await readFile("scripts/build-staleness.mjs", "utf8");

  assert.equal(pkg.scripts?.["bench:list"], "node scripts/run-bench-cli.mjs list");
  assert.equal(pkg.scripts?.["bench:run"], "node scripts/run-bench-cli.mjs run");
  assert.equal(pkg.scripts?.["bench:compare"], "node scripts/run-bench-cli.mjs compare");
  assert.equal(pkg.scripts?.["bench:quick"], "node scripts/run-bench-cli.mjs run --quick longmemeval");

  assert.match(helper, /from "\.\/build-staleness\.mjs"/);
  assert.match(helper, /packages", "remnic-core", "dist", "index\.js"/);
  assert.match(helper, /packages", "bench", "dist", "index\.js"/);
  assert.match(helper, /ensurePackageBuild\(\s*repoRoot,\s*"@remnic\/core"/);
  assert.match(helper, /ensurePackageBuild\(\s*repoRoot,\s*"@remnic\/bench"/);
  assert.doesNotMatch(helper, /isAnySourceNewerThan\(/);
  assert.match(buildHelper, /export function runPnpm\(repoRoot, args\)/);
  assert.match(helper, /\["exec", "tsx", "packages\/remnic-cli\/src\/index\.ts", "bench"/);
});

test("CLI prebuild helper hydrates the bundled export adapter before building", async () => {
  const helper = await readFile("scripts/ensure-cli-bench-build-deps.mjs", "utf8");
  const buildHelper = await readFile("scripts/build-staleness.mjs", "utf8");

  assert.match(helper, /from "\.\/build-staleness\.mjs"/);
  assert.match(helper, /packages", "remnic-core", "dist", "index\.js"/);
  assert.match(helper, /packages", "bench", "dist", "index\.js"/);
  assert.match(helper, /packages", "export-weclone", "dist", "index\.js"/);
  assert.match(buildHelper, /runPnpm\(repoRoot, \["--filter", pkgName, "build"\]\);/);
  assert.match(helper, /ensurePackageBuild\(\s*repoRoot,\s*"@remnic\/core"/);
  assert.match(helper, /ensurePackageBuild\(\s*repoRoot,\s*"@remnic\/bench"/);
  assert.match(helper, /ensurePackageBuild\(\s*repoRoot,\s*"@remnic\/export-weclone"/);
});

test("CLI README documents bench list and quick-run examples", async () => {
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(readme, /remnic bench list/);
  assert.match(readme, /remnic bench datasets download longmemeval/);
  assert.match(readme, /remnic bench runs list/);
  assert.match(readme, /remnic bench runs show candidate-run --detail/);
  assert.match(readme, /remnic bench run --quick longmemeval/);
  assert.match(readme, /--dataset-dir ~\/datasets\/longmemeval/);
  assert.match(readme, /remnic bench compare base-run candidate-run/);
  assert.match(readme, /remnic bench publish --target remnic-ai/);
  assert.match(readme, /remnic benchmark run --quick longmemeval/);
  assert.match(readme, /bundled smoke fixture/i);
  assert.match(readme, /full runs need a real benchmark dataset/i);
  assert.match(readme, /datasets for `ama-bench`, `memory-arena`, `amemgym`, `longmemeval`, `locomo`,/);
  assert.match(readme, /`beam`, `personamem`, `membench`, and `memoryagentbench`/);
});

test("CLI uses package-owned adapters for migrated benchmark runs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /createLightweightAdapter/);
  assert.match(source, /createRemnicAdapter/);
  assert.match(source, /async function runBenchViaPackage/);
  // Per the à-la-carte invariant (AGENTS.md §44), runBenchViaPackage must
  // reach @remnic/bench through the optional loader so the CLI degrades
  // gracefully when the package isn't installed.
  assert.match(source, /const loaded = await tryLoadBenchModule\(\);\s*if \(!loaded\) return false;/s);
  assert.doesNotMatch(source, /evals\/adapter\/engram-adapter\.ts/);
});

test("optional bench loader imports workspace source through a TS-aware fallback", async () => {
  const source = await readFile("packages/remnic-cli/src/optional-bench.ts", "utf8");

  assert.match(source, /const TSX_ESM_API_SPECIFIER = "tsx\/esm\/" \+ "api";/);
  assert.match(source, /await import\(TSX_ESM_API_SPECIFIER\)/);
  assert.match(source, /tsImport\(pathToFileURL\(sourceEntry\)\.href,\s*import\.meta\.url\)/);
  assert.match(source, /fromLocalWorkspaceBenchSource: true/);
  assert.match(source, /cachedFromLocalWorkspaceBenchSource/);
  assert.match(
    source,
    /if \(!cachedFromLocalWorkspaceBenchSource\) \{\s*assertBenchModuleFreshForDevelopment\(\);\s*\}/
  );
  assert.match(
    source,
    /export function assertBenchModuleFreshForDevelopment\(\): void \{\s*if \(cachedFromLocalWorkspaceBenchSource\) \{\s*return;\s*\}\s*assertLocalBenchBuildFreshForDevelopment\(import\.meta\.url\);/s
  );
  assert.doesNotMatch(source, /await import\(pathToFileURL\(sourceEntry\)\.href\)/);
});

test("--all selection resolves to runnable package benchmarks when package metadata is available", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /category === "ingestion"/);
  assert.match(source, /async function resolveAllBenchmarks\(\)/);
  assert.match(source, /packageBenchmarks\s*\n\s*\.filter\(\s*\(entry\) =>\s*entry\.runnerAvailable\s*\)/s);
  assert.doesNotMatch(source, /packageBenchmarks[\s\S]*?entry\.meta\?\.category !== "ingestion"/);
  assert.match(source, /let selectedBenchmarks = parsed\.all\s+\? await resolveAllBenchmarks\(\)/s);
  assert.match(source, /async function resolveKnownBenchmarkIds\(\): Promise<Set<string>>/);
  assert.match(source, /const knownBenchmarkIds = await resolveKnownBenchmarkIds\(\);/);
  assert.match(source, /selectedBenchmarks\.filter\(\(benchmarkId\) => !knownBenchmarkIds\.has\(benchmarkId\)\)/);
  assert.match(source, /no runnable benchmarks are available for --all in this install/i);
});

test("bench CLI validates and resolves explicit dataset overrides for full package runs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const usageSource = await readFile("packages/remnic-cli/src/bench-usage.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const flagsSource = await readFile("packages/remnic-cli/src/bench-flags.ts", "utf8");

  assert.match(usageSource, /--dataset-dir <path>\s+Override the benchmark dataset directory for full runs/);
  assert.match(usageSource, /--custom <path>\s+Run a YAML-defined custom benchmark file/);
  assert.match(source, /from "\.\/bench-args\.js";/);
  assert.match(source, /async function runCustomBenchViaPackage\(parsed: ParsedBenchArgs\): Promise<boolean>/);
  assert.match(flagsSource, /function readBenchOptionValue\(argv: string\[\], flag: string\)/);
  assert.match(flagsSource, /function collectBenchmarks\(argv: string\[\]\): string\[\]/);
  assert.match(
    parserSource,
    /const benchmarkArgs =[\s\S]*action === "baseline"[\s\S]*action === "datasets"[\s\S]*action === "providers"[\s\S]*action === "runs"[\s\S]*args\.slice\(1\)[\s\S]*:\s*args;/
  );
  assert.match(parserSource, /const benchmarks = collectBenchmarks\(benchmarkArgs\);/);
  assert.match(flagsSource, /requires a value\./);
  assert.match(
    flagsSource,
    /const BENCH_VALUE_FLAGS = Object\.freeze\(\[[\s\S]*"--dataset-dir"[\s\S]*"--results-dir"[\s\S]*"--baselines-dir"[\s\S]*"--threshold"[\s\S]*"--custom"[\s\S]*"--format"[\s\S]*"--output"/
  );
  assert.match(
    flagsSource,
    /function isBenchValueFlag\(arg: string\): arg is BenchValueFlag \{\s*return BENCH_VALUE_FLAG_SET\.has\(arg\);\s*\}/
  );
  assert.match(parserSource, /datasetDir: datasetDir \? path\.resolve\(expandTilde\(datasetDir\)\) : undefined/);
  assert.match(parserSource, /custom: customRaw \? path\.resolve\(expandTilde\(customRaw\)\) : undefined/);
  assert.match(source, /resolveBenchDatasetDir\(\s*benchmarkId,\s*parsed\.quick,\s*parsed\.datasetDir/s);
  assert.match(source, /if \(parsed\.custom\) \{/);
  assert.match(source, /const outputDir = parsed\.resultsDir \?\? resolveBenchOutputDir\(\);/);
  assert.match(source, /const effectiveLimit = parsed\.publishedLimit \?\? \(parsed\.quick \? 1 : undefined\);/);
  assert.match(source, /\.\.\.\(effectiveLimit !== undefined \? \{ limit: effectiveLimit \} : \{\}\),/);
  assert.match(source, /\.\.\.\(parsed\.publishedSeed !== undefined \? \{ seed: parsed\.publishedSeed \} : \{\}\),/);
  assert.match(source, /const customBenchmarkIds: string\[\] = \[\];/);
  assert.match(source, /customBenchmarkIds\.push\(result\.meta\.benchmark\);/);
  assert.match(source, /benchmarkIds: \[\.\.\.new Set\(customBenchmarkIds\)\]/);
  assert.match(source, /const datasetDir = resolveBenchDatasetDir\(/);
  assert.doesNotMatch(source, /full benchmark runs for "\$\{benchmarkId\}" require dataset files/);
  assert.match(source, /const runtime = await resolvePackageBenchRuntime\(/);
  assert.match(source, /const plans = await buildPackageBenchExecutionPlans\(/);
  assert.match(source, /const system = await plan\.createAdapter\(plan\.runtime\.adapterOptions\);/);
  assert.match(source, /remnicConfig: plan\.runtime\.effectiveRemnicConfig,/);
  assert.match(source, /result\.config\.remnicConfig = plan\.runtime\.remnicConfig;/);
  assert.match(source, /writeBenchReproManifestForPackageRun/);
  assert.match(source, /writeBenchmarkReproManifest/);
  assert.match(source, /WARNING: failed to write reproducibility manifest/);
});

test("parseBenchArgs supports custom benchmark files without counting them as benchmark ids", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["run", "--custom", "~/benchmarks/custom.yaml"]);

  assert.match(parsed.custom ?? "", /benchmarks[\/\\]custom\.yaml$/);
  assert.deepEqual(parsed.benchmarks, []);
});

test("bench CLI exposes runtime profile and provider-backed run surfaces", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const usageSource = await readFile("packages/remnic-cli/src/bench-usage.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(usageSource, /--runtime-profile <baseline\|real\|openclaw-chain\|local-lab>/);
  assert.match(usageSource, /--matrix <profiles>/);
  assert.match(usageSource, /--remnic-config <path>/);
  assert.match(usageSource, /--openclaw-config <path>/);
  assert.match(usageSource, /--model-source <plugin\|gateway>/);
  assert.match(usageSource, /--gateway-agent-id <id>/);
  assert.match(usageSource, /--fast-gateway-agent-id <id>/);
  assert.match(usageSource, /--system-provider <openai\|anthropic\|ollama\|litellm\|local-llm\|codex-cli\|claude-cli>/);
  assert.match(usageSource, /--system-model <model>/);
  assert.match(usageSource, /--judge-provider <openai\|anthropic\|ollama\|litellm\|local-llm\|codex-cli\|claude-cli>/);
  assert.match(usageSource, /--judge-model <model>/);
  assert.match(usageSource, /remnic bench run --quick longmemeval --runtime-profile baseline/);
  assert.match(usageSource, /remnic bench run longmemeval --runtime-profile real --remnic-config/);
  assert.match(usageSource, /remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config/);
  assert.match(usageSource, /remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model/);
  assert.match(usageSource, /remnic bench run longmemeval --matrix baseline,real,openclaw-chain/);
  assert.match(usageSource, /--local-lab-manifest <path>/);

  assert.match(
    parserSource,
    /export type BenchRuntimeProfile = "baseline" \| "real" \| "openclaw-chain" \| "local-lab";/
  );
  assert.match(parserSource, /runtimeProfile\?: BenchRuntimeProfile;/);
  assert.match(parserSource, /matrixProfiles\?: BenchRuntimeProfile\[];/);
  assert.match(parserSource, /systemProvider\?: BuiltInProvider;/);
  assert.match(parserSource, /judgeProvider\?: BuiltInProvider;/);
  assert.match(parserSource, /const runtimeProfileRaw = readBenchOptionValue\(args, "--runtime-profile"\);/);
  assert.match(parserSource, /const matrixRaw = readBenchOptionValue\(args, "--matrix"\);/);
  assert.match(parserSource, /const remnicConfigRaw = readBenchOptionValue\(args, "--remnic-config"\);/);
  assert.match(parserSource, /const openclawConfigRaw = readBenchOptionValue\(args, "--openclaw-config"\);/);
  assert.match(parserSource, /const systemProviderRaw = readBenchOptionValue\(args, "--system-provider"\);/);
  assert.match(parserSource, /const judgeProviderRaw = readBenchOptionValue\(args, "--judge-provider"\);/);
  assert.match(readme, /remnic bench run --quick longmemeval --runtime-profile baseline/);
  assert.match(readme, /remnic bench run longmemeval --runtime-profile real --remnic-config/);
  assert.match(readme, /remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config/);
});

test("parseBenchArgs supports runtime profiles, provider-backed runs, and matrix mode", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--runtime-profile",
    "openclaw-chain",
    "--openclaw-config",
    "~/.openclaw/openclaw.json",
    "--model-source",
    "gateway",
    "--gateway-agent-id",
    "memory-primary",
    "--fast-gateway-agent-id",
    "memory-fast",
    "--system-provider",
    "openai",
    "--system-model",
    "gpt-5.4-mini",
    "--system-base-url",
    "http://localhost:4000/v1",
    "--judge-provider",
    "anthropic",
    "--judge-model",
    "claude-sonnet-4-5",
    "--judge-base-url",
    "http://localhost:4100",
    "--matrix",
    "baseline,real,openclaw-chain",
  ]);

  assert.equal(parsed.action, "run");
  assert.deepEqual(parsed.benchmarks, ["longmemeval"]);
  assert.equal(parsed.runtimeProfile, "openclaw-chain");
  assert.deepEqual(parsed.matrixProfiles, ["baseline", "real", "openclaw-chain"]);
  assert.equal(parsed.modelSource, "gateway");
  assert.equal(parsed.gatewayAgentId, "memory-primary");
  assert.equal(parsed.fastGatewayAgentId, "memory-fast");
  assert.equal(parsed.systemProvider, "openai");
  assert.equal(parsed.systemModel, "gpt-5.4-mini");
  assert.equal(parsed.judgeProvider, "anthropic");
  assert.equal(parsed.judgeModel, "claude-sonnet-4-5");
  assert.match(parsed.openclawConfigPath ?? "", /openclaw\.json$/);
  assert.match(parsed.systemBaseUrl ?? "", /4000\/v1$/);
  assert.match(parsed.judgeBaseUrl ?? "", /4100$/);
});

test("bench compare routes through stored package results with threshold and results-dir options", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /compareResults,/);
  assert.match(source, /loadBenchmarkResult,/);
  assert.match(source, /resolveBenchmarkResultReference,/);
  assert.match(source, /async function compareBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /if \(parsed\.action === "compare"\) \{\s*await compareBenchPackageResults\(parsed\);/s);
  assert.match(source, /compare requires exactly two stored result references/i);
  assert.match(source, /parsed\.resultsDir \?\? resolveBenchOutputDir\(\)/);
  assert.match(source, /compareResults\(\s*baseline,\s*candidate,\s*parsed\.threshold \?\? 0\.05/s);
  assert.match(source, /benchmark mismatch: \$\{baseline\.meta\.benchmark\} vs \$\{candidate\.meta\.benchmark\}/);
  assert.match(
    parserSource,
    /export type BenchAction =[\s\S]*"datasets"[\s\S]*"runs"[\s\S]*"results"[\s\S]*"baseline"[\s\S]*"export"[\s\S]*"publish"[\s\S]*"check"[\s\S]*"report"[\s\S]*"attribute"[\s\S]*"drift-gen";/
  );
  assert.match(parserSource, /const resultsDir = readBenchOptionValue\(args, "--results-dir"\);/);
  assert.match(parserSource, /const thresholdRaw = readBenchOptionValue\(args, "--threshold"\);/);
  assert.match(parserSource, /ERROR: --threshold must be a non-negative number\./);
  assert.match(parserSource, /resultsDir: resultsDir \? path\.resolve\(expandTilde\(resultsDir\)\) : undefined/);
  assert.match(parserSource, /threshold,/);
});

test("bench results, baseline, and export route through the stored package results helpers", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  // Symbols are destructured from the optional bench loader inside each
  // command handler — a bare reference is enough to prove the CLI talks to
  // the package rather than re-implementing the helper locally.
  assert.match(source, /\blistBenchmarkBaselines\b/);
  assert.match(source, /\bloadBenchmarkBaseline\b/);
  assert.match(source, /\blistBenchmarkResults\b/);
  assert.match(source, /\brenderBenchmarkResultExport\b/);
  assert.match(source, /\bsaveBenchmarkBaseline\b/);
  assert.match(source, /async function showBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /async function manageBenchBaselines\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /async function exportBenchPackageResult\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /if \(parsed\.action === "results"\) \{\s*await showBenchPackageResults\(parsed\);/s);
  assert.match(source, /if \(parsed\.action === "baseline"\) \{\s*await manageBenchBaselines\(parsed\);/s);
  assert.match(source, /if \(parsed\.action === "export"\) \{\s*await exportBenchPackageResult\(parsed\);/s);
  assert.match(source, /baseline save <name> \[run\]/);
  assert.match(source, /bench export <run> --format <json\|csv\|html>/);
  assert.match(source, /const baselineDir = parsed\.baselinesDir \?\? defaultBenchmarkBaselineDir\(\)/);
  assert.match(source, /loadBenchmarkReportCardProvenance\(path\.dirname\(summary\.path\), result\.meta\.id\)/);
  assert.match(source, /const rendered = renderBenchmarkResultExport\(result, parsed\.format, \{/);
  assert.match(source, /ERROR: export requires --format json, csv, or html\./);
  assert.match(source, /printStoredBenchResultDetails\(result, summary\);/);
  assert.match(source, /printStoredBenchResultSummary\(result, summary\);/);
  assert.match(parserSource, /export type BenchBaselineAction = "save" \| "list";/);
  assert.match(parserSource, /export type BenchExportFormat = "json" \| "csv" \| "html";/);
  assert.match(parserSource, /const baselinesDir = readBenchOptionValue\(args, "--baselines-dir"\);/);
  assert.match(parserSource, /const formatRaw = readBenchOptionValue\(args, "--format"\);/);
  assert.match(parserSource, /const output = readBenchOptionValue\(args, "--output"\);/);
  assert.match(parserSource, /ERROR: --format must be "json", "csv", or "html"\./);
  assert.match(parserSource, /detail: args\.includes\("--detail"\),/);
  assert.match(parserSource, /baselinesDir: baselinesDir \? path\.resolve\(expandTilde\(baselinesDir\)\) : undefined/);
  assert.match(parserSource, /output: output \? path\.resolve\(expandTilde\(output\)\) : undefined/);
});

test("bench providers discovery is exposed as a package-backed CLI surface", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const usageSource = await readFile("packages/remnic-cli/src/bench-usage.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(source, /\bdiscoverAllProviders\b/);
  assert.match(
    usageSource,
    /Usage: remnic bench <list\|run\|published\|datasets\|runs\|compare\|results\|baseline\|export\|publish\|ui\|providers\|judge-calibrate\|attribute\|drift-gen\|coding>/,
  );
  assert.match(usageSource, /remnic bench providers discover/);
  assert.match(source, /async function discoverBenchProviders\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /providers discover does not accept positional arguments/);
  assert.match(source, /if \(parsed\.action === "providers"\) \{\s*await discoverBenchProviders\(parsed\);/s);
  assert.match(parserSource, /export type BenchAction =[\s\S]*"providers"[\s\S]*"check"[\s\S]*"report"[\s\S]*"drift-gen";/);
  assert.match(parserSource, /export type BenchProviderAction = "discover";/);
  assert.match(parserSource, /providerAction\?: BenchProviderAction;/);
  assert.match(parserSource, /first === "providers"/);
  assert.match(parserSource, /const providerAction =[\s\S]*args\[0\] === "discover"/);
  assert.match(readme, /remnic bench providers discover/);
});
/**
 * Issue #1573 PR3: judge-calibrate wires the persisted calibration state into
 * the run path so subsequent local artifacts carry the kappa, validates against
 * the package-aware benchmark set (not the static catalog), and only
 * calibrates from full runs. Source-text assertions mirror the rest of this
 * file's "CLI surface" style.
 */
test("judge-calibrate calibration reaches artifacts, resolves package benchmarks, and requires full runs (#1573)", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  // High/P1 (cursor + codex): loadJudgeCalibrationState must be a real
  // production consumer — the run path loads persisted calibration and
  // attaches it to the stored result so subsequent artifacts carry the kappa.
  assert.match(source, /loadJudgeCalibrationState\?:/);
  assert.match(source, /async function preparePersistedJudgeCalibrationAttachment\(/);
  assert.match(source, /const judgeCalibration = await preparePersistedJudgeCalibrationAttachment\(/);
  assert.match(source, /attachPreparedJudgeCalibration\(result, judgeCalibration\);/);
  assert.match(source, /calibrationBinding\.calibrationDir \?\?/);
  assert.match(source, /calibrationBinding\.calibrationLocalConfigSha256 !== state\.localJudgeConfigHash/);
  assert.match(source, /calibrationBinding\.calibrationFrontierConfigSha256 !== state\.frontierJudgeConfigHash/);
  const prepareIndex = source.indexOf(
    "const judgeCalibration = await preparePersistedJudgeCalibrationAttachment(",
  );
  const endpointPreflightIndex = source.indexOf(
    "await preflightLocalLabEndpointsIfNeeded(benchModule, plan);",
    prepareIndex,
  );
  const adapterIndex = source.indexOf("await plan.createAdapter({", prepareIndex);
  const benchmarkIndex = source.indexOf(
    "await benchModule.runBenchmark(benchmarkId, {",
    prepareIndex,
  );
  assert.ok(prepareIndex >= 0);
  assert.ok(prepareIndex < endpointPreflightIndex);
  assert.ok(prepareIndex < adapterIndex);
  assert.ok(prepareIndex < benchmarkIndex);
  assert.match(source, /judgeCalibration,/);

  // P2 (codex): persisted kappa is bound to the calibrated judge pair. The
  // judge-calibrate command records the local + frontier judge identities,
  // and the attach path refuses a stale kappa for a different judge pair.
  // Only the LOCAL judge match attaches — a frontier-tier run reusing the
  // stored frontier identity must NOT inherit the local judge's kappa
  // (cursor Low + codex P2 review).
  assert.match(source, /calibrationIdentities = \{/);
  assert.match(source, /writeJudgeCalibrationState\([\s\S]*result,[\s\S]*calibrationDir,[\s\S]*calibrationIdentities,[\s\S]*sourceResultId: loaded\.meta\.id,[\s\S]*localJudgeConfigHash,[\s\S]*frontierJudgeConfigHash/);
  assert.match(source, /getProviderBackedJudgePromptIdentity\(localJudgeConfig\)/);
  assert.match(source, /if \(!matchesLocal\) \{[\s\S]*if \(hasBothPins\)[\s\S]*return undefined;/);
  assert.match(source, /state\.localJudgeProvider !== undefined && state\.localJudgeModel !== undefined/);

  // P2 (codex): limited full runs (--limit 1) are rejected before calibrating
  // so a one-sample κ cannot be persisted.
  assert.match(source, /MIN_CALIBRATION_SOURCE_TASKS/);
  assert.match(source, /sourceTaskCount < bench\.MIN_CALIBRATION_SOURCE_TASKS/);

  // P2 (codex): judge-calibrate validates against the package-aware resolver
  // (same as `bench run`), not the static BENCHMARK_IDS catalog.
  assert.match(source, /const knownBenchmarkIds = await resolveKnownBenchmarkIds\(\);/);
  assert.match(source, /if \(!knownBenchmarkIds\.has\(benchmarkId\)\)/);

  // Calibration accepts only the explicitly pinned full result; it never
  // auto-selects a newer result or falls back from a partial source.
  assert.match(source, /\.filter\(\(entry\) => entry\.mode === "full"\)/);
  assert.match(source, /loaded\.meta\.status === "partial"/);

  // #1877: the operator pins source and both payload hashes before any call;
  // independent timeout controls are propagated to the two judge configs.
  assert.match(source, /const pinnedSourceId = parsed\.sourceResultId/);
  assert.match(source, /entry\.id === pinnedSourceId/);
  assert.match(source, /expectedAnswerSetHash: parsed\.expectedAnswerSetSha256/);
  assert.match(source, /orderedQuestionIdsHash !== parsed\.expectedQuestionIdListSha256/);
  assert.match(source, /requestTimeout: parsed\.localJudgeRequestTimeout/);
  assert.match(source, /max429WaitMs: parsed\.max429WaitMs/);
  assert.match(source, /disableThinking: parsed\.disableThinking/);
  assert.match(source, /timeoutMs: parsed\.frontierJudgeRequestTimeout/);
  assert.match(source, /checkpoint: \{/);
  assert.match(
    source,
    /\{[\s\S]*sourceResultId: loaded\.meta\.id,[\s\S]*orderedQuestionIdsHash,[\s\S]*localJudgeConfigHash,[\s\S]*frontierJudgeConfigHash[\s\S]*\}/,
  );
  assert.match(source, /bootstrap CI/);
});

test("custom calibration directory and both config hashes bind attachment end to end", async () => {
  const {
    attachPreparedJudgeCalibration,
    hashCalibrationProviderConfig,
    preparePersistedJudgeCalibrationAttachment,
  } = await import("../packages/remnic-cli/src/index.ts");
  const customDir = join(tmpdir(), "exact-private-calibration");
  const localConfig = {
    provider: "ollama",
    model: "judge",
    baseUrl: "http://127.0.0.1:11434",
    retryOptions: { timeoutMs: 60_000 },
    temperature: 0,
    seed: 47,
  };
  const localHash = hashCalibrationProviderConfig(localConfig);
  const frontierHash = "b".repeat(64);
  let loadedDir: string | undefined;
  const benchModule = {
    async loadJudgeCalibrationState(_benchmarkId: string, calibrationDir: string) {
      loadedDir = calibrationDir;
      return {
        kappa: 0.81,
        sampleSize: 2,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "ollama",
        localJudgeModel: "judge",
        frontierJudgeProvider: "openai",
        frontierJudgeModel: "gpt-5.6",
        localJudgeConfigHash: localHash,
        frontierJudgeConfigHash: frontierHash,
      };
    },
  };
  const result: {
    config: {
      benchmarkOptions?: Record<string, unknown>;
      judgeProvider: { provider: string; model: string };
    };
  } = { config: { judgeProvider: localConfig } };
  const prepared = await preparePersistedJudgeCalibrationAttachment(
    benchModule as never,
    "locomo",
    localConfig,
    {
      calibrationDir: customDir,
      calibrationLocalConfigSha256: localHash,
      calibrationFrontierConfigSha256: frontierHash,
    },
  );
  attachPreparedJudgeCalibration(result, prepared);
  assert.equal(loadedDir, customDir);
  assert.deepEqual(result.config.benchmarkOptions?.judgeCalibration, {
    kappa: 0.81,
    sampleSize: 2,
    threshold: 0.7,
    warning: false,
    localJudgeConfigHash: localHash,
    frontierJudgeConfigHash: frontierHash,
  });
});

test("frontier calibration config preserves timeout, 429, and thinking overlays", async () => {
  const { buildCalibrationFrontierJudgeConfig } = await import(
    "../packages/remnic-cli/src/index.ts"
  );

  assert.deepEqual(
    buildCalibrationFrontierJudgeConfig({
      judgeProvider: "claude-cli",
      judgeModel: "opus",
      judgeBaseUrl: "http://127.0.0.1:9000",
      judgeApiKey: "private",
      frontierJudgeRequestTimeout: 600_000,
      max429WaitMs: 30_000,
      disableThinking: true,
    }),
    {
      provider: "claude-cli",
      model: "opus",
      baseUrl: "http://127.0.0.1:9000",
      apiKey: "private",
      retryOptions: { timeoutMs: 600_000, max429WaitMs: 30_000 },
      disableThinking: true,
    },
  );
  assert.deepEqual(
    buildCalibrationFrontierJudgeConfig({
      judgeProvider: "openai",
      judgeModel: "gpt-5.6",
    }),
    { provider: "openai", model: "gpt-5.6" },
  );
  assert.throws(
    () => buildCalibrationFrontierJudgeConfig({ judgeProvider: "openai" }),
    /requires both --judge-provider and --judge-model/,
  );
});

test("Tier-F runbooks bind every run to the calibrated judge configuration", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const scripts = [
    {
      path: "scripts/bench/run-tierf-opus.sh",
      runtimeProfile: "baseline",
    },
    {
      path: "scripts/bench/run-tierf-opus-real.sh",
      runtimeProfile: "real",
    },
  ] as const;

  assert.match(source, /localLabManifestPath: parsed\.localLabManifestPath/);
  assert.match(source, /bench\.resolveLocalLabJudgeProviderConfig\(\{/);

  for (const config of scripts) {
    const script = await readFile(config.path, "utf8");
    assert.match(
      script,
      /CALIBRATION_DIR="\$\{TIERF_CALIBRATION_DIR:-\$HOME\/\.remnic\/bench\/build-week-2026\/calibration\}"/,
    );
    assert.match(script, /CALIBRATION_DIR="\$\{CALIBRATION_DIR\/#\\~\/\$HOME\}"/);
    assert.match(script, /CALIBRATION_DIR="\$PWD\/\$CALIBRATION_DIR"/);
    const normalizationStart = script.indexOf('CALIBRATION_DIR="${TIERF_CALIBRATION_DIR:');
    const tildeExpansionEnd = script.indexOf("\nfi\n", normalizationStart);
    const normalizationEnd = script.indexOf("\nfi\n", tildeExpansionEnd + 1) + 4;
    assert.ok(
      normalizationStart >= 0 &&
        tildeExpansionEnd > normalizationStart &&
        normalizationEnd > tildeExpansionEnd,
    );
    const normalizationSource = script.slice(normalizationStart, normalizationEnd);
    for (const [input, expected] of [
      ["relative-calibration", join(tmpdir(), "relative-calibration")],
      ["~/pinned-calibration", "/home/alice/pinned-calibration"],
      ["/tmp/absolute-calibration", "/tmp/absolute-calibration"],
    ]) {
      const probe = spawnSync(
        "bash",
        ["-c", `${normalizationSource}
printf '%s' "$CALIBRATION_DIR"`],
        {
          cwd: tmpdir(),
          encoding: "utf8",
          env: { ...process.env, HOME: "/home/alice", TIERF_CALIBRATION_DIR: input },
        },
      );
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, expected, `${config.path} must normalize ${input}`);
    }
    for (const benchmark of ["longmemeval", "locomo"]) {
      const commandStart = script.indexOf(`run ${benchmark} \\\n`);
      assert.ok(commandStart >= 0, `missing Tier-F ${benchmark} run command in ${config.path}`);
      const commandEnd = script.indexOf("2>&1 | tee", commandStart);
      assert.ok(
        commandEnd > commandStart,
        `missing Tier-F ${benchmark} command terminator in ${config.path}`,
      );
      const command = script.slice(commandStart, commandEnd);
      assert.match(command, new RegExp(`--runtime-profile ${config.runtimeProfile}`));
      assert.match(command, /--local-lab-manifest "\$MANIFEST"/);
      assert.match(command, /--request-timeout 180000/);
      assert.match(command, /"\$\{JUDGE_ARGS\[@\]\}"/);
      assert.match(command, /--calibration-dir "\$CALIBRATION_DIR"/);
      const hashPrefix = benchmark === "longmemeval" ? "LONGMEM" : "LOCOMO";
      assert.ok(
        command.includes(`--calibration-local-config-sha256 "\$${hashPrefix}_LOCAL_HASH"`),
        `${config.path} must bind ${benchmark} to its matching local calibration hash`,
      );
      assert.ok(
        command.includes(`--calibration-frontier-config-sha256 "\$${hashPrefix}_FRONTIER_HASH"`),
        `${config.path} must bind ${benchmark} to its matching frontier calibration hash`,
      );
      assert.ok(
        script.includes(
          `${hashPrefix}_LOCAL_HASH="$(node -p "require(process.argv[1]).localJudgeConfigHash" "\$CALIBRATION_DIR/${benchmark}.json")"`,
        ),
        `${config.path} must read ${benchmark}'s local hash from its matching state file`,
      );
      assert.ok(
        script.includes(
          `${hashPrefix}_FRONTIER_HASH="$(node -p "require(process.argv[1]).frontierJudgeConfigHash" "\$CALIBRATION_DIR/${benchmark}.json")"`,
        ),
        `${config.path} must read ${benchmark}'s frontier hash from its matching state file`,
      );
    }
  }

  const realScript = await readFile("scripts/bench/run-tierf-opus-real.sh", "utf8");
  assert.match(realScript, /local file="\$CALIBRATION_DIR\/\$\{benchmark\}\.json"/);
  assert.match(realScript, /math\.isfinite/);
  assert.match(realScript, /type\(d\.get\('bootstrapSamples'\)\) is int/);
  assert.match(realScript, /d\.get\('sourceResultId'\) == expected_source_result_id/);
  assert.match(realScript, /d\.get\('answerSetHash'\) == expected_answer_set_hash/);
  assert.match(realScript, /d\.get\('orderedQuestionIdsHash'\) == expected_ordered_question_ids_hash/);
  const calibrationPreflight = realScript.indexOf('step "preflight: calibration state');
  const providerAuthProbe = realScript.indexOf('step "preflight: claude auth');
  assert.ok(calibrationPreflight >= 0, "real-profile runner must preflight calibration state");
  assert.ok(
    providerAuthProbe > calibrationPreflight,
    "real-profile runner must validate calibration file shape before provider auth",
  );
});

test("Tier-F runbooks diagnose nonzero Claude auth probes before exiting", async () => {
  const scripts = [
    {
      path: "scripts/bench/run-tierf-opus.sh",
      nextStep: 'step "preflight: cached answers for calibration"',
    },
    {
      path: "scripts/bench/run-tierf-opus-real.sh",
      nextStep: 'step "full LongMemEval',
    },
  ] as const;
  const mockBin = mkdtempSync(join(tmpdir(), "remnic-tierf-auth-probe-"));

  try {
    writeFileSync(
      join(mockBin, "timeout"),
      "#!/usr/bin/env bash\nprintf 'Not logged in · Please run /login\\n' >&2\nexit 1\n",
      { mode: 0o755 },
    );

    for (const config of scripts) {
      const script = await readFile(config.path, "utf8");
      const authStart = script.indexOf("if ! AUTH_OUT=");
      const authEnd = script.indexOf(config.nextStep, authStart);
      assert.ok(authStart >= 0 && authEnd > authStart, `missing auth probe in ${config.path}`);
      const probe = spawnSync("bash", ["-c", `set -euo pipefail\n${script.slice(authStart, authEnd)}`], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${mockBin}:${process.env.PATH ?? ""}` },
      });

      assert.equal(probe.status, 2, `${config.path}: ${probe.stderr}`);
      assert.match(probe.stderr, /claude probe: Not logged in · Please run \/login/);
      assert.match(probe.stderr, /BLOCKED: claude CLI probe failed\. Run: claude auth login/);
    }
  } finally {
    rmSync(mockBin, { recursive: true, force: true });
  }
});

test("real Tier-F preflight rejects unpinned or malformed calibration provenance", async () => {
  const realScript = await readFile("scripts/bench/run-tierf-opus-real.sh", "utf8");
  const preflightStart = realScript.indexOf("preflight_calibration_state() {");
  const preflightEnd = realScript.indexOf('LONGMEM_LOCAL_HASH="', preflightStart);
  assert.ok(preflightStart >= 0 && preflightEnd > preflightStart);
  const preflightSource = realScript.slice(preflightStart, preflightEnd);
  assert.match(preflightSource, /preflight_calibration_state locomo/);
  assert.match(preflightSource, /preflight_calibration_state longmemeval/);
  const calibrationDir = mkdtempSync(join(tmpdir(), "remnic-tierf-calibration-provenance-"));
  const baseState = {
    localJudgeProvider: "ollama",
    localJudgeModel: "qwen2.5-7b-32k:latest",
    frontierJudgeProvider: "claude-cli",
    frontierJudgeModel: "opus",
    kappa: 0.8,
    sampleSize: 200,
    threshold: 0.7,
    warning: false,
    sliceQuestionIds: Array.from({ length: 200 }, (_, index) => `question-${index}`),
    confidenceInterval: { lower: 0.7, upper: 0.9, level: 0.95 },
    bootstrapSamples: 2_000,
    localJudgeConfigHash: "a".repeat(64),
    frontierJudgeConfigHash: "522bad1f22f4e031f5ab96fb13050edde876e190a45dbaf812cd2b87084d1a60",
  };
  const pinned = {
    locomo: {
      sourceResultId: "6e499698-6eaf-4a06-8a81-3d90dd867e57",
      answerSetHash: "a360907a60753d56bd066de88eb903464f1cb4f8fef89a930dd6a5f728f3ad81",
      orderedQuestionIdsHash: "9a603e17ed3c0eae426243364e6a98b5b4932bfe723ed3332408b825b9860869",
    },
    longmemeval: {
      sourceResultId: "a7ab6f70-5661-499e-b4b2-99bf0830368c",
      answerSetHash: "009e69a367b0d048f7db18bf51cde91b690a7520ce7246cee6f35ab9c5ca02e4",
      orderedQuestionIdsHash: "9778429495a91bb01db6899743d4476c0a4f1848789fce175ef2df90d100e3f5",
    },
  };
  const runPreflight = () =>
    spawnSync("bash", ["-c", `step() { :; }\n${preflightSource}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        CALIBRATION_DIR: calibrationDir,
        CALIBRATION_SAMPLE_SIZE: "200",
        EXPECTED_FRONTIER_JUDGE_CONFIG_HASH: "522bad1f22f4e031f5ab96fb13050edde876e190a45dbaf812cd2b87084d1a60",
        PYTHONOPTIMIZE: "1",
      },
    });

  try {
    for (const [benchmark, provenance] of Object.entries(pinned)) {
      writeFileSync(
        join(calibrationDir, `${benchmark}.json`),
        JSON.stringify({ ...baseState, ...provenance }),
      );
    }
    const validProbe = runPreflight();
    assert.equal(validProbe.status, 0, validProbe.stderr);

    for (const field of [
      "sourceResultId",
      "answerSetHash",
      "orderedQuestionIdsHash",
      "frontierJudgeConfigHash",
    ] as const) {
      writeFileSync(
        join(calibrationDir, "locomo.json"),
        JSON.stringify({ ...baseState, ...pinned.locomo, [field]: "unpinned" }),
      );
      const invalidProbe = runPreflight();
      assert.equal(invalidProbe.status, 3, `${field}: ${invalidProbe.stderr}`);
      assert.match(invalidProbe.stderr, /rerun judge-calibrate against the pinned answer source/);
    }

    writeFileSync(
      join(calibrationDir, "locomo.json"),
      JSON.stringify({
        ...baseState,
        ...pinned.locomo,
        sliceQuestionIds: [0, ...baseState.sliceQuestionIds.slice(1)],
      }),
    );
    const invalidSliceProbe = runPreflight();
    assert.equal(invalidSliceProbe.status, 3, invalidSliceProbe.stderr);
    assert.match(invalidSliceProbe.stderr, /rerun judge-calibrate against the pinned answer source/);
  } finally {
    rmSync(calibrationDir, { recursive: true, force: true });
  }
});

test("frontier and unrelated runs ignore local calibration state without requiring pins", async () => {
  const { preparePersistedJudgeCalibrationAttachment } = await import(
    "../packages/remnic-cli/src/index.ts"
  );
  const state = {
    kappa: 0.81,
    sampleSize: 2,
    threshold: 0.7,
    warning: false,
    localJudgeProvider: "ollama",
    localJudgeModel: "local-judge",
    frontierJudgeProvider: "openai",
    frontierJudgeModel: "gpt-5.6",
    localJudgeConfigHash: "a".repeat(64),
    frontierJudgeConfigHash: "b".repeat(64),
  };
  const benchModule = {
    async loadJudgeCalibrationState() {
      return state;
    },
  };
  for (const runJudgeProvider of [
    { provider: "openai", model: "gpt-5.6" },
    { provider: "anthropic", model: "claude-opus-4-6" },
  ]) {
    assert.equal(
      await preparePersistedJudgeCalibrationAttachment(
        benchModule as never,
        "locomo",
        runJudgeProvider,
        {},
      ),
      undefined,
    );
  }
});

test("identity-incomplete calibration state uses the resolved config hash for eligibility", async () => {
  const {
    hashCalibrationProviderConfig,
    preparePersistedJudgeCalibrationAttachment,
  } = await import("../packages/remnic-cli/src/index.ts");
  const localConfig = {
    provider: "ollama",
    model: "local-judge",
    baseUrl: "http://127.0.0.1:11434",
    temperature: 0,
  };
  const localHash = hashCalibrationProviderConfig(localConfig);
  const frontierHash = "b".repeat(64);
  const benchModule = {
    async loadJudgeCalibrationState() {
      return {
        kappa: 0.81,
        sampleSize: 200,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "ollama",
        localJudgeConfigHash: localHash,
        frontierJudgeConfigHash: frontierHash,
      };
    },
  };
  const pins = {
    calibrationLocalConfigSha256: localHash,
    calibrationFrontierConfigSha256: frontierHash,
  };

  assert.equal(
    await preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "locomo",
      { provider: "openai", model: "gpt-5.6" },
      {},
    ),
    undefined,
  );
  await assert.rejects(
    () => preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "locomo",
      { provider: "openai", model: "gpt-5.6" },
      pins,
    ),
    /refusing to ignore explicit pins/,
  );
  await assert.rejects(
    () => preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "locomo",
      localConfig,
      {},
    ),
    /are required to attach/,
  );
  const prepared = await preparePersistedJudgeCalibrationAttachment(
    benchModule as never,
    "locomo",
    localConfig,
    pins,
  );
  assert.equal(prepared?.localJudgeConfigHash, localHash);
  assert.equal(prepared?.frontierJudgeConfigHash, frontierHash);
});

test("AMA-Bench recommended protocol never inherits default-protocol calibration", async () => {
  const {
    hashCalibrationProviderConfig,
    preparePersistedJudgeCalibrationAttachment,
  } = await import("../packages/remnic-cli/src/index.ts");
  const localConfig = {
    provider: "ollama",
    model: "local-judge",
    baseUrl: "http://127.0.0.1:11434",
    temperature: 0,
  };
  const localHash = hashCalibrationProviderConfig(localConfig);
  const frontierHash = "b".repeat(64);
  let loadCalls = 0;
  const benchModule = {
    async loadJudgeCalibrationState() {
      loadCalls += 1;
      return {
        kappa: 0.81,
        sampleSize: 200,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "ollama",
        localJudgeModel: "local-judge",
        localJudgeConfigHash: localHash,
        frontierJudgeConfigHash: frontierHash,
      };
    },
  };
  const pins = {
    calibrationLocalConfigSha256: localHash,
    calibrationFrontierConfigSha256: frontierHash,
  };

  assert.equal(
    await preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "ama-bench",
      localConfig,
      { amaBenchJudgeProtocol: "recommended" },
    ),
    undefined,
  );
  await assert.rejects(
    () => preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "ama-bench",
      localConfig,
      { ...pins, amaBenchJudgeProtocol: "recommended" },
    ),
    /cannot attach default-protocol judge calibration/,
  );
  assert.equal(loadCalls, 0);

  const prepared = await preparePersistedJudgeCalibrationAttachment(
    benchModule as never,
    "ama-bench",
    localConfig,
    { ...pins, amaBenchJudgeProtocol: "default" },
  );
  assert.equal(prepared?.localJudgeConfigHash, localHash);
  assert.equal(loadCalls, 1);
});

test("explicit calibration pins fail closed when state is unavailable or targets another judge", async () => {
  const { preparePersistedJudgeCalibrationAttachment } = await import(
    "../packages/remnic-cli/src/index.ts"
  );
  const localHash = "a".repeat(64);
  const frontierHash = "b".repeat(64);
  const pins = {
    calibrationLocalConfigSha256: localHash,
    calibrationFrontierConfigSha256: frontierHash,
  };
  let loadCalls = 0;
  let benchmarkCalls = 0;
  let modelCalls = 0;
  const unavailableBenchModule = {
    async loadJudgeCalibrationState() {
      loadCalls += 1;
      return undefined;
    },
  };
  const guardedRun = async (
    benchModule: object,
    binding: {
      calibrationLocalConfigSha256?: string;
      calibrationFrontierConfigSha256?: string;
    },
  ) => {
    const prepared = await preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "locomo",
      { provider: "ollama", model: "local-judge" },
      binding,
    );
    benchmarkCalls += 1;
    modelCalls += 1;
    return prepared;
  };

  await assert.rejects(
    () => guardedRun(unavailableBenchModule, pins),
    /no valid calibration state could be loaded/,
  );
  await assert.rejects(
    () => guardedRun({}, pins),
    /no valid calibration state could be loaded/,
  );
  assert.equal(
    await guardedRun(unavailableBenchModule, {}),
    undefined,
  );
  for (const binding of [
    { calibrationLocalConfigSha256: localHash },
    { calibrationFrontierConfigSha256: frontierHash },
  ]) {
    await assert.rejects(
      () => guardedRun(unavailableBenchModule, binding),
      /must be supplied together/,
    );
  }
  assert.equal(loadCalls, 2);

  const localStateBenchModule = {
    async loadJudgeCalibrationState() {
      return {
        kappa: 0.81,
        sampleSize: 200,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "ollama",
        localJudgeModel: "different-local-judge",
        frontierJudgeProvider: "openai",
        frontierJudgeModel: "gpt-5.6",
        localJudgeConfigHash: localHash,
        frontierJudgeConfigHash: frontierHash,
      };
    },
  };
  await assert.rejects(
    () => guardedRun(localStateBenchModule, pins),
    /refusing to ignore explicit pins/,
  );
  assert.equal(benchmarkCalls, 1);
  assert.equal(modelCalls, 1);
});

test("missing, stale, and resolved-config calibration failures occur before benchmark or model calls", async () => {
  const {
    hashCalibrationProviderConfig,
    preparePersistedJudgeCalibrationAttachment,
  } = await import("../packages/remnic-cli/src/index.ts");
  const localConfig = {
    provider: "ollama",
    model: "local-judge",
    baseUrl: "http://127.0.0.1:11434",
    retryOptions: { timeoutMs: 60_000 },
    temperature: 0,
    seed: 47,
  };
  const localHash = hashCalibrationProviderConfig(localConfig);
  const frontierHash = "b".repeat(64);
  const benchModule = {
    async loadJudgeCalibrationState() {
      return {
        kappa: 0.81,
        sampleSize: 2,
        threshold: 0.7,
        warning: false,
        localJudgeProvider: "ollama",
        localJudgeModel: "local-judge",
        frontierJudgeProvider: "openai",
        frontierJudgeModel: "gpt-5.6",
        localJudgeConfigHash: localHash,
        frontierJudgeConfigHash: frontierHash,
      };
    },
  };
  let benchmarkCalls = 0;
  let modelCalls = 0;
  const guardedRun = async (
    runJudgeProvider: typeof localConfig,
    binding: {
      calibrationLocalConfigSha256?: string;
      calibrationFrontierConfigSha256?: string;
    },
  ) => {
    const prepared = await preparePersistedJudgeCalibrationAttachment(
      benchModule as never,
      "locomo",
      runJudgeProvider,
      binding,
    );
    benchmarkCalls += 1;
    modelCalls += 1;
    return prepared;
  };

  await assert.rejects(() => guardedRun(localConfig, {}), /are required to attach/);
  await assert.rejects(
    () => guardedRun(localConfig, {
      calibrationLocalConfigSha256: "c".repeat(64),
      calibrationFrontierConfigSha256: frontierHash,
    }),
    /configuration hash mismatch/,
  );
  for (const changedConfig of [
    { ...localConfig, baseUrl: "http://127.0.0.1:22434" },
    { ...localConfig, retryOptions: { timeoutMs: 120_000 } },
    { ...localConfig, temperature: 0.1 },
    { ...localConfig, seed: 48 },
  ]) {
    await assert.rejects(
      () => guardedRun(changedConfig, {
        calibrationLocalConfigSha256: localHash,
        calibrationFrontierConfigSha256: frontierHash,
      }),
      /Resolved run judge configuration hash mismatch/,
    );
  }
  assert.equal(benchmarkCalls, 0);
  assert.equal(modelCalls, 0);

  const prepared = await guardedRun(localConfig, {
    calibrationLocalConfigSha256: localHash,
    calibrationFrontierConfigSha256: frontierHash,
  });
  assert.ok(prepared);
  assert.equal(benchmarkCalls, 1);
  assert.equal(modelCalls, 1);
});

test("bench run exits non-zero after a mixed success/failure run", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");
  const datasetDir = await mkdtemp(path.join(os.tmpdir(), "remnic-empty-locomo-dataset-"));
  const resultsDir = await mkdtemp(path.join(os.tmpdir(), "remnic-mixed-bench-results-"));

  try {
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "tsx",
        "packages/remnic-cli/src/index.ts",
        "bench",
        "run",
        "taxonomy-accuracy",
        "locomo",
        "--dataset-dir",
        datasetDir,
        "--results-dir",
        resultsDir,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    assert.equal(
      result.status,
      1,
      `expected mixed benchmark run to exit 1\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /Benchmark: taxonomy-accuracy/);
    assert.match(result.stderr, /benchmark "locomo" failed/);
    assert.match(result.stderr, /Failed benchmarks: locomo/);
  } finally {
    rmSync(datasetDir, { recursive: true, force: true });
    rmSync(resultsDir, { recursive: true, force: true });
  }
});

test("bench surface retains local UI compatibility alongside providers discovery", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(parserSource, /\| "ui"/);
  assert.match(parserSource, /first === "ui"/);
  assert.match(source, /ui\s+Launch the local benchmark overview UI/);
  assert.match(
    source,
    /if \(parsed\.action === "ui"\) \{\s*await launchBenchUi\(parsed\.resultsDir \?\? resolveBenchOutputDir\(\)\);\s*return;\s*\}/s
  );
});

test("bench datasets and runs surfaces are exposed through parser, help text, and README", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const usageSource = await readFile("packages/remnic-cli/src/bench-usage.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(parserSource, /\| "datasets"/);
  assert.match(parserSource, /\| "runs"/);
  assert.match(parserSource, /export type BenchDatasetAction = "download" \| "status";/);
  assert.match(parserSource, /export type BenchRunAction = "list" \| "show" \| "delete";/);
  assert.match(parserSource, /datasetAction\?: BenchDatasetAction;/);
  assert.match(parserSource, /runAction\?: BenchRunAction;/);
  assert.match(parserSource, /first === "datasets"/);
  assert.match(parserSource, /first === "runs"/);
  assert.match(usageSource, /datasets download \[benchmark\.\.\.\]/);
  assert.match(usageSource, /datasets status/);
  assert.match(usageSource, /runs list/);
  assert.match(usageSource, /runs show <run>/);
  assert.match(usageSource, /runs delete <run\.\.\.>/);
  assert.match(source, /async function manageBenchDatasets\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /async function manageBenchRuns\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /if \(parsed\.action === "datasets"\) \{\s*await manageBenchDatasets\(parsed\);/s);
  assert.match(source, /if \(parsed\.action === "runs"\) \{\s*await manageBenchRuns\(parsed\);/s);
  assert.match(readme, /remnic bench datasets status/);
  assert.match(readme, /remnic bench datasets download longmemeval/);
  assert.match(readme, /remnic bench runs list/);
  assert.match(readme, /remnic bench runs show candidate-run --detail/);
  assert.match(readme, /remnic bench runs delete candidate-run/);
});

test("parseBenchArgs supports datasets download and runs show aliases", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const datasets = parseBenchArgs(["datasets", "download", "longmemeval", "--json"]);
  assert.equal(datasets.action, "datasets");
  assert.equal(datasets.datasetAction, "download");
  assert.deepEqual(datasets.benchmarks, ["longmemeval"]);
  assert.equal(datasets.json, true);

  const runs = parseBenchArgs(["runs", "show", "candidate-run", "--detail"]);
  assert.equal(runs.action, "runs");
  assert.equal(runs.runAction, "show");
  assert.deepEqual(runs.benchmarks, ["candidate-run"]);
  assert.equal(runs.detail, true);
});

test("parseBenchArgs supports the providers discovery surface", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["providers", "discover", "--json"]);

  assert.equal(parsed.action, "providers");
  assert.equal(parsed.providerAction, "discover");
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.benchmarks, []);
});

test("parseBenchArgs preserves unexpected trailing providers args for CLI validation", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["providers", "discover", "foo"]);

  assert.equal(parsed.action, "providers");
  assert.equal(parsed.providerAction, "discover");
  assert.deepEqual(parsed.benchmarks, ["foo"]);
});

test("bench providers discover rejects unexpected trailing positional args", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");
  const cliEntry = pathToFileURL(join(repoRoot, "packages/remnic-cli/src/index.ts")).href;

  interface StubHandle {
    cleanup: () => void;
  }

  // Stub a workspace package's dist entry if it doesn't exist, so the
  // CLI's dynamic imports resolve even when the monorepo hasn't been
  // built in CI. Each stub tracks what it created so we restore the
  // pre-test filesystem state in the finally block.
  const stubWorkspacePackage = (packageName: string, moduleBody: string): StubHandle => {
    const linkRoot = join(repoRoot, "packages/remnic-cli/node_modules", packageName);
    const moduleRoot = existsSync(linkRoot) ? realpathSync(linkRoot) : linkRoot;
    const distDir = join(moduleRoot, "dist");
    const entry = join(distDir, "index.js");
    const packageJson = join(moduleRoot, "package.json");
    const needsEntry = !existsSync(entry);
    const createdLinkRoot = !existsSync(linkRoot);
    const createdPackageJson = needsEntry && !existsSync(packageJson);
    const createdDistDir = needsEntry && !existsSync(distDir);

    if (needsEntry) {
      mkdirSync(distDir, { recursive: true });
      if (createdPackageJson) {
        writeFileSync(
          packageJson,
          JSON.stringify({
            name: packageName,
            type: "module",
            exports: { ".": "./dist/index.js" },
          })
        );
      }
      writeFileSync(entry, moduleBody);
    }

    return {
      cleanup: () => {
        if (!needsEntry) return;
        rmSync(entry, { force: true });
        if (createdDistDir) rmSync(distDir, { recursive: true, force: true });
        if (createdPackageJson) rmSync(packageJson, { force: true });
        if (createdLinkRoot) rmSync(moduleRoot, { recursive: true, force: true });
      },
    };
  };

  const stubs: StubHandle[] = [
    stubWorkspacePackage(
      "@remnic/bench",
      `
export function compareResults() {}
export async function buildBenchmarkPublishFeed() { return { target: "remnic-ai", generatedAt: new Date(0).toISOString(), benchmarks: [] }; }
export function checkRegression() { return null; }
export function defaultBenchmarkBaselineDir() { return ""; }
export function defaultBenchmarkPublishPath() { return ""; }
export async function discoverAllProviders() { return []; }
export function getBenchmarkLowerIsBetter() { return new Set(); }
export async function listBenchmarkBaselines() { return []; }
export async function listBenchmarkResults() { return []; }
export async function loadBenchmarkBaseline() { return null; }
export async function runBenchSuite() { return null; }
export async function runExplain() { return null; }
export async function loadBaseline() { return null; }
export async function saveBaseline() { return null; }
export async function loadBenchmarkResult() { return null; }
export async function loadBenchmarkReportCardProvenance() { return {}; }
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function deleteBenchmarkResults() { return { deleted: [], missing: [] }; }
export async function writeBenchmarkPublishFeed() { return ""; }
`
    ),
    // The CLI lazily imports these optional adapter packages to
    // register themselves with the core registry. If their dist
    // builds are absent in CI, the import throws and crashes the
    // command under test — a no-op stub is enough to make the
    // registration path succeed.
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`
    ),
  ];

  const originalExit = process.exit;
  const exitCalls: number[] = [];

  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`PROCESS_EXIT:${code ?? 0}`);
  }) as typeof process.exit;

  try {
    const { main } = await import(`${cliEntry}?test=${Date.now()}`);
    await assert.rejects(() => main(["bench", "providers", "discover", "foo"]), /PROCESS_EXIT:1/);
    assert.deepEqual(exitCalls, [1]);
  } finally {
    process.exit = originalExit;
    for (const stub of stubs) stub.cleanup();
  }
});

test("buildPackageBenchExecutionPlans fails loudly when an explicit --remnic-config path is missing", async () => {
  const { buildPackageBenchExecutionPlans } = await import(
    `../packages/remnic-cli/src/index.ts?missing-remnic-config=${Date.now()}`
  );

  const parsed = {
    action: "run",
    benchmarks: [],
    quick: true,
    all: false,
    json: false,
    detail: false,
    remnicConfigPath: "./definitely-missing-remnic-config.json",
  } as const;

  await assert.rejects(
    () =>
      buildPackageBenchExecutionPlans(
        {
          resolveBenchRuntimeProfile: async () => {
            throw new Error("resolveBenchRuntimeProfile should not be called");
          },
        } as any,
        parsed,
        ["real"]
      ),
    /Remnic config file not found:/
  );
});

test("buildPackageBenchExecutionPlans surfaces a missing package runtime hook before config-path validation", async () => {
  const { buildPackageBenchExecutionPlans } = await import(
    `../packages/remnic-cli/src/index.ts?missing-runtime-hook=${Date.now()}`
  );

  const parsed = {
    action: "run",
    benchmarks: [],
    quick: true,
    all: false,
    json: false,
    detail: false,
    remnicConfigPath: "./definitely-missing-remnic-config.json",
  } as const;

  await assert.rejects(
    () => buildPackageBenchExecutionPlans({} as any, parsed, ["real"]),
    /does not expose resolveBenchRuntimeProfile\(\)/
  );
});

test("buildBenchRuntimeProfileRequest keeps openclaw-chain on gateway routing in matrix mode", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");

  interface StubHandle {
    cleanup: () => void;
  }

  const stubWorkspacePackage = (packageName: string, moduleBody: string): StubHandle => {
    const linkRoot = join(repoRoot, "packages/remnic-cli/node_modules", packageName);
    const moduleRoot = existsSync(linkRoot) ? realpathSync(linkRoot) : linkRoot;
    const distDir = join(moduleRoot, "dist");
    const entry = join(distDir, "index.js");
    const packageJson = join(moduleRoot, "package.json");
    const needsEntry = !existsSync(entry);
    const createdLinkRoot = !existsSync(linkRoot);
    const createdPackageJson = needsEntry && !existsSync(packageJson);
    const createdDistDir = needsEntry && !existsSync(distDir);

    if (needsEntry) {
      mkdirSync(distDir, { recursive: true });
      if (createdPackageJson) {
        writeFileSync(
          packageJson,
          JSON.stringify({
            name: packageName,
            type: "module",
            exports: { ".": "./dist/index.js" },
          })
        );
      }
      writeFileSync(entry, moduleBody);
    }

    return {
      cleanup: () => {
        if (!needsEntry) return;
        rmSync(entry, { force: true });
        if (createdDistDir) rmSync(distDir, { recursive: true, force: true });
        if (createdPackageJson) rmSync(packageJson, { force: true });
        if (createdLinkRoot) rmSync(moduleRoot, { recursive: true, force: true });
      },
    };
  };

  const stubs: StubHandle[] = [
    stubWorkspacePackage(
      "@remnic/bench",
      `
export function compareResults() {}
export async function buildBenchmarkPublishFeed() { return { target: "remnic-ai", generatedAt: new Date(0).toISOString(), benchmarks: [] }; }
export function checkRegression() { return null; }
export function defaultBenchmarkBaselineDir() { return ""; }
export function defaultBenchmarkPublishPath() { return ""; }
export async function discoverAllProviders() { return []; }
export function getBenchmarkLowerIsBetter() { return new Set(); }
export async function listBenchmarkBaselines() { return []; }
export async function listBenchmarkResults() { return []; }
export async function loadBenchmarkBaseline() { return null; }
export async function runBenchSuite() { return null; }
export async function runExplain() { return null; }
export async function loadBaseline() { return null; }
export async function saveBaseline() { return null; }
export async function loadBenchmarkResult() { return null; }
export async function loadBenchmarkReportCardProvenance() { return {}; }
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function writeBenchmarkPublishFeed() { return ""; }
`
    ),
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`
    ),
  ];

  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-cli-openclaw-matrix-"));
  const openclawConfigPath = path.join(root, "openclaw.json");
  await writeFile(openclawConfigPath, JSON.stringify({ plugins: { entries: {} } }));

  try {
    const { buildBenchRuntimeProfileRequest } = await import(
      `../packages/remnic-cli/src/index.ts?matrix-runtime-request=${Date.now()}`
    );

    const parsed = {
      action: "run",
      benchmarks: ["longmemeval"],
      quick: true,
      all: false,
      json: false,
      detail: false,
      matrixProfiles: ["baseline", "openclaw-chain"],
      openclawConfigPath,
      modelSource: "gateway",
      gatewayAgentId: "memory-primary",
      fastGatewayAgentId: "memory-fast",
      systemProvider: "openai",
      systemModel: "gpt-5.4-mini",
      systemBaseUrl: "http://localhost:4000/v1",
      judgeProvider: "anthropic",
      judgeModel: "claude-sonnet-4-5",
      judgeBaseUrl: "http://localhost:4100",
    } as const;

    const baseline = buildBenchRuntimeProfileRequest(parsed, "baseline");
    const openclaw = buildBenchRuntimeProfileRequest(parsed, "openclaw-chain");

    assert.equal(baseline.systemProvider, "openai");
    assert.equal(baseline.systemModel, "gpt-5.4-mini");
    assert.equal(baseline.openclawConfigPath, undefined);
    assert.equal(openclaw.openclawConfigPath, openclawConfigPath);
    assert.equal(openclaw.systemProvider, undefined);
    assert.equal(openclaw.systemModel, undefined);
    assert.equal(openclaw.systemBaseUrl, undefined);
    assert.equal(openclaw.judgeProvider, "anthropic");
    assert.equal(openclaw.judgeModel, "claude-sonnet-4-5");
    assert.equal(openclaw.gatewayAgentId, "memory-primary");
    assert.equal(openclaw.fastGatewayAgentId, "memory-fast");
  } finally {
    for (const stub of stubs) stub.cleanup();
  }
});

test("buildBenchRuntimeProfileRequest resolves OPENAI_API_KEY only for an explicit OpenAI judge with flag precedence", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "env-openai-key";
  try {
    const { buildBenchRuntimeProfileRequest } = await import(
      `../packages/remnic-cli/src/index.ts?openai-key-boundary=${Date.now()}`
    );
    const base = {
      action: "run",
      benchmarks: ["memcorrect-v1"],
      quick: true,
      all: false,
      json: false,
      detail: false,
      judgeProvider: "openai",
    } as const;
    assert.equal(buildBenchRuntimeProfileRequest(base, "baseline").judgeApiKey, "env-openai-key");
    assert.equal(
      buildBenchRuntimeProfileRequest({ ...base, judgeApiKey: "explicit-key" }, "baseline").judgeApiKey,
      "explicit-key"
    );
    assert.equal(
      buildBenchRuntimeProfileRequest({ ...base, judgeProvider: "anthropic" }, "baseline").judgeApiKey,
      undefined
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("buildPackageBenchExecutionPlans preflights the full custom matrix before any adapter runs", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");

  interface StubHandle {
    cleanup: () => void;
  }

  const stubWorkspacePackage = (packageName: string, moduleBody: string): StubHandle => {
    const linkRoot = join(repoRoot, "packages/remnic-cli/node_modules", packageName);
    const moduleRoot = existsSync(linkRoot) ? realpathSync(linkRoot) : linkRoot;
    const distDir = join(moduleRoot, "dist");
    const entry = join(distDir, "index.js");
    const packageJson = join(moduleRoot, "package.json");
    const needsEntry = !existsSync(entry);
    const createdLinkRoot = !existsSync(linkRoot);
    const createdPackageJson = needsEntry && !existsSync(packageJson);
    const createdDistDir = needsEntry && !existsSync(distDir);

    if (needsEntry) {
      mkdirSync(distDir, { recursive: true });
      if (createdPackageJson) {
        writeFileSync(
          packageJson,
          JSON.stringify({
            name: packageName,
            type: "module",
            exports: { ".": "./dist/index.js" },
          })
        );
      }
      writeFileSync(entry, moduleBody);
    }

    return {
      cleanup: () => {
        if (!needsEntry) return;
        rmSync(entry, { force: true });
        if (createdDistDir) rmSync(distDir, { recursive: true, force: true });
        if (createdPackageJson) rmSync(packageJson, { force: true });
        if (createdLinkRoot) rmSync(moduleRoot, { recursive: true, force: true });
      },
    };
  };

  const stubs: StubHandle[] = [
    stubWorkspacePackage(
      "@remnic/bench",
      `
export function compareResults() {}
export async function buildBenchmarkPublishFeed() { return { target: "remnic-ai", generatedAt: new Date(0).toISOString(), benchmarks: [] }; }
export function checkRegression() { return null; }
export function defaultBenchmarkBaselineDir() { return ""; }
export function defaultBenchmarkPublishPath() { return ""; }
export async function discoverAllProviders() { return []; }
export function getBenchmarkLowerIsBetter() { return new Set(); }
export async function listBenchmarkBaselines() { return []; }
export async function listBenchmarkResults() { return []; }
export async function loadBenchmarkBaseline() { return null; }
export async function runBenchSuite() { return null; }
export async function runExplain() { return null; }
export async function loadBaseline() { return null; }
export async function saveBaseline() { return null; }
export async function loadBenchmarkResult() { return null; }
export async function loadBenchmarkReportCardProvenance() { return {}; }
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function writeBenchmarkPublishFeed() { return ""; }
`
    ),
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`
    ),
  ];

  try {
    const { buildPackageBenchExecutionPlans } = await import(
      `../packages/remnic-cli/src/index.ts?matrix-preflight=${Date.now()}`
    );

    const parsed = {
      action: "run",
      benchmarks: [],
      quick: true,
      all: false,
      json: false,
      detail: false,
    } as const;

    const plans = await buildPackageBenchExecutionPlans(
      {
        resolveBenchRuntimeProfile: async (options: { runtimeProfile?: string }) => ({
          profile: options.runtimeProfile ?? "baseline",
          remnicConfig: {},
          effectiveRemnicConfig: {},
          adapterOptions: {},
          systemProvider: null,
          judgeProvider: null,
        }),
        createLightweightAdapter: async () => {
          throw new Error("adapter construction should not happen during plan building");
        },
      },
      parsed,
      ["baseline", "real"]
    );

    assert.equal(plans, false);
  } finally {
    for (const stub of stubs) stub.cleanup();
  }
});

test("parseBenchArgs excludes --dataset-dir values from benchmark ids", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs(["run", "longmemeval", "--dataset-dir", "~/datasets/longmemeval"]);
  assert.deepEqual(parsed.benchmarks, ["longmemeval"]);
  assert.match(parsed.datasetDir ?? "", /datasets[\/\\]longmemeval$/);

  const optionFirst = parseBenchArgs(["run", "--dataset-dir", "/tmp/bench-dataset", "longmemeval"]);
  assert.deepEqual(optionFirst.benchmarks, ["longmemeval"]);
  assert.equal(optionFirst.datasetDir, "/tmp/bench-dataset");
});

test("parseBenchArgs supports compare-specific results-dir and threshold options", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "compare",
    "base-run",
    "candidate-run",
    "--results-dir",
    "~/bench-results",
    "--threshold",
    "0.2",
  ]);

  assert.equal(parsed.action, "compare");
  assert.deepEqual(parsed.benchmarks, ["base-run", "candidate-run"]);
  assert.match(parsed.resultsDir ?? "", /bench-results$/);
  assert.equal(parsed.threshold, 0.2);
});

test("parseBenchArgs supports results, baseline, and export surfaces", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const resultsArgs = parseBenchArgs(["results", "candidate-run", "--detail", "--results-dir", "~/bench-results"]);
  assert.equal(resultsArgs.action, "results");
  assert.deepEqual(resultsArgs.benchmarks, ["candidate-run"]);
  assert.equal(resultsArgs.detail, true);
  assert.match(resultsArgs.resultsDir ?? "", /bench-results$/);

  const baselineArgs = parseBenchArgs([
    "baseline",
    "save",
    "main",
    "candidate-run",
    "--baselines-dir",
    "~/bench-baselines",
  ]);
  assert.equal(baselineArgs.action, "baseline");
  assert.equal(baselineArgs.baselineAction, "save");
  assert.deepEqual(baselineArgs.benchmarks, ["main", "candidate-run"]);
  assert.match(baselineArgs.baselinesDir ?? "", /bench-baselines$/);

  const exportArgs = parseBenchArgs(["export", "candidate-run", "--format", "html", "--output", "./report.html"]);
  assert.equal(exportArgs.action, "export");
  assert.equal(exportArgs.format, "html");
  assert.match(exportArgs.output ?? "", /report\.html$/);

  const publishArgs = parseBenchArgs(["publish", "--target", "remnic-ai", "--output", "./benchmarks.json"]);
  assert.equal(publishArgs.action, "publish");
  assert.equal(publishArgs.target, "remnic-ai");
  assert.deepEqual(publishArgs.benchmarks, []);
  assert.match(publishArgs.output ?? "", /benchmarks\.json$/);
});

test("bench publish routes through the stored package feed helpers", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const flagsSource = await readFile("packages/remnic-cli/src/bench-flags.ts", "utf8");

  assert.match(source, /buildBenchmarkPublishFeed,/);
  assert.match(source, /defaultBenchmarkPublishPath,/);
  assert.match(source, /writeBenchmarkPublishFeed,/);
  assert.match(source, /async function publishBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /publish requires --target remnic-ai/);
  assert.match(source, /if \(feed\.benchmarks\.length === 0\) \{/);
  assert.match(source, /no publishable benchmark results found in \$\{resultsDir\}/);
  assert.match(source, /remnic-ai requires stored full runs for published benchmarks/);
  assert.match(
    source,
    /Published \$\{feed\.benchmarks\.length\} benchmark entries for \$\{parsed\.target\} to \$\{writtenPath\}/
  );
  assert.match(source, /if \(parsed\.action === "publish"\) \{\s*await publishBenchPackageResults\(parsed\);/s);
  assert.match(parserSource, /export type BenchPublishTarget = "remnic-ai";/);
  assert.match(flagsSource, /const BENCH_VALUE_FLAGS = Object\.freeze\(\[[\s\S]*"--target"/);
  assert.match(parserSource, /const targetRaw = readBenchOptionValue\(args, "--target"\);/);
  assert.match(parserSource, /ERROR: --target must be "remnic-ai"\./);
  assert.match(parserSource, /target,/);
});

test("parseBenchArgs rejects unknown bench publish targets", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["publish", "--target", "somewhere-else"]),
    /ERROR: --target must be "remnic-ai"\./
  );
});

// Issue #566 slice 5 and Codex CLI provider parity. `--provider`,
// `--system-provider`, and `--judge-provider` must all accept the same
// provider list (CLAUDE.md rule 52: allow-lists in lockstep). When
// the chosen provider is local-llm, a base URL is REQUIRED at the
// boundary — silent OpenAI fallback violates rule 51.
test("parseBenchArgs accepts --provider local-llm with --base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "published",
    "--name",
    "longmemeval",
    "--provider",
    "local-llm",
    "--base-url",
    "http://127.0.0.1:8080/v1",
    "--model",
    "qwen3-8b",
  ]);

  assert.equal(parsed.systemProvider, "local-llm");
  assert.equal(parsed.systemBaseUrl, "http://127.0.0.1:8080/v1");
  assert.equal(parsed.systemModel, "qwen3-8b");
});

test("parseBenchArgs rejects --provider local-llm without --base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["published", "--name", "longmemeval", "--provider", "local-llm", "--model", "qwen3-8b"]),
    /ERROR: --provider local-llm requires --base-url/
  );
});

test("parseBenchArgs rejects --system-provider local-llm without --system-base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["run", "longmemeval", "--system-provider", "local-llm", "--system-model", "qwen3-8b"]),
    /ERROR: --provider local-llm requires --base-url/
  );
});

test("parseBenchArgs rejects --judge-provider local-llm without --judge-base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["run", "longmemeval", "--judge-provider", "local-llm", "--judge-model", "qwen3-8b"]),
    /ERROR: --judge-provider local-llm requires --judge-base-url/
  );
});

test("parseBenchArgs rejects unknown providers across all three flags with listed options", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  // CLAUDE.md rule 52: the allow-list for --provider, --system-provider,
  // and --judge-provider must be identical. Using three explicit cases
  // (rather than a computed regex) keeps the assertions readable and
  // dodges a CodeQL "incomplete string escaping" finding from building
  // a regex out of a dash-containing flag name.
  assert.throws(
    () => parseBenchArgs(["published", "--name", "longmemeval", "--provider", "bogus", "--model", "m"]),
    /ERROR: --provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", "codex-cli", or "claude-cli"\./
  );
  assert.throws(
    () => parseBenchArgs(["run", "longmemeval", "--system-provider", "bogus", "--system-model", "m"]),
    /ERROR: --system-provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", "codex-cli", or "claude-cli"\./
  );
  assert.throws(
    () => parseBenchArgs(["run", "longmemeval", "--judge-provider", "bogus", "--judge-model", "m"]),
    /ERROR: --judge-provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", "codex-cli", or "claude-cli"\./
  );
});

test("CLI uses the package BenchmarkDefinition contract instead of a local benchmark metadata clone", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  // After the à-la-carte refactor, BenchmarkDefinition is a type-only
  // import (erased at compile time) and loadBenchDefinitionsFromPackage
  // goes through the optional-bench loader. The key semantic guarantee
  // is still that the CLI reuses the package's BenchmarkDefinition type
  // rather than re-defining its own shape.
  assert.match(source, /BenchmarkDefinition,?[\s\S]*?\} from "@remnic\/bench";/s);
  assert.match(
    source,
    /async function loadBenchDefinitionsFromPackage\(\): Promise<BenchmarkDefinition\[\] \| undefined>/
  );
  assert.match(source, /listBenchmarks\b/);
  assert.doesNotMatch(source, /interface PackageBenchDefinition/);
  assert.doesNotMatch(source, /listBenchmarks\?: \(\) => Promise<.*BenchmarkDefinition\[\].*\|/s);
});

test("legacy benchmark check/report reuse the normalized action args instead of re-slicing rest", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /parseBenchActionArgs,\s*\n\s*parseBenchArgs,/s);
  assert.match(source, /const benchAction = parseBenchActionArgs\(rest\);/);
  assert.match(source, /await cmdLegacyBenchmark\(parsed\.action,\s*benchAction\.args,\s*parsed\.json\);/);
  assert.doesNotMatch(source, /await cmdLegacyBenchmark\(parsed\.action,\s*rest\.slice\(1\),\s*parsed\.json\);/);
});

test(
  "offline CLI runs quick MemCorrect through the packaged MCP demo and writes scored MCP results",
  { timeout: 30_000 },
  () => {
    const resultsDir = mkdtempSync(join(tmpdir(), "remnic-cli-mcp-demo-"));
    const cliEntry = join(process.cwd(), "packages/remnic-cli/src/index.ts");
    const env = { ...process.env };
    env.NODE_OPTIONS = [env.NODE_OPTIONS, "--conditions=remnic-source"].filter(Boolean).join(" ");
    // This test executes live TypeScript sources; freshness of a pre-existing
    // dist artifact is unrelated to the child-process behavior under test.
    env.REMNIC_BENCH_ALLOW_STALE_DIST = "1";
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LITELLM_API_KEY", "REMNIC_BENCH_MCP_BEARER_TOKEN"]) {
      delete env[key];
    }
    try {
      const run = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          cliEntry,
          "bench",
          "run",
          "--quick",
          "memcorrect-v1",
          "--adapter",
          "mcp",
          "--mcp-demo",
          "--results-dir",
          resultsDir,
        ],
        { cwd: process.cwd(), env, encoding: "utf8", timeout: 25_000 }
      );
      assert.equal(run.status, 0, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
      const resultFiles = readdirSync(resultsDir)
        .filter((name) => name.endsWith(".json") && name !== "MANIFEST.json")
        .sort();
      const result = resultFiles
        .map((name) => JSON.parse(readFileSync(join(resultsDir, name), "utf8")) as Record<string, any>)
        .find((candidate) => candidate.meta?.benchmark === "memcorrect-v1");
      assert.ok(result, `no MemCorrect artifact found in ${resultFiles.join(", ")}`);
      assert.equal(result.meta.mode, "quick");
      assert.equal(result.config.adapterMode, "mcp");
      assert.ok(result.results.tasks.length > 0, "the MCP demo run must score at least one task");
      assert.equal(
        result.results.aggregates.uptake_at_next?.mean,
        1,
        "the synthetic MCP demo must apply the generated correction before the next recall"
      );
      assert.match(run.stdout, /Benchmark: memcorrect-v1/);
    } finally {
      rmSync(resultsDir, { recursive: true, force: true });
    }
  }
);
