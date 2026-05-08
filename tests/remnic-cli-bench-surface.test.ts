import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

test("remnic CLI source wires the new bench command and keeps benchmark as an alias", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /\| "bench"/);
  assert.match(source, /case "bench": \{/);
  assert.match(source, /case "benchmark": \{/);
  assert.match(source, /await cmdBench\(rest\);/);
  assert.match(source, /remnic bench <list\|run\|datasets\|runs\|compare\|results\|baseline\|export\|publish\|ui\|providers>/);
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
  assert.match(fallbackSource, /args\.push\("--lightweight", "--limit", "1"\)/);
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

test("--all selection resolves to runnable package benchmarks when package metadata is available", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");

  assert.match(source, /category === "ingestion"/);
  assert.match(source, /async function resolveAllBenchmarks\(\)/);
  assert.match(
    source,
    /packageBenchmarks\s*\n\s*\.filter\(\s*\(entry\) =>\s*entry\.runnerAvailable\s*\)/s,
  );
  assert.doesNotMatch(
    source,
    /packageBenchmarks[\s\S]*?entry\.meta\?\.category !== "ingestion"/,
  );
  assert.match(source, /let selectedBenchmarks = parsed\.all\s+\? await resolveAllBenchmarks\(\)/s);
  assert.match(source, /async function resolveKnownBenchmarkIds\(\): Promise<Set<string>>/);
  assert.match(source, /const knownBenchmarkIds = await resolveKnownBenchmarkIds\(\);/);
  assert.match(source, /selectedBenchmarks\.filter\(\(benchmarkId\) => !knownBenchmarkIds\.has\(benchmarkId\)\)/);
  assert.match(source, /no runnable benchmarks are available for --all in this install/i);
});

test("bench CLI validates and resolves explicit dataset overrides for full package runs", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /--dataset-dir <path>\s+Override the benchmark dataset directory for full runs/);
  assert.match(source, /--custom <path>\s+Run a YAML-defined custom benchmark file/);
  assert.match(source, /from "\.\/bench-args\.js";/);
  assert.match(source, /async function runCustomBenchViaPackage\(parsed: ParsedBenchArgs\): Promise<boolean>/);
  assert.match(parserSource, /function readBenchOptionValue\(argv: string\[\], flag: string\)/);
  assert.match(parserSource, /function collectBenchmarks\(argv: string\[\]\): string\[\]/);
  assert.match(
    parserSource,
    /const benchmarkArgs =[\s\S]*action === "baseline"[\s\S]*action === "datasets"[\s\S]*action === "providers"[\s\S]*action === "runs"[\s\S]*args\.slice\(1\)[\s\S]*:\s*args;/,
  );
  assert.match(parserSource, /const benchmarks = collectBenchmarks\(benchmarkArgs\);/);
  assert.match(parserSource, /requires a value\./);
  assert.match(parserSource, /arg === "--dataset-dir"[\s\S]*arg === "--results-dir"[\s\S]*arg === "--baselines-dir"[\s\S]*arg === "--threshold"[\s\S]*arg === "--custom"[\s\S]*arg === "--format"[\s\S]*arg === "--output"/);
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
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(source, /--runtime-profile <baseline\|real\|openclaw-chain>/);
  assert.match(source, /--matrix <profiles>/);
  assert.match(source, /--remnic-config <path>/);
  assert.match(source, /--openclaw-config <path>/);
  assert.match(source, /--model-source <plugin\|gateway>/);
  assert.match(source, /--gateway-agent-id <id>/);
  assert.match(source, /--fast-gateway-agent-id <id>/);
  assert.match(source, /--system-provider <openai\|anthropic\|ollama\|litellm\|local-llm\|codex-cli>/);
  assert.match(source, /--system-model <model>/);
  assert.match(source, /--judge-provider <openai\|anthropic\|ollama\|litellm\|local-llm\|codex-cli>/);
  assert.match(source, /--judge-model <model>/);
  assert.match(source, /remnic bench run --quick longmemeval --runtime-profile baseline/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile real --remnic-config/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile openclaw-chain --openclaw-config/);
  assert.match(source, /remnic bench run longmemeval --runtime-profile real --system-provider openai --system-model/);
  assert.match(source, /remnic bench run longmemeval --matrix baseline,real,openclaw-chain/);

  assert.match(parserSource, /export type BenchRuntimeProfile = "baseline" \| "real" \| "openclaw-chain";/);
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
  assert.match(parserSource, /export type BenchAction =[\s\S]*"datasets"[\s\S]*"runs"[\s\S]*"results"[\s\S]*"baseline"[\s\S]*"export"[\s\S]*"publish"[\s\S]*"check"[\s\S]*"report";/);
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
  assert.match(source, /const rendered = renderBenchmarkResultExport\(result, parsed\.format\);/);
  assert.match(source, /ERROR: export requires --format json, csv, or html\./);
  assert.match(source, /printBenchPackageSummary\(result, summary\.path, "Stored result"\);/);
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
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");
  const readme = await readFile("packages/remnic-cli/README.md", "utf8");

  assert.match(source, /\bdiscoverAllProviders\b/);
  assert.match(source, /Usage: remnic bench <list\|run\|published\|datasets\|runs\|compare\|results\|baseline\|export\|publish\|ui\|providers>/);
  assert.match(source, /remnic bench providers discover/);
  assert.match(source, /async function discoverBenchProviders\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /providers discover does not accept positional arguments/);
  assert.match(source, /if \(parsed\.action === "providers"\) \{\s*await discoverBenchProviders\(parsed\);/s);
  assert.match(parserSource, /export type BenchAction =[\s\S]*"providers"[\s\S]*"check"[\s\S]*"report";/);
  assert.match(parserSource, /export type BenchProviderAction = "discover";/);
  assert.match(parserSource, /providerAction\?: BenchProviderAction;/);
  assert.match(parserSource, /first === "providers"/);
  assert.match(parserSource, /const providerAction =[\s\S]*args\[0\] === "discover"/);
  assert.match(readme, /remnic bench providers discover/);
});

