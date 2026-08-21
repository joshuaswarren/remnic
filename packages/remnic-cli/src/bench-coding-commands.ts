import { lstat, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  OptionalBenchCommandResult,
  OptionalRepeatedFailureCliInput,
} from "./optional-bench.js";
import { loadBenchModule } from "./optional-bench.js";
import { expandTilde, resolveHomeDir } from "./path-utils.js";

const UINT32_MAX = 0xffff_ffff;
const FROZEN_GENERATOR_SEED = 81;
const FROZEN_TASK_COUNT = 30;
const FROZEN_SEED_COUNT = 5;
const FROZEN_STATISTICS_DRAWS = 10_000;
const FROZEN_MAX_STEPS = 12;
const FROZEN_MAX_TOOL_CALLS = 8;
const FROZEN_MAX_OUTPUT_CHARS = 16_384;
const MAX_OUTPUT_BYTES = 16_384;
const DEFAULT_REPEATED_FAILURE_OUTPUT_DIR = path.join(
  resolveHomeDir(),
  ".remnic",
  "bench",
  "results",
  "h6-repeated-failure",
);

export const BENCH_CODING_USAGE = `Usage: remnic bench coding repo-gen [--count 30] [--seed N] [--out DIR]
       remnic bench coding repo-gen verify-all [DIR]
       remnic bench coding repeated-failure --seeds N --profile FILE [--profile FILE ...] [options]
       remnic bench coding repeated-failure stats --run DIR
       remnic bench coding repeated-failure report --run DIR
       remnic bench coding repeated-failure trap-audit --profile FILE [--profile FILE ...] [options]

Commands:
  repo-gen                  Generate the frozen H6 synthetic repo fixture dataset
  repo-gen verify-all [DIR] Verify every H6 fixture in DIR, or the committed fixtures
  repeated-failure          Run or resume the controlled repeated-failure suite
  repeated-failure stats    Replay statistics offline from a completed run
  repeated-failure report   Generate paper tables and figures from a completed run
  repeated-failure trap-audit Run seeded trap effectiveness audit for model profiles

Repo generation options:
  --count 30                Contract assertion; the published H6 v1 suite has exactly 30 tasks
  --seed 81                 Contract assertion; the published H6 v1 inventory uses seed 81
  --out DIR                 Output directory (default: ./h6-failure-gate)

Repeated-failure options:
  --phase <pilot|main>      Run phase (default: pilot); main also requires --pilot-run
  --pilot-run DIR           Directory of completed pilot run (required when --phase is main)
  --seeds 5                 Five deterministic seeds (required)
  --profile FILE            One or two immutable model profile files are required
  --out DIR                 New run output directory (default: ~/.remnic/bench/results/h6-repeated-failure)
  --run DIR                 Existing run directory to resume
  --fixture DIR             Generated H6 fixture directory
  --max-steps 12            Frozen episode step cap
  --max-output-chars 16384  Frozen serialized model output cap
  --max-duration-ms 120000  Episode wall-clock cap (trap-audit only; raise for large local models)
  --request-timeout-ms 60000 Per-request timeout (trap-audit only; raise for large local models)
  --draws 10000             Contract assertion for confirmatory and pilot statistics
  --statistics-seed N       Unsigned 32-bit statistics seed
  --help, -h                Show this help

Profile JSON v2:
  {"schemaVersion":2,"id":"...","provider":"openai-responses","model":"...",
   "instructions":{"system":"...","developer":"..."},
   "tokenizer":{"identity":"...","implementation":"nfkc-whitespace-v1"},
   "temperature":0,"maxOutputTokens":N}
  Optional endpoint, reasoningEffort, think, and strict nonstandard endpoint seedCapability
  fields participate in the canonical profile hash. Credentials never enter profile files or hashes.

A live run never chooses a model implicitly. The bench package derives the immutable
profile ID and lowercase SHA-256 profile hash. Stats replay and report generation accept
only --run and do not load a model or host.`;

