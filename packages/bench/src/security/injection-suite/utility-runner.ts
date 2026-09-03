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
  readlinkSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemnicAdapter } from "../../adapters/remnic-adapter.js";
import type { BenchMemoryAdapter, BenchResponder } from "../../adapters/types.js";
import { runBenchmark } from "../../benchmark.js";
import { resolvedExecutorContract } from "./runner.js";
import { enforceRunIdentityGate } from "./freeze.js";
import { captureBenchmarkExecutionProvenance } from "../../reporter.js";
import {
  createProviderBackedJudge,
  getProviderBackedResponderIdentity,
} from "../../responders.js";
import type { ProviderFactoryConfig } from "../../providers/types.js";
import type { TaskResult } from "../../types.js";
import {
  completeChatResult,
  resolveOpenAiCompatToken,
  type InjectionSuiteChatMessage,
  type InjectionSuiteChatResult,
  type InjectionSuiteLlmOptions,
} from "./llm-executor.js";
import {
  buildInjectionSuiteAdapterOptions,
  buildInjectionSuiteBehaviorMessages,
} from "./product-lifecycle.js";
import {
  analyzeInjectionSuiteUtility,
  type InjectionSuiteUtilityAnalysis,
  type InjectionSuiteUtilityObservation,
} from "./utility-stats.js";
import {
  injectionSuiteArmUsesFence,
  type InjectionSuiteArm,
  type InjectionSuiteCliInput,
} from "./types.js";

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

export class UtilityCheckpointStore {
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
    const ambiguous: string[] = [];
    for (const entry of readdirSync(this.directory)) {
      if (!entry.endsWith(".inflight")) continue;
      const taskId = readFileSync(path.join(this.directory, entry), "utf8").trim();
      if (!taskId) continue;
      // A crash between the durable commit and the marker removal leaves a
      // marker for a task that is already checkpointed: nothing is owed.
      const checkpoint = this.checkpointPath(taskId);
      if (existsSync(checkpoint) && !isRetryableUtilityFailure(JSON.parse(readFileSync(checkpoint, "utf8")) as TaskResult)) {
        rmSync(path.join(this.directory, entry), { force: true });
        continue;
      }
      ambiguous.push(taskId);
    }
    return ambiguous;
  }

  markInFlight(taskId: string, replace: boolean): void {
    const target = this.inFlightPath(taskId);
    if (replace) {
      rmSync(target, { force: true });
    }
    try {
      const handle = openSync(target, "wx", 0o600);
      writeFileSync(handle, `${taskId}\n`, "utf8");
      fsyncSync(handle);
      closeSync(handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`ambiguous paid utility task ${taskId}; owner review required`);
      }
      throw error;
    }
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

export function providerConfig(input: InjectionSuiteCliInput, seed: number): ProviderFactoryConfig {
  const executor = input.executor ?? "local";
  if (executor === "openai-compat") {
    const baseUrl = input.baseUrl ?? "http://127.0.0.1:11434/v1";
    return {
      provider: "litellm",
      model: resolvedExecutorContract(input).model,
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
      model: resolvedExecutorContract(input).model,
      baseUrl: input.baseUrl,
      disableThinking: true,
      temperature: 0,
      seed,
    };
  }
  throw new Error("H5 utility requires ollama or openai-compat executor");
}

/**
 * Arm-consistent utility responder (v3 U1): answers every arm with the
 * exact multi-message construction the security rows score, sent through
 * the same completeChatResult path as product-lifecycle (temperature 0,
 * max 256 tokens, no tools for utility).
 */
export interface InjectionSuiteResponderDeps {
  complete?: (
    options: InjectionSuiteLlmOptions,
    messages: readonly InjectionSuiteChatMessage[],
  ) => Promise<InjectionSuiteChatResult>;
  identity?: string;
}

export function createInjectionSuiteBehaviorResponder(
  input: InjectionSuiteCliInput,
  arm: InjectionSuiteArm,
  deps: InjectionSuiteResponderDeps = {},
): BenchResponder {
  const complete = deps.complete ?? completeChatResult;
  const fenced = injectionSuiteArmUsesFence(arm);
  const identity = deps.identity;
  return {
    ...(identity ? { identity: () => identity } : {}),
    async respond(question, recalledText) {
      const messages = buildInjectionSuiteBehaviorMessages(
        arm,
        recalledText,
        question,
        fenced,
      );
      const startedAt = Date.now();
      const chat = await complete(
        {
          kind: input.executor ?? "openai-compat",
          baseUrl: input.baseUrl,
          model: input.model,
          requestTimeoutMs: input.requestTimeoutMs,
        },
        messages,
      );
      return {
        text: chat.text,
        tokens: { input: chat.inputTokens, output: chat.outputTokens },
        latencyMs: Date.now() - startedAt,
        model: chat.model,
      };
    },
  };
}

