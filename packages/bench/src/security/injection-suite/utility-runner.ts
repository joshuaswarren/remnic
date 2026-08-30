import { writeFileAtomically } from "@remnic/core/maintenance/atomic-file";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemnicAdapter } from "../../adapters/remnic-adapter.js";
import type { BenchMemoryAdapter } from "../../adapters/types.js";
import { runBenchmark } from "../../benchmark.js";
import {
  createProviderBackedJudge,
  createProviderBackedResponder,
} from "../../responders.js";
import type { ProviderFactoryConfig } from "../../providers/types.js";
import type { TaskResult } from "../../types.js";
import { buildInjectionSuiteAdapterOptions } from "./product-lifecycle.js";
import { resolveOpenAiCompatToken } from "./llm-executor.js";
import {
  analyzeInjectionSuiteUtility,
  type InjectionSuiteUtilityAnalysis,
  type InjectionSuiteUtilityObservation,
} from "./utility-stats.js";
import type { InjectionSuiteArm, InjectionSuiteCliInput } from "./types.js";

const UTILITY_ARMS = ["none", "fencing"] as const;
const UTILITY_SEEDS = [1, 2, 3, 4, 5] as const;
const UTILITY_SEED_CONCURRENCY = 2;
type UtilityBenchmark = "locomo" | "longmemeval" | "drift-gen";
const DRIFT_ROOT = path.resolve(
  fileURLToPath(new URL("../../fixtures/drift-gen-core/11", import.meta.url)),
);

interface DriftSession {
  sessionId: string;
  userId: string;
  epoch: number;
  date: string;
  turns: Array<{ role: "user" | "assistant"; content: string }>;
}

interface DriftProbe {
  id: string;
  userId: string;
  epoch: number;
  question: string;
  expectedAnswer: string;
}

export interface InjectionSuiteUtilityRunInput extends InjectionSuiteCliInput {
  locomoDatasetDir?: string;
  longmemevalDatasetDir?: string;
  utilityBenchmarks?: UtilityBenchmark[];
}
export function isRetryableUtilityFailure(task: { details?: unknown }): boolean {
  const details = task.details as { benchmarkFailure?: { kind?: unknown } } | undefined;
  return details?.benchmarkFailure?.kind === "trial_execution_failure";
}

class UtilityCheckpointStore {
  readonly directory: string;

  constructor(
    root: string,
    arm: InjectionSuiteArm,
    seed: number,
    benchmark: UtilityBenchmark,
  ) {
    this.directory = path.join(root, "utility-checkpoints", arm, String(seed), benchmark);
    mkdirSync(this.directory, { recursive: true });
  }

  private key(taskId: string): string {
    return createHash("sha256").update(taskId).digest("hex");
  }

  private checkpointPath(taskId: string): string {
    return path.join(this.directory, `${this.key(taskId)}.json`);
  }

  private inFlightPath(taskId: string): string {
    return path.join(this.directory, `${this.key(taskId)}.inflight`);
  }

  loadTasks(): Map<string, TaskResult> {
    const tasks = new Map<string, TaskResult>();
    for (const entry of readdirSync(this.directory)) {
      if (!entry.endsWith(".json")) continue;
      const task = JSON.parse(readFileSync(path.join(this.directory, entry), "utf8")) as TaskResult;
      if (!isRetryableUtilityFailure(task)) tasks.set(task.taskId, task);
    }
    return tasks;
  }

  ambiguousTaskIds(): string[] {
    return readdirSync(this.directory)
      .filter((entry) => entry.endsWith(".inflight"))
      .map((entry) => readFileSync(path.join(this.directory, entry), "utf8").trim())
      .filter(Boolean);
  }

  markInFlight(taskId: string, replace: boolean): void {
    const target = this.inFlightPath(taskId);
    if (existsSync(target) && !replace) {
      throw new Error(`ambiguous paid utility task ${taskId}; owner review required`);
    }
    this.writeAtomicSync(target, `${taskId}\n`);
  }
  commit(task: TaskResult): void {
    const target = this.checkpointPath(task.taskId);
    if (existsSync(target)) {
      const existing = JSON.parse(readFileSync(target, "utf8")) as TaskResult;
      if (isRetryableUtilityFailure(existing)) renameSync(target, `${target}.failed-${randomUUID()}`);
    }
    this.writeAtomicSync(target, `${JSON.stringify(task, null, 2)}\n`);
    rmSync(this.inFlightPath(task.taskId), { force: true });
  }