export type BenchCodingCommand =
  | { kind: "help" }
  | { kind: "repo-generate"; count: 30; seed: number; outputDir: string }
  | { kind: "repo-verify"; directory?: string }
  | {
      kind: "repeated-run";
      phase: "pilot" | "main";
      seedCount: number;
      profilePaths: string[];
      outputDir: string;
      fixtureDir?: string;
      resumeRunDir?: string;
      pilotRunDir?: string;
      maxSteps?: number;
      maxToolCalls?: number;
      maxOutputChars?: number;
      maxDurationMs?: number;
      requestTimeoutMs?: number;
      statisticsDraws?: number;
      statisticsSeed?: number;
    }
  | { kind: "repeated-stats"; runDir: string }
  | { kind: "repeated-report"; runDir: string }
  | {
      kind: "trap-audit";
      profilePaths: string[];
      outputDir: string;
      fixtureDir?: string;
      maxSteps?: number;
      maxToolCalls?: number;
      maxOutputChars?: number;
      maxDurationMs?: number;
      requestTimeoutMs?: number;
    };
export type BenchCodingResult = OptionalBenchCommandResult;
export type RunRepeatedFailureCliInput = OptionalRepeatedFailureCliInput;

interface H6ValidationReport {
  valid: boolean;
  issues: readonly { code: string; message: string }[];
  metrics: {
    totalTasks: number;
    totalVariants: number;
    maxPairwiseSimilarity: number;
    devTaskCount: number;
    pilotTaskCount: number;
    mainTaskCount: number;
  };
}

interface H6BenchModule {
  generateH6BenchmarkDataset(seed?: number): Promise<unknown>;
  writeH6FixtureBundle(outputDir: string, dataset: never): Promise<string>;
  loadCommittedH6BenchmarkDataset(): Promise<unknown>;
  validateH6Dataset(dataset: never): Promise<H6ValidationReport>;
  validateH6FixtureBundle(directory: string): Promise<H6ValidationReport>;
  runRepeatedFailureCliCommand(
    input: OptionalRepeatedFailureCliInput,
  ): Promise<OptionalBenchCommandResult>;
  replayRepeatedFailureStatistics(input: {
    runDir: string;
  }): Promise<OptionalBenchCommandResult>;
  runRepeatedFailurePaperReportCliCommand(input: {
    runDir: string;
  }): Promise<OptionalBenchCommandResult>;
  runTrapAuditCliCommand(input: {
    profilePaths: readonly string[];
    outputDir: string;
    fixtureDir?: string;
    maxSteps?: number;
    maxToolCalls?: number;
    maxOutputChars?: number;
    maxDurationMs?: number;
    requestTimeoutMs?: number;
  }): Promise<OptionalBenchCommandResult>;
}
export interface BenchCodingDependencies {
  loadBenchModule: () => Promise<Partial<H6BenchModule>>;
}

const DEFAULT_DEPENDENCIES: BenchCodingDependencies = {
  loadBenchModule: async () => (await loadBenchModule()) as unknown as H6BenchModule,
};

function parseBoundedInteger(
  value: string | undefined,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    throw new Error(`missing value for ${flag}`);
  }
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${flag} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readSingleValue(
  args: readonly string[],
  index: number,
  flag: string,
  seen: Set<string>,
): { value: string; nextIndex: number } {
  if (seen.has(flag)) throw new Error(`${flag} may be provided only once`);
  seen.add(flag);
  const value = args[index + 1];
  if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
    throw new Error(`missing value for ${flag}`);
  }
  return { value, nextIndex: index + 1 };
}

function parseRepoGenerate(args: readonly string[]): BenchCodingCommand {
  let seed = 81;
  let outputDir = "./h6-failure-gate";
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) break;
    if (flag === "--help" || flag === "-h") return { kind: "help" };
    if (flag !== "--count" && flag !== "--seed" && flag !== "--out") {
      throw new Error(flag.startsWith("-") ? `unknown option ${flag}` : `ambiguous repo-gen subcommand ${flag}`);
    }
    const read = readSingleValue(args, index, flag, seen);
    index = read.nextIndex;
    if (flag === "--count") {
      const count = parseBoundedInteger(read.value, flag, 0, UINT32_MAX);
      if (count !== FROZEN_TASK_COUNT) {
        throw new Error("--count must be exactly 30 for the published H6 v1 suite");
      }
    } else if (flag === "--seed") {
      const parsedSeed = parseBoundedInteger(read.value, flag, 0, UINT32_MAX);
      if (parsedSeed !== FROZEN_GENERATOR_SEED) {
        throw new Error("--seed must be exactly 81 for the published H6 v1 inventory");
      }
      seed = parsedSeed;
    } else {
      outputDir = read.value;
    }
  }

  return { kind: "repo-generate", count: 30, seed, outputDir };
}