test("bench surface retains local UI compatibility alongside providers discovery", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(parserSource, /\| "ui"/);
  assert.match(parserSource, /first === "ui"/);
  assert.match(source, /ui\s+Launch the local benchmark overview UI/);
  assert.match(source, /if \(parsed\.action === "ui"\) \{\s*await launchBenchUi\(parsed\.resultsDir \?\? resolveBenchOutputDir\(\)\);\s*return;\s*\}/s);
});

test("bench datasets and runs surfaces are exposed through parser, help text, and README", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
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
  assert.match(source, /datasets download \[benchmark\.\.\.\]/);
  assert.match(source, /datasets status/);
  assert.match(source, /runs list/);
  assert.match(source, /runs show <run>/);
  assert.match(source, /runs delete <run\.\.\.>/);
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
  const stubWorkspacePackage = (
    packageName: string,
    moduleBody: string,
  ): StubHandle => {
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
          }),
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
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function deleteBenchmarkResults() { return { deleted: [], missing: [] }; }
export async function writeBenchmarkPublishFeed() { return ""; }
`,
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
`,
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`,
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
    await assert.rejects(
      () => main(["bench", "providers", "discover", "foo"]),
      /PROCESS_EXIT:1/,
    );
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
        ["real"],
      ),
    /Remnic config file not found:/,
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
    /does not expose resolveBenchRuntimeProfile\(\)/,
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

  const stubWorkspacePackage = (
    packageName: string,
    moduleBody: string,
  ): StubHandle => {
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
          }),
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
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function writeBenchmarkPublishFeed() { return ""; }
`,
    ),
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`,
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`,
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

test("buildPackageBenchExecutionPlans preflights the full custom matrix before any adapter runs", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(__dirname, "..");

  interface StubHandle {
    cleanup: () => void;
  }

  const stubWorkspacePackage = (
    packageName: string,
    moduleBody: string,
  ): StubHandle => {
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
          }),
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
export function renderBenchmarkResultExport() { return ""; }
export async function resolveBenchmarkResultReference() { return null; }
export async function saveBenchmarkBaseline() { return null; }
export async function writeBenchmarkPublishFeed() { return ""; }
`,
    ),
    stubWorkspacePackage(
      "@remnic/export-weclone",
      `
export const wecloneExportAdapter = { name: "weclone", fileExtension: "json", formatRecords: () => "" };
export function ensureWecloneExportAdapterRegistered() {}
export function synthesizeTrainingPairs() { return []; }
export function sweepPii(input) { return input; }
`,
    ),
    stubWorkspacePackage(
      "@remnic/import-weclone",
      `