async function createUtilityAdapter(
  input: InjectionSuiteCliInput,
  arm: InjectionSuiteArm,
  seed: number,
): Promise<BenchMemoryAdapter> {
  const provider = providerConfig(input, seed);
  return createRemnicAdapter({
    ...buildInjectionSuiteAdapterOptions(arm, input),
    responder: createInjectionSuiteBehaviorResponder(input, arm, {
      identity: getProviderBackedResponderIdentity(provider),
    }),
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
  plannedItems: Set<string>,
): Promise<InjectionSuiteUtilityObservation[]> {
  const store = new UtilityCheckpointStore(input.outputDir, arm, seed, benchmark);
  assertNoAmbiguousUtilityTask(store, input.retryAmbiguous === true);
  const completed = store.loadTasks();
  const adapter = await createUtilityAdapter(input, arm, seed);
  try {
    // Every task the benchmark starts (including ones that later fail) is
    // part of the planned universe, so an item that fails in every cell
    // still counts as missing. ponytail: an item the benchmark never starts
    // in any of the 10 cells is invisible here; enumerate the dataset ahead
    // if that ceiling matters.
    const onTaskStart = (taskId: string) => {
      plannedItems.add(`${benchmark}\0${taskId}`);
      store.markInFlight(taskId, input.retryAmbiguous === true);
    };
    for (const taskId of completed.keys()) plannedItems.add(`${benchmark}\0${taskId}`);
    const result = await runBenchmark(benchmark, {
      mode: datasetDir ? "full" : "quick",
      datasetDir,
      limit: input.limit,
      system: adapter,
      seed,
      benchmarkOptions: { trialConcurrency: 1 },
      resumeTasks: completed,
      onTaskStart,
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
  } catch (error) {
    // A partial benchmark (provider trial failures) must not abort the
    // remaining seeds: every completed task is already checkpointed, the
    // failed ones are excluded from the resume map, and the next run retries
    // only those. Surface the partial cell; the analysis treats missing
    // tasks as missing, never as utility loss.
    if (!(error instanceof Error) || !error.message.includes("produced a partial result")) throw error;
    console.warn(`[h5-utility] ${arm} seed ${seed} ${benchmark}: ${error.message}; continuing with remaining seeds`);
    return [...store.loadTasks().values()]
      .filter((task) => !isRetryableUtilityFailure(task))
      .map((task) => ({ benchmark, itemId: task.taskId, seed, arm, score: taskScore(task) }));
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
  plannedItems: Set<string>,
): Promise<InjectionSuiteUtilityObservation[]> {
  const store = new UtilityCheckpointStore(input.outputDir, arm, seed, "drift-gen");
  assertNoAmbiguousUtilityTask(store, input.retryAmbiguous === true);
  const completed = store.loadTasks();
  const probes = readJsonLines<DriftProbe>(path.join(DRIFT_ROOT, "gold", "probes.jsonl"));
  for (const probe of probes) plannedItems.add(`drift-gen\0${probe.id}`);
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

export const UTILITY_CONTRACT_FILE = "utility-contract.json";

/** What a utility checkpoint directory was produced under; a mismatch refuses to reuse it. */
/**
 * Content digest of a dataset directory: every regular file's repo-relative
 * path and sha256, folded in sorted order. A dataset edited in place after a
 * partial run therefore changes the contract and refuses reuse (#3078).
 */
export function datasetDigest(directory: string | undefined): string | null {
  if (!directory) return null;
  const root = path.resolve(directory);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        files.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      // The benchmark loaders read through symlinks, so the digest must too
      // or editing a link target between partial runs would go unnoticed.
      // Directory links are NOT walked (a link can form a cycle or point
      // outside the frozen dataset); their target path is folded in instead,
      // so a retarget still changes the digest.
      let target: Stats | undefined;
      try {
        target = statSync(full);
      } catch {
        target = undefined;
      }
      if (target?.isFile()) files.push(full);
      else linkedDirectories.push(`${full}\u0000${readlinkSync(full)}`);
    }
  };
  const linkedDirectories: string[] = [];
  walk(root);
  const digest = createHash("sha256");
  for (const link of linkedDirectories.sort()) {
    digest.update(path.relative(root, link.split("\u0000")[0] ?? "").split(path.sep).join("/"));
    digest.update("\u0000dirlink\u0000");
    digest.update(link.split("\u0000")[1] ?? "");
    digest.update("\0");
  }
  for (const file of files) {
    digest.update(path.relative(root, file).split(path.sep).join("/"));
    digest.update("\0");
    digest.update(createHash("sha256").update(readFileSync(file)).digest("hex"));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}:${files.length}`;
}

export function utilityContract(
  input: InjectionSuiteUtilityRunInput,
  benchmarks: readonly UtilityBenchmark[],
): Record<string, unknown> {
  const executor = resolvedExecutorContract(input);
  return {
    contract: "h5-utility-contract-v1",
    executor: executor.executor,
    model: executor.model,
    modelDigest: input.modelDigest?.trim() || "unverified",
    modelProfileId: input.modelProfileId,
    baseUrl: executor.baseUrl,
    benchmarks: [...benchmarks],
    seeds: [...UTILITY_SEEDS],
    limit: input.limit ?? null,
    runKind: input.runKind ?? null,
    locomoDatasetDir: input.locomoDatasetDir ?? null,
    locomoDatasetDigest: benchmarks.includes("locomo") ? datasetDigest(input.locomoDatasetDir) : null,
    longmemevalDatasetDir: input.longmemevalDatasetDir ?? null,
    longmemevalDatasetDigest: benchmarks.includes("longmemeval")
      ? datasetDigest(input.longmemevalDatasetDir)
      : null,
    driftDatasetDigest: benchmarks.includes("drift-gen") ? datasetDigest(DRIFT_ROOT) : null,
  };
}

export async function assertUtilityContract(
  input: InjectionSuiteUtilityRunInput,
  benchmarks: readonly UtilityBenchmark[],
): Promise<void> {
  const file = path.join(input.outputDir, UTILITY_CONTRACT_FILE);
  const current = `${JSON.stringify(utilityContract(input, benchmarks), null, 2)}\n`;
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing === undefined) {
    if (existsSync(path.join(input.outputDir, "utility-checkpoints"))) {
      throw new Error(
        `${input.outputDir} holds utility checkpoints but no ${UTILITY_CONTRACT_FILE}; use a fresh output directory`,
      );
    }
    await writeFileAtomically(file, current);
    return;
  }
  if (existing !== current) {
    throw new Error(
      `${input.outputDir} was produced under a different utility contract (model, endpoint, benchmarks, seeds, limit, or dataset); use a fresh output directory`,
    );
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
  // Utility evidence carries the same identity guarantees as the injection
  // runs it is paired with: pilot/main need a frozen digest, a declared
  // context window, and a clean tree; main forbids --limit.
  enforceRunIdentityGate(input, !captureBenchmarkExecutionProvenance().gitDirty);
  mkdirSync(input.outputDir, { recursive: true });
  await assertUtilityContract(input, benchmarks);
  const observations: InjectionSuiteUtilityObservation[] = [];
  const plannedItems = new Set<string>();
  const arms = input.arms && input.arms.length > 0 ? [...new Set(input.arms)] : UTILITY_ARMS;
  for (const arm of arms) {
    for (let offset = 0; offset < UTILITY_SEEDS.length; offset += UTILITY_SEED_CONCURRENCY) {
      const seeds = UTILITY_SEEDS.slice(offset, offset + UTILITY_SEED_CONCURRENCY);
      const bySeed = await Promise.all(seeds.map(async (seed) => {
        const rows: InjectionSuiteUtilityObservation[] = [];
        for (const benchmark of benchmarks) {
          if (benchmark === "locomo") {
            rows.push(...await runPublishedUtility(input, arm, seed, benchmark, input.locomoDatasetDir, plannedItems));
          } else if (benchmark === "longmemeval") {
            rows.push(...await runPublishedUtility(input, arm, seed, benchmark, input.longmemevalDatasetDir, plannedItems));
          } else {
            rows.push(...await runDriftUtility(input, arm, seed, plannedItems));
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
  const plan = {
    benchmarks,
    seeds: [...UTILITY_SEEDS],
    items: [...plannedItems].map((key) => {
      const [benchmark, itemId] = key.split("\0") as [InjectionSuiteUtilityObservation["benchmark"], string];
      return { benchmark, itemId };
    }),
  };
  await writeFileAtomically(
    path.join(input.outputDir, "utility-plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  const analysis = analyzeInjectionSuiteUtility(observations, plan);
  await writeFileAtomically(
    path.join(input.outputDir, "utility-statistics.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
  );
  return analysis;
}