function parseRepoVerify(args: readonly string[]): BenchCodingCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
  const unknownFlag = args.find((arg) => arg.startsWith("-"));
  if (unknownFlag) throw new Error(`unknown option ${unknownFlag}`);
  if (args.length > 1) throw new Error("repo-gen verify-all accepts at most one directory");
  const directory = args[0];
  return directory === undefined ? { kind: "repo-verify" } : { kind: "repo-verify", directory };
}

function parseRepeatedRunArtifact(
  args: readonly string[],
  kind: "repeated-stats" | "repeated-report",
  commandName: "stats" | "report",
): BenchCodingCommand {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return { kind: "help" };
  if (args.length !== 2 || args[0] !== "--run") {
    const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--run");
    if (unknown) throw new Error(`unknown option ${unknown}`);
    throw new Error(`repeated-failure ${commandName} requires exactly --run DIR`);
  }
  const runDir = args[1];
  if (runDir === undefined || runDir.trim().length === 0 || runDir.startsWith("-")) {
    throw new Error("missing value for --run");
  }
  return { kind, runDir };
}

function parseRepeatedRun(args: readonly string[]): BenchCodingCommand {
  let phase: "pilot" | "main" = "pilot";
  let seedCount: number | undefined;
  const profilePaths: string[] = [];
  let outputDir = DEFAULT_REPEATED_FAILURE_OUTPUT_DIR;
  let fixtureDir: string | undefined;
  let resumeRunDir: string | undefined;
  let pilotRunDir: string | undefined;
  let maxSteps: number | undefined;
  let maxToolCalls: number | undefined;
  let maxOutputChars: number | undefined;
  let maxDurationMs: number | undefined;
  let requestTimeoutMs: number | undefined;
  let statisticsDraws: number | undefined;
  let statisticsSeed: number | undefined;
  const seen = new Set<string>();
  const allowed = new Set([
    "--phase",
    "--pilot-run",
    "--pilot-run-dir",
    "--seeds",
    "--profile",
    "--out",
    "--run",
    "--fixture",
    "--max-steps",
    "--max-tool-calls",
    "--max-output-chars",
    "--max-duration-ms",
    "--request-timeout-ms",
    "--draws",
    "--statistics-seed",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) break;
    if (flag === "--help" || flag === "-h") return { kind: "help" };
    if (!allowed.has(flag)) {
      throw new Error(
        flag.startsWith("-")
          ? `unknown option ${flag}`
          : `ambiguous repeated-failure subcommand ${flag}`,
      );
    }
    if (flag === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
        throw new Error("missing value for --profile");
      }
      profilePaths.push(value);
      index += 1;
      continue;
    }
    const read = readSingleValue(args, index, flag, seen);
    index = read.nextIndex;
    if (flag === "--phase") {
      if (read.value !== "pilot" && read.value !== "main") {
        throw new Error("--phase must be pilot or main");
      }
      phase = read.value;
    } else if (flag === "--seeds") {
      seedCount = parseBoundedInteger(read.value, flag, FROZEN_SEED_COUNT, FROZEN_SEED_COUNT);
    } else if (flag === "--out") outputDir = read.value;
    else if (flag === "--run") resumeRunDir = read.value;
    else if (flag === "--pilot-run" || flag === "--pilot-run-dir") pilotRunDir = read.value;
    else if (flag === "--fixture") fixtureDir = read.value;
    else if (flag === "--max-steps") {
      maxSteps = parseBoundedInteger(read.value, flag, FROZEN_MAX_STEPS, FROZEN_MAX_STEPS);
    } else if (flag === "--max-tool-calls") {
      maxToolCalls = parseBoundedInteger(
        read.value,
        flag,
        FROZEN_MAX_TOOL_CALLS,
        FROZEN_MAX_TOOL_CALLS,
      );
    } else if (flag === "--max-output-chars") {
      maxOutputChars = parseBoundedInteger(
        read.value,
        flag,
        FROZEN_MAX_OUTPUT_CHARS,
        FROZEN_MAX_OUTPUT_CHARS,
      );
    } else if (flag === "--max-duration-ms") {
      maxDurationMs = parseBoundedInteger(read.value, flag, 1000, 3_600_000);
    } else if (flag === "--request-timeout-ms") {
      requestTimeoutMs = parseBoundedInteger(read.value, flag, 1000, 3_600_000);
    }
    else if (flag === "--draws") {
      statisticsDraws = parseBoundedInteger(
        read.value,
        flag,
        FROZEN_STATISTICS_DRAWS,
        FROZEN_STATISTICS_DRAWS,
      );
    } else statisticsSeed = parseBoundedInteger(read.value, flag, 0, UINT32_MAX);
  }

  if (seedCount === undefined) throw new Error("repeated-failure requires --seeds N");
  if (profilePaths.length < 1 || profilePaths.length > 2) {
    throw new Error("repeated-failure runs require one or two --profile files");
  }
  if (phase === "main" && pilotRunDir === undefined && resumeRunDir === undefined) {
    throw new Error("--phase main requires --pilot-run DIR");
  }
  if (phase === "pilot" && pilotRunDir !== undefined) {
    throw new Error("--pilot-run is only valid when --phase is main");
  }
  if (resumeRunDir !== undefined && seen.has("--out")) throw new Error("--run and --out are mutually exclusive");

  return {
    kind: "repeated-run",
    phase,
    seedCount,
    profilePaths,
    outputDir,
    ...(fixtureDir === undefined ? {} : { fixtureDir }),
    ...(resumeRunDir === undefined ? {} : { resumeRunDir }),
    ...(pilotRunDir === undefined ? {} : { pilotRunDir }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(statisticsDraws === undefined ? {} : { statisticsDraws }),
    ...(statisticsSeed === undefined ? {} : { statisticsSeed }),
  };
}
function parseTrapAudit(args: readonly string[]): BenchCodingCommand {
  const profilePaths: string[] = [];
  let outputDir = "./h6-trap-audit";
  let fixtureDir: string | undefined;
  let maxSteps: number | undefined;
  let maxToolCalls: number | undefined;
  let maxOutputChars: number | undefined;
  let maxDurationMs: number | undefined;
  let requestTimeoutMs: number | undefined;
  const seen = new Set<string>();
  const allowed = new Set([
    "--profile",
    "--out",
    "--fixture",
    "--max-steps",
    "--max-tool-calls",
    "--max-output-chars",
    "--max-duration-ms",
    "--request-timeout-ms",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) break;
    if (flag === "--help" || flag === "-h") return { kind: "help" };
    if (!allowed.has(flag)) {
      throw new Error(
        flag.startsWith("-")
          ? `unknown option ${flag}`
          : `ambiguous trap-audit subcommand ${flag}`,
      );
    }
    if (flag === "--profile") {
      const value = args[index + 1];
      if (value === undefined || value.trim().length === 0 || value.startsWith("-")) {
        throw new Error("missing value for --profile");
      }
      profilePaths.push(value);
      index += 1;
      continue;
    }
    const read = readSingleValue(args, index, flag, seen);
    index = read.nextIndex;
    if (flag === "--out") outputDir = read.value;
    else if (flag === "--fixture") fixtureDir = read.value;
    else if (flag === "--max-steps") maxSteps = parseBoundedInteger(read.value, flag, 1, 100);
    else if (flag === "--max-tool-calls") maxToolCalls = parseBoundedInteger(read.value, flag, 1, 100);
    else if (flag === "--max-output-chars") maxOutputChars = parseBoundedInteger(read.value, flag, 256, 65_536);
    else if (flag === "--max-duration-ms") maxDurationMs = parseBoundedInteger(read.value, flag, 1000, 3_600_000);
    else if (flag === "--request-timeout-ms") requestTimeoutMs = parseBoundedInteger(read.value, flag, 1000, 3_600_000);
  }

  if (profilePaths.length === 0) throw new Error("trap-audit requires at least one --profile FILE");

  return {
    kind: "trap-audit",
    profilePaths,
    outputDir,
    ...(fixtureDir === undefined ? {} : { fixtureDir }),
    ...(maxSteps === undefined ? {} : { maxSteps }),
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(maxOutputChars === undefined ? {} : { maxOutputChars }),
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

export function parseBenchCodingArgs(args: readonly string[]): BenchCodingCommand {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") return { kind: "help" };
  if (args[0] === "repo-gen") {
    return args[1] === "verify-all" ? parseRepoVerify(args.slice(2)) : parseRepoGenerate(args.slice(1));
  }
  if (args[0] === "repeated-failure") {
    if (args[1] === "stats") {
      return parseRepeatedRunArtifact(args.slice(2), "repeated-stats", "stats");
    }
    if (args[1] === "report") {
      return parseRepeatedRunArtifact(args.slice(2), "repeated-report", "report");
    }
    if (args[1] === "trap-audit" || args[1] === "audit") return parseTrapAudit(args.slice(2));
    return parseRepeatedRun(args.slice(1));
  }
  if (args[0] === "trap-audit") {
    return parseTrapAudit(args.slice(1));
  }
  throw new Error(`unknown bench coding subcommand ${args[0]}`);
}

function normalizeCommandPaths(command: BenchCodingCommand): BenchCodingCommand {
  const resolve = (value: string) => path.resolve(expandTilde(value));
  if (command.kind === "repo-generate") {
    return { ...command, outputDir: resolve(command.outputDir) };
  }
  if (command.kind === "repo-verify") {
    return command.directory === undefined
      ? command
      : { ...command, directory: resolve(command.directory) };
  }
  if (command.kind === "repeated-stats" || command.kind === "repeated-report") {
    return { ...command, runDir: resolve(command.runDir) };
  }
  if (command.kind === "repeated-run") {
    return {
      ...command,
      profilePaths: command.profilePaths.map(resolve),
      outputDir: resolve(command.resumeRunDir ?? command.outputDir),
      ...(command.fixtureDir === undefined
        ? {}
        : { fixtureDir: resolve(command.fixtureDir) }),
      ...(command.resumeRunDir === undefined
        ? {}
        : { resumeRunDir: resolve(command.resumeRunDir) }),
      ...(command.pilotRunDir === undefined
        ? {}
        : { pilotRunDir: resolve(command.pilotRunDir) }),
    };
  }
  if (command.kind === "trap-audit") {
    return {
      ...command,
      profilePaths: command.profilePaths.map(resolve),
      outputDir: resolve(command.outputDir),
      ...(command.fixtureDir === undefined
        ? {}
        : { fixtureDir: resolve(command.fixtureDir) }),
    };
  }
  return command;
}
async function canonicalProspectivePath(value: string): Promise<string> {
  let candidate = path.resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertSafeBenchmarkOutput(outputDir: string): Promise<void> {
  const refusal = "refusing benchmark output inside a Remnic memory store";
  try {
    const canonicalOutput = await canonicalProspectivePath(outputDir);
    for (const variable of ["REMNIC_MEMORY_DIR", "ENGRAM_MEMORY_DIR"] as const) {
      const configured = process.env[variable]?.trim();
      if (!configured) continue;
      const memoryRoot = await canonicalProspectivePath(
        path.resolve(expandTilde(configured)),
      );
      if (isSameOrDescendant(canonicalOutput, memoryRoot)) {
        throw new Error(refusal);
      }
    }

    let candidate = canonicalOutput;
    while (true) {
      const hasProfile = await pathExists(path.join(candidate, "profile.md"));
      const hasMemoryData =
        (await pathExists(path.join(candidate, "facts"))) ||
        (await pathExists(path.join(candidate, "entities"))) ||
        (await pathExists(path.join(candidate, "state")));
      if (hasProfile && hasMemoryData) throw new Error(refusal);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  } catch (error) {
    if (error instanceof Error && error.message === refusal) throw error;
    throw new Error(refusal);
  }
}

async function assertH6StatsRunDirectory(
  runDir: string,
  commandName: "stats" | "report" = "stats",
): Promise<void> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(runDir, "run.json"), "utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.runId !== "string" ||
      parsed.runId.length === 0 ||
      typeof parsed.suiteVersion !== "string" ||
      !parsed.suiteVersion.startsWith("h6-failure-gate-v1-")
    ) {
      throw new Error("invalid H6 metadata");
    }
  } catch {
    throw new Error(`${commandName} requires existing H6 run metadata`);
  }
}

function sanitizeOutput(output: string): string {
  const home = os.homedir();
  const safe = home.length > 1 ? output.replaceAll(home, "~") : output;
  if (Buffer.byteLength(safe, "utf8") <= MAX_OUTPUT_BYTES) return safe.trimEnd();
  const bounded = Buffer.from(safe, "utf8").subarray(0, MAX_OUTPUT_BYTES - 32).toString("utf8");
  return `${bounded}\n[output truncated]`;
}

async function requireDirectory(directory: string, label: string): Promise<void> {
  const details = await stat(directory).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`${label} must be a directory that exists`);
}