export const wecloneImportAdapter = { name: "weclone", parse: async () => ({ turns: [], metadata: {} }) };
export function ensureWecloneImportAdapterRegistered() {}
`,
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
        resolveBenchRuntimeProfile: async (options) => ({
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
      ["baseline", "real"],
    );

    assert.equal(plans, false);
  } finally {
    for (const stub of stubs) stub.cleanup();
  }
});

test("parseBenchArgs excludes --dataset-dir values from benchmark ids", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--dataset-dir",
    "~/datasets/longmemeval",
  ]);
  assert.deepEqual(parsed.benchmarks, ["longmemeval"]);
  assert.match(parsed.datasetDir ?? "", /datasets[\/\\]longmemeval$/);

  const optionFirst = parseBenchArgs([
    "run",
    "--dataset-dir",
    "/tmp/bench-dataset",
    "longmemeval",
  ]);
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

  const resultsArgs = parseBenchArgs([
    "results",
    "candidate-run",
    "--detail",
    "--results-dir",
    "~/bench-results",
  ]);
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

  const exportArgs = parseBenchArgs([
    "export",
    "candidate-run",
    "--format",
    "html",
    "--output",
    "./report.html",
  ]);
  assert.equal(exportArgs.action, "export");
  assert.equal(exportArgs.format, "html");
  assert.match(exportArgs.output ?? "", /report\.html$/);

  const publishArgs = parseBenchArgs([
    "publish",
    "--target",
    "remnic-ai",
    "--output",
    "./benchmarks.json",
  ]);
  assert.equal(publishArgs.action, "publish");
  assert.equal(publishArgs.target, "remnic-ai");
  assert.deepEqual(publishArgs.benchmarks, []);
  assert.match(publishArgs.output ?? "", /benchmarks\.json$/);
});

test("bench publish routes through the stored package feed helpers", async () => {
  const source = await readFile("packages/remnic-cli/src/index.ts", "utf8");
  const parserSource = await readFile("packages/remnic-cli/src/bench-args.ts", "utf8");

  assert.match(source, /buildBenchmarkPublishFeed,/);
  assert.match(source, /defaultBenchmarkPublishPath,/);
  assert.match(source, /writeBenchmarkPublishFeed,/);
  assert.match(source, /async function publishBenchPackageResults\(parsed: ParsedBenchArgs\): Promise<void>/);
  assert.match(source, /publish requires --target remnic-ai/);
  assert.match(source, /if \(feed\.benchmarks\.length === 0\) \{/);
  assert.match(source, /no publishable benchmark results found in \$\{resultsDir\}/);
  assert.match(source, /remnic-ai requires stored full runs for published benchmarks/);
  assert.match(source, /Published \$\{feed\.benchmarks\.length\} benchmark entries for \$\{parsed\.target\} to \$\{writtenPath\}/);
  assert.match(source, /if \(parsed\.action === "publish"\) \{\s*await publishBenchPackageResults\(parsed\);/s);
  assert.match(parserSource, /export type BenchPublishTarget = "remnic-ai";/);
  assert.match(parserSource, /arg === "--target"/);
  assert.match(parserSource, /const targetRaw = readBenchOptionValue\(args, "--target"\);/);
  assert.match(parserSource, /ERROR: --target must be "remnic-ai"\./);
  assert.match(parserSource, /target,/);
});

test("parseBenchArgs rejects unknown bench publish targets", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () => parseBenchArgs(["publish", "--target", "somewhere-else"]),
    /ERROR: --target must be "remnic-ai"\./,
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
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "longmemeval",
        "--provider",
        "local-llm",
        "--model",
        "qwen3-8b",
      ]),
    /ERROR: --provider local-llm requires --base-url/,
  );
});

test("parseBenchArgs rejects --system-provider local-llm without --system-base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "longmemeval",
        "--system-provider",
        "local-llm",
        "--system-model",
        "qwen3-8b",
      ]),
    /ERROR: --provider local-llm requires --base-url/,
  );
});

test("parseBenchArgs rejects --judge-provider local-llm without --judge-base-url", async () => {
  const { parseBenchArgs } = await import("../packages/remnic-cli/src/bench-args.ts");

  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "longmemeval",
        "--judge-provider",
        "local-llm",
        "--judge-model",
        "qwen3-8b",
      ]),
    /ERROR: --judge-provider local-llm requires --judge-base-url/,
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
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "longmemeval",
        "--provider",
        "bogus",
        "--model",
        "m",
      ]),
    /ERROR: --provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", or "codex-cli"\./,
  );
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "longmemeval",
        "--system-provider",
        "bogus",
        "--system-model",
        "m",
      ]),
    /ERROR: --system-provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", or "codex-cli"\./,
  );
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "longmemeval",
        "--judge-provider",
        "bogus",
        "--judge-model",
        "m",
      ]),
    /ERROR: --judge-provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", or "codex-cli"\./,
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
  assert.match(source, /async function loadBenchDefinitionsFromPackage\(\): Promise<BenchmarkDefinition\[\] \| undefined>/);
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