  private writeAtomicSync(target: string, content: string): void {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, content, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, target);
    const directory = openSync(path.dirname(target), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

function providerConfig(input: InjectionSuiteCliInput, seed: number): ProviderFactoryConfig {
  const executor = input.executor ?? "local";
  if (executor === "openai-compat") {
    const baseUrl = input.baseUrl ?? "http://127.0.0.1:11434/v1";
    return {
      provider: "litellm",
      model: input.model ?? "local-model",
      baseUrl,
      apiKey: resolveOpenAiCompatToken(baseUrl),
      disableThinking: true,
      temperature: 0,
      seed,
      retryOptions: {
        maxAttempts: 3,
        baseBackoffMs: 10_000,
        timeoutMs: input.requestTimeoutMs ?? 300_000,
        max429WaitMs: 30 * 60_000,
      },
    };
  }
  if (executor === "ollama") {
    return {
      provider: "ollama",
      model: input.model ?? "local-model",
      baseUrl: input.baseUrl,
      disableThinking: true,
      temperature: 0,
      seed,
    };
  }
  throw new Error("H5 utility requires ollama or openai-compat executor");
}

async function createUtilityAdapter(
  input: InjectionSuiteCliInput,
  arm: InjectionSuiteArm,
  seed: number,
): Promise<BenchMemoryAdapter> {
  const provider = providerConfig(input, seed);
  return createRemnicAdapter({
    ...buildInjectionSuiteAdapterOptions(arm, input),
    responder: createProviderBackedResponder(provider),
    judge: createProviderBackedJudge(provider),
  });
}

function taskScore(task: TaskResult): number {
  for (const key of ["llm_judge", "contains_answer", "f1"] as const) {
    const score = task.scores[key];
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  const finite = Object.values(task.scores).filter(
    (score): score is number => typeof score === "number" && Number.isFinite(score),
  );
  return finite.length > 0 ? finite.reduce((sum, score) => sum + score, 0) / finite.length : 0;
}

function assertNoAmbiguousUtilityTask(
  store: UtilityCheckpointStore,
  retryAmbiguous: boolean,
): void {
  const ambiguous = store.ambiguousTaskIds();
  if (ambiguous.length > 0 && !retryAmbiguous) {
    throw new Error(
      `PAUSED: ${ambiguous.length} ambiguous paid utility task(s); inspect provider logs before --retry-ambiguous`,
    );
  }
}

async function runPublishedUtility(
  input: InjectionSuiteUtilityRunInput,
  arm: InjectionSuiteArm,
  seed: number,
  benchmark: "locomo" | "longmemeval",
  datasetDir: string | undefined,
): Promise<InjectionSuiteUtilityObservation[]> {
  const store = new UtilityCheckpointStore(input.outputDir, arm, seed, benchmark);
  assertNoAmbiguousUtilityTask(store, input.retryAmbiguous === true);
  const completed = store.loadTasks();
  const adapter = await createUtilityAdapter(input, arm, seed);
  try {
    const result = await runBenchmark(benchmark, {
      mode: datasetDir ? "full" : "quick",
      datasetDir,
      limit: input.limit,
      system: adapter,
      seed,
      benchmarkOptions: { trialConcurrency: 1 },
      resumeTasks: completed,
      onTaskStart: (taskId) => store.markInFlight(taskId, input.retryAmbiguous === true),
      onTaskComplete: (task) => store.commit(task),
      noJudgeCache: true,
    });
    return result.results.tasks.map((task) => ({
      benchmark,
      itemId: task.taskId,
      seed,
      arm,
      score: taskScore(task),
    }));
  } finally {
    await adapter.destroy();
  }
}

function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function runDriftUtility(
  input: InjectionSuiteUtilityRunInput,
  arm: InjectionSuiteArm,
  seed: number,
): Promise<InjectionSuiteUtilityObservation[]> {
  const store = new UtilityCheckpointStore(input.outputDir, arm, seed, "drift-gen");
  assertNoAmbiguousUtilityTask(store, input.retryAmbiguous === true);
  const completed = store.loadTasks();
  const probes = readJsonLines<DriftProbe>(path.join(DRIFT_ROOT, "gold", "probes.jsonl"));
  const sessions = ["u1", "u2"].flatMap((userId) =>
    readJsonLines<DriftSession>(path.join(DRIFT_ROOT, "users", userId, "sessions.jsonl")),
  );
  const adapter = await createUtilityAdapter(input, arm, seed);
  const observations: InjectionSuiteUtilityObservation[] = [];
  try {
    for (const userId of ["u1", "u2"]) {
      await adapter.reset();
      for (const session of sessions.filter((entry) => entry.userId === userId).sort((a, b) => a.epoch - b.epoch)) {
        await adapter.store(
          session.sessionId,
          session.turns.map((turn) => ({ ...turn, timestamp: `${session.date}T00:00:00.000Z` })),
        );
        await adapter.drain?.();
        for (const probe of probes.filter((entry) => entry.userId === userId && entry.epoch === session.epoch)) {
          const existing = completed.get(probe.id);
          let task = existing;
          if (!task) {
            store.markInFlight(probe.id, input.retryAmbiguous === true);
            const recalled = await adapter.recall(
              `h5-drift-${userId}-${session.epoch}-${probe.id}`,
              probe.question,
              8_000,
            );
            const started = Date.now();
            const response = await adapter.responder?.respond(probe.question, recalled);
            if (!response) throw new Error("H5 drift utility requires a responder");
            const score = response.text.toLowerCase().includes(probe.expectedAnswer.toLowerCase()) ? 1 : 0;
            task = {
              taskId: probe.id,
              question: probe.question,
              expected: probe.expectedAnswer,
              actual: response.text,
              scores: { contains_answer: score },
              latencyMs: Date.now() - started,
              tokens: response.tokens,
            };
            store.commit(task);
          }
          observations.push({
            benchmark: "drift-gen",
            itemId: task.taskId,
            seed,
            arm,
            score: taskScore(task),
          });
        }
      }
    }
    return observations;
  } finally {
    await adapter.destroy();
  }
}

export async function runInjectionSuiteUtility(
  input: InjectionSuiteUtilityRunInput,
): Promise<InjectionSuiteUtilityAnalysis> {
  const benchmarks = input.utilityBenchmarks ?? ["locomo", "drift-gen"];
  if (new Set(benchmarks).size !== benchmarks.length) {
    throw new Error("H5 utility benchmarks must be unique");
  }
  if (benchmarks.includes("locomo") && input.runKind === "main" && !input.locomoDatasetDir) {
    throw new Error("H5 main utility requires a frozen LoCoMo --dataset-dir");
  }
  if (benchmarks.includes("longmemeval") && !input.longmemevalDatasetDir) {
    throw new Error("H5 LongMemEval utility requires --longmemeval-dataset-dir");
  }
  if (benchmarks.includes("drift-gen")) {
    await readFile(path.join(DRIFT_ROOT, "..", "dataset.manifest.json"), "utf8");
  }
  mkdirSync(input.outputDir, { recursive: true });
  const observations: InjectionSuiteUtilityObservation[] = [];
  for (const arm of UTILITY_ARMS) {
    for (let offset = 0; offset < UTILITY_SEEDS.length; offset += UTILITY_SEED_CONCURRENCY) {
      const seeds = UTILITY_SEEDS.slice(offset, offset + UTILITY_SEED_CONCURRENCY);
      const bySeed = await Promise.all(seeds.map(async (seed) => {
        const rows: InjectionSuiteUtilityObservation[] = [];
        for (const benchmark of benchmarks) {
          if (benchmark === "locomo") {
            rows.push(...await runPublishedUtility(input, arm, seed, benchmark, input.locomoDatasetDir));
          } else if (benchmark === "longmemeval") {
            rows.push(...await runPublishedUtility(input, arm, seed, benchmark, input.longmemevalDatasetDir));
          } else {
            rows.push(...await runDriftUtility(input, arm, seed));
          }
        }
        return rows;
      }));
      observations.push(...bySeed.flat());
      await writeFileAtomically(
        path.join(input.outputDir, "utility-observations.json"),
        `${JSON.stringify(observations, null, 2)}\n`,
      );
    }
  }
  const analysis = analyzeInjectionSuiteUtility(observations);
  await writeFileAtomically(
    path.join(input.outputDir, "utility-statistics.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  return analysis;
}