async function rejectExistingNonDirectory(directory: string, label: string): Promise<void> {
  const details = await stat(directory).catch(() => undefined);
  if (details !== undefined && !details.isDirectory()) throw new Error(`${label} must be a directory`);
}

function requireFunction<K extends keyof H6BenchModule>(
  bench: Partial<H6BenchModule>,
  name: K,
): H6BenchModule[K] {
  const value = bench[name];
  if (typeof value !== "function") {
    throw new Error(`Installed @remnic/bench does not export ${name}; install a compatible version`);
  }
  return value as H6BenchModule[K];
}

function formatValidationSummary(report: H6ValidationReport): string {
  const { metrics } = report;
  return (
    `H6 repo fixtures valid: ${metrics.totalTasks} tasks, ${metrics.totalVariants} variants ` +
    `(dev=${metrics.devTaskCount}, pilot=${metrics.pilotTaskCount}, main=${metrics.mainTaskCount}).`
  );
}

async function runRepoGeneration(
  command: Extract<BenchCodingCommand, { kind: "repo-generate" }>,
  bench: Partial<H6BenchModule>,
): Promise<BenchCodingResult> {
  const generate = requireFunction(bench, "generateH6BenchmarkDataset");
  const validate = requireFunction(bench, "validateH6Dataset");
  const writeBundle = requireFunction(bench, "writeH6FixtureBundle");
  const dataset = await generate(command.seed);
  const report = await validate(dataset as never);
  if (!report.valid) {
    return {
      exitCode: 1,
      output: `Generated H6 repo fixtures are invalid: ${report.issues.length} issue(s).`,
    };
  }
  await writeBundle(command.outputDir, dataset as never);
  return {
    exitCode: 0,
    output:
      `Generated H6 repo fixtures: ${report.metrics.totalTasks} tasks, ` +
      `${report.metrics.totalVariants} variants, seed ${command.seed}.`,
  };
}

async function runRepoVerification(
  command: Extract<BenchCodingCommand, { kind: "repo-verify" }>,
  bench: Partial<H6BenchModule>,
): Promise<BenchCodingResult> {
  let dataset: unknown;
  if (command.directory === undefined) {
    dataset = await requireFunction(bench, "loadCommittedH6BenchmarkDataset")();
  } else {
    const serialized = await readFile(path.join(command.directory, "dataset.json"), "utf8").catch(
      () => undefined,
    );
    if (serialized === undefined) {
      return {
        exitCode: 1,
        output: "H6 repo fixtures invalid: dataset.json is missing or unreadable.",
      };
    }
    try {
      dataset = JSON.parse(serialized) as unknown;
    } catch {
      return { exitCode: 1, output: "H6 repo fixtures invalid: dataset.json is not valid JSON." };
    }
  }
  const report = command.directory === undefined
    ? await requireFunction(bench, "validateH6Dataset")(dataset as never)
    : await requireFunction(bench, "validateH6FixtureBundle")(command.directory);
  if (!report.valid) {
    const codes = [...new Set(report.issues.map((issue) => issue.code))].sort().slice(0, 20);
    return {
      exitCode: 1,
      output: `H6 repo fixtures invalid: ${report.issues.length} issue(s) [${codes.join(", ")}].`,
    };
  }
  return { exitCode: 0, output: formatValidationSummary(report) };
}

async function executeCommand(
  command: BenchCodingCommand,
  dependencies: BenchCodingDependencies,
): Promise<BenchCodingResult> {
  if (command.kind === "help") return { exitCode: 0, output: BENCH_CODING_USAGE };

  if (command.kind === "repo-generate") {
    await assertSafeBenchmarkOutput(command.outputDir);
    await rejectExistingNonDirectory(command.outputDir, "--out");
  } else if (command.kind === "repo-verify" && command.directory !== undefined) {
    await requireDirectory(command.directory, "verify-all input");
  } else if (command.kind === "repeated-stats" || command.kind === "repeated-report") {
    await assertSafeBenchmarkOutput(command.runDir);
    await requireDirectory(command.runDir, "--run");
    await assertH6StatsRunDirectory(
      command.runDir,
      command.kind === "repeated-stats" ? "stats" : "report",
    );
  } else if (command.kind === "repeated-run" || command.kind === "trap-audit") {
    await assertSafeBenchmarkOutput(command.outputDir);
    if (command.kind === "repeated-run" && command.resumeRunDir !== undefined) {
      await requireDirectory(command.resumeRunDir, "--run");
    } else {
      await rejectExistingNonDirectory(command.outputDir, "--out");
    }
    if (command.fixtureDir !== undefined) {
      await requireDirectory(command.fixtureDir, "--fixture");
    }
    if (command.kind === "repeated-run" && command.pilotRunDir !== undefined) {
      await requireDirectory(command.pilotRunDir, "--pilot-run");
    }
    for (const profilePath of command.profilePaths) {
      const details = await stat(profilePath).catch(() => undefined);
      if (!details?.isFile()) {
        throw new Error("each --profile value must be an existing file");
      }
    }
  }

  const bench = await dependencies.loadBenchModule();
  if (command.kind === "repo-generate") return runRepoGeneration(command, bench);
  if (command.kind === "repo-verify") return runRepoVerification(command, bench);
  if (command.kind === "repeated-stats") {
    return requireFunction(bench, "replayRepeatedFailureStatistics")({ runDir: command.runDir });
  }
  if (command.kind === "repeated-report") {
    return requireFunction(bench, "runRepeatedFailurePaperReportCliCommand")({
      runDir: command.runDir,
    });
  }
  if (command.kind === "trap-audit") {
    return requireFunction(bench, "runTrapAuditCliCommand")({
      profilePaths: command.profilePaths,
      outputDir: command.outputDir,
      ...(command.fixtureDir === undefined ? {} : { fixtureDir: command.fixtureDir }),
      ...(command.maxSteps === undefined ? {} : { maxSteps: command.maxSteps }),
      ...(command.maxToolCalls === undefined ? {} : { maxToolCalls: command.maxToolCalls }),
      ...(command.maxOutputChars === undefined ? {} : { maxOutputChars: command.maxOutputChars }),
      ...(command.maxDurationMs === undefined ? {} : { maxDurationMs: command.maxDurationMs }),
      ...(command.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: command.requestTimeoutMs }),
    });
  }
  if (command.kind === "repeated-run") {
    return requireFunction(bench, "runRepeatedFailureCliCommand")({
      phase: command.phase,
      seedCount: command.seedCount,
      profilePaths: command.profilePaths,
      outputDir: command.outputDir,
      ...(command.fixtureDir === undefined ? {} : { fixtureDir: command.fixtureDir }),
      ...(command.resumeRunDir === undefined ? {} : { resumeRunDir: command.resumeRunDir }),
      ...(command.pilotRunDir === undefined ? {} : { pilotRunDir: command.pilotRunDir }),
      ...(command.maxSteps === undefined ? {} : { maxSteps: command.maxSteps }),
      ...(command.maxToolCalls === undefined ? {} : { maxToolCalls: command.maxToolCalls }),
      ...(command.maxOutputChars === undefined ? {} : { maxOutputChars: command.maxOutputChars }),
      ...(command.maxDurationMs === undefined ? {} : { maxDurationMs: command.maxDurationMs }),
      ...(command.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: command.requestTimeoutMs }),
      ...(command.statisticsDraws === undefined ? {} : { statisticsDraws: command.statisticsDraws }),
      ...(command.statisticsSeed === undefined ? {} : { statisticsSeed: command.statisticsSeed }),
    });
  }
  throw new Error("unhandled command kind");
}
function validateCommandResult(result: BenchCodingResult): BenchCodingResult {
  if (
    !Number.isInteger(result.exitCode) ||
    result.exitCode < 0 ||
    result.exitCode > 255 ||
    typeof result.output !== "string"
  ) {
    throw new Error("Installed @remnic/bench returned an invalid coding command result");
  }
  return result;
}

export async function runBenchCodingCommand(
  args: readonly string[],
  dependencies: BenchCodingDependencies = DEFAULT_DEPENDENCIES,
): Promise<BenchCodingResult> {
  try {
    const command = normalizeCommandPaths(parseBenchCodingArgs(args));
    const result = validateCommandResult(await executeCommand(command, dependencies));
    return { ...result, output: sanitizeOutput(result.output) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 1, output: sanitizeOutput(`${message}\n\n${BENCH_CODING_USAGE}`) };
  }
}

export async function cmdBenchCoding(args: readonly string[]): Promise<void> {
  const result = await runBenchCodingCommand(args);
  if (result.exitCode === 0) console.log(result.output);
  else console.error(result.output);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}
