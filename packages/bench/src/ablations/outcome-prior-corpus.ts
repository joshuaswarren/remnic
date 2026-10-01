/**
 * H1 synthetic outcome corpus (issue #1958, plan steps 4).
 *
 * Tasks are derived from `remnic bench drift-gen`. The full 5×12 seed-21
 * task family is committed as JSONL. The session corpus for that recipe is
 * regenerated locally and is not committed. The CI snapshot is a separate
 * 2×4 seed-21 drift-gen tree plus 12 tasks and a small warm store.
 *
 * Warming is a deterministic fake model: every fourth task answers
 * "unresolved" and fails its mechanical check. This is fixture authoring,
 * not a warm, pilot, or locked experiment.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DRIFT_GEN_VERSION, buildDriftCorpus } from "../generators/drift-gen/index.js";
import type { DriftGenCorpus, GoldFact } from "../generators/drift-gen/types.js";

export const H1_FULL_RECIPE = Object.freeze({ users: 5, epochs: 12, seed: 21 });
export const H1_CI_RECIPE = Object.freeze({ users: 2, epochs: 4, seed: 21 });
export const H1_CI_TASK_COUNT = 12;
export const H1_MIN_FULL_TASKS = 40;
export const H1_FACTS_PER_TASK = 4;
export const H1_MIN_OBSERVED_FRACTION = 0.6;
export const H1_WARM_SUCCESS_RATE_MIN = 0.2;
export const H1_WARM_SUCCESS_RATE_MAX = 0.8;
export const H1_WARM_SPLIT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

const TASK_KEYS = Object.freeze([
  "schemaVersion",
  "taskId",
  "userId",
  "instruction",
  "successCheck",
  "goldFactIds",
] as const);

const SUCCESS_CHECK_KEYS = Object.freeze(["type", "value"] as const);
const WARM_STORE_KEYS = Object.freeze([
  "schemaVersion",
  "provenance",
  "seed",
  "users",
  "epochs",
  "splitTimestamp",
  "counters",
  "trajectories",
] as const);
const PROVENANCE_KEYS = Object.freeze(["generator", "generatorVersion", "manifestName"] as const);
const COUNTER_KEYS = Object.freeze(["success", "fail"] as const);
const TRAJECTORY_KEYS = Object.freeze(["taskId", "outcome", "factIds"] as const);

const TASK_ID_PATTERN = /^h1t(?:-ci)?-[0-9]{2,}$/;
const USER_ID_PATTERN = /^u[1-9][0-9]*$/;
const FACT_ID_PATTERN = /^gf-u[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*$/;

export interface OutcomeTask {
  schemaVersion: 1;
  taskId: string;
  userId: string;
  instruction: string;
  successCheck: { type: "regex"; value: string };
  goldFactIds: string[];
}

export interface OutcomeWarmCounter {
  success: number;
  fail: number;
}

export interface OutcomeWarmTrajectory {
  taskId: string;
  outcome: "success" | "fail";
  factIds: string[];
}

export interface OutcomeWarmStore {
  schemaVersion: 1;
  provenance: {
    generator: "drift-gen";
    generatorVersion: string;
    manifestName: "drift-gen-core";
  };
  seed: number;
  users: number;
  epochs: number;
  splitTimestamp: typeof H1_WARM_SPLIT_TIMESTAMP;
  counters: Record<string, OutcomeWarmCounter>;
  trajectories: OutcomeWarmTrajectory[];
}

export interface OutcomeFactRef {
  id: string;
  userId: string;
  introducedEpoch: number;
  value: string;
}

export interface WarmVerification {
  ok: boolean;
  reasons: string[];
  goldFactCount: number;
  observedGoldFactCount: number;
  observedFraction: number;
  taskSuccessRate: number;
  successCounterTotal: number;
  failCounterTotal: number;
}

export interface CommittedTaskArtifacts {
  fullTasksJsonl: string;
  ciTasksJsonl: string;
  warmStore: OutcomeWarmStore;
  warmStoreJson: string;
}

export function h1OutcomeFixtureRoot(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "../../fixtures/h1-outcome"),
    path.resolve(import.meta.dirname, "../fixtures/h1-outcome"),
  ];
  for (const candidate of candidates) {
    if (existsSyncDecision(candidate)) return candidate;
  }
  throw new Error("h1-outcome fixtures are not installed next to @remnic/bench");
}

function existsSyncDecision(candidate: string): boolean {
  try {
    readFileSync(path.join(candidate, "decision-rule.json"));
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(raw: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function assertExactKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const names = Object.getOwnPropertyNames(raw);
  for (const name of names) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw new Error(`${label} has unexpected key ${JSON.stringify(name)}`);
    }
  }
  for (const name of allowed) {
    if (!Object.hasOwn(raw, name)) throw new Error(`${label} is missing key ${JSON.stringify(name)}`);
  }
}

function assertExactText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string with no surrounding whitespace`);
  }
  return value;
}

function assertPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumber(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function escapeRegexLiteral(value: string): string {
  let out = "";
  for (const ch of value) {
    if ("\\^$.*+?()[]{}|".includes(ch)) out += "\\";
    out += ch;
  }
  return out;
}

export function isDeliberateWarmFailure(index: number): boolean {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("warm task index must be a non-negative integer");
  }
  return index % 4 === 3;
}

export function canonicalJson(value: unknown): string {
  return `${stringifyCanonical(value)}\n`;
}

function stringifyCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  if (!isPlainObject(value)) throw new Error("canonical JSON rejects unsupported values");
  const keys = Object.getOwnPropertyNames(value).sort(compareText);
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stringifyCanonical(own(value, key))}`)
    .join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function resolveGoldAnswer(
  task: OutcomeTask,
  facts: ReadonlyMap<string, OutcomeFactRef>,
): { ok: true; expected: string } | { ok: false; reason: string } {
  const values: string[] = [];
  for (const id of task.goldFactIds) {
    const fact = facts.get(id);
    if (!fact || fact.userId !== task.userId) {
      return { ok: false, reason: `task ${task.taskId} gold fact ${id} does not resolve for ${task.userId}` };
    }
    values.push(fact.value);
  }
  return { ok: true, expected: values.join(" | ") };
}

function expectedAnswer(task: OutcomeTask, facts: ReadonlyMap<string, OutcomeFactRef>): string {
  const resolved = resolveGoldAnswer(task, facts);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.expected;
}

export function fakeModelAnswer(task: OutcomeTask, facts: ReadonlyMap<string, OutcomeFactRef>, index: number): string {
  if (isDeliberateWarmFailure(index)) return "unresolved";
  return expectedAnswer(task, facts);
}

export function answerMatchesTask(
  task: OutcomeTask,
  answer: string,
  facts: ReadonlyMap<string, OutcomeFactRef>,
): boolean {
  const expected = expectedAnswer(task, facts);
  if (task.successCheck.value !== escapeRegexLiteral(expected)) {
    throw new Error(`task ${task.taskId} successCheck does not match its gold values`);
  }
  return answer === expected;
}

function factRefs(corpus: DriftGenCorpus): Map<string, OutcomeFactRef> {
  const refs = new Map<string, OutcomeFactRef>();
  for (const fact of corpus.facts) {
    if (refs.has(fact.id)) throw new Error(`duplicate gold fact id ${fact.id}`);
    refs.set(fact.id, {
      id: fact.id,
      userId: fact.userId,
      introducedEpoch: fact.introducedEpoch,
      value: fact.value,
    });
  }
  return refs;
}

function sortFacts(facts: readonly GoldFact[]): GoldFact[] {
  return [...facts].sort((left, right) => {
    const byEpoch = compareNumber(left.introducedEpoch, right.introducedEpoch);
    if (byEpoch !== 0) return byEpoch;
    return compareText(left.id, right.id);
  });
}

function takeTaskFacts(pool: readonly GoldFact[], perTask: number): GoldFact[] | null {
  if (!Number.isInteger(perTask) || perTask < 2 || perTask % 2 !== 0) {
    throw new Error("factsPerTask must be an even integer >= 2");
  }
  const half = perTask / 2;
  const sorted = sortFacts(pool);
  const byEpoch = new Map<number, GoldFact[]>();
  for (const fact of sorted) {
    const list = byEpoch.get(fact.introducedEpoch) ?? [];
    list.push(fact);
    byEpoch.set(fact.introducedEpoch, list);
  }
  const epochs = [...byEpoch.keys()].sort(compareNumber);
  for (let leftIndex = 0; leftIndex < epochs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < epochs.length; rightIndex += 1) {
      const left = byEpoch.get(epochs[leftIndex]!) ?? [];
      const right = byEpoch.get(epochs[rightIndex]!) ?? [];
      if (left.length >= half && right.length >= half) {
        return [...left.slice(0, half), ...right.slice(0, half)];
      }
    }
  }
  return null;
}

function buildTask(chosen: readonly GoldFact[], index: number, idPrefix: string, idWidth: number): OutcomeTask {
  const epochs = new Set(chosen.map((fact) => fact.introducedEpoch));
  if (epochs.size < 2) throw new Error("a task must span at least two epochs");
  const userId = chosen[0]?.userId;
  if (!userId || chosen.some((fact) => fact.userId !== userId)) {
    throw new Error("a task must stay inside one user");
  }
  const goldFactIds = chosen.map((fact) => fact.id);
  const instruction = `Report the recorded value of each cited fact, in order, separated by " | ": ${chosen
    .map((fact) => `${fact.id} ${fact.subject} ${fact.attribute}`)
    .join("; ")}.`;
  const task: OutcomeTask = {
    schemaVersion: 1,
    taskId: `${idPrefix}-${String(index + 1).padStart(idWidth, "0")}`,
    userId,
    instruction,
    successCheck: { type: "regex", value: "" },
    goldFactIds,
  };
  const refs = new Map<string, OutcomeFactRef>();
  for (const fact of chosen) {
    refs.set(fact.id, {
      id: fact.id,
      userId: fact.userId,
      introducedEpoch: fact.introducedEpoch,
      value: fact.value,
    });
  }
  task.successCheck = { type: "regex", value: escapeRegexLiteral(expectedAnswer(task, refs)) };
  return task;
}

export interface DeriveOutcomeTasksOptions {
  factsPerTask: number;
  idPrefix: string;
  idWidth: number;
  taskCount?: number;
  minTasks?: number;
  minObservedFraction?: number;
}

export function deriveOutcomeTasks(corpus: DriftGenCorpus, options: DeriveOutcomeTasksOptions): OutcomeTask[] {
  const userIds = [...new Set(corpus.facts.map((fact) => fact.userId))].sort(compareText);
  const pools = new Map<string, GoldFact[]>();
  for (const userId of userIds) {
    pools.set(
      userId,
      sortFacts(corpus.facts.filter((fact) => fact.userId === userId)),
    );
  }
  const tasks: OutcomeTask[] = [];
  const limit = options.taskCount ?? Number.POSITIVE_INFINITY;
  let progressed = true;
  while (progressed && tasks.length < limit) {
    progressed = false;
    for (const userId of userIds) {
      if (tasks.length >= limit) break;
      const pool = pools.get(userId) ?? [];
      const chosen = takeTaskFacts(pool, options.factsPerTask);
      if (!chosen) continue;
      const chosenIds = new Set(chosen.map((fact) => fact.id));
      pools.set(
        userId,
        pool.filter((fact) => !chosenIds.has(fact.id)),
      );
      tasks.push(buildTask(chosen, tasks.length, options.idPrefix, options.idWidth));
      progressed = true;
    }
  }
  const covered = new Set(tasks.flatMap((task) => task.goldFactIds));
  const fraction = corpus.facts.length === 0 ? 0 : covered.size / corpus.facts.length;
  if (options.minTasks !== undefined && tasks.length < options.minTasks) {
    throw new Error(`derived ${tasks.length} tasks, need at least ${options.minTasks}`);
  }
  if (options.taskCount !== undefined && tasks.length !== options.taskCount) {
    throw new Error(`derived ${tasks.length} tasks, need exactly ${options.taskCount}`);
  }
  if (options.minObservedFraction !== undefined && !(fraction >= options.minObservedFraction)) {
    throw new Error(`gold-fact coverage ${fraction} is below ${options.minObservedFraction}`);
  }
  return tasks;
}

export function tasksToJsonl(tasks: readonly OutcomeTask[]): string {
  return `${tasks.map((task) => JSON.stringify(task)).join("\n")}\n`;
}

export function warmOutcomeStore(
  tasks: readonly OutcomeTask[],
  facts: ReadonlyMap<string, OutcomeFactRef>,
  recipe: { seed: number; users: number; epochs: number },
): OutcomeWarmStore {
  const counters: Record<string, OutcomeWarmCounter> = {};
  const trajectories: OutcomeWarmTrajectory[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    const answer = fakeModelAnswer(task, facts, index);
    const outcome = answerMatchesTask(task, answer, facts) ? "success" : "fail";
    for (const id of task.goldFactIds) {
      const current = counters[id] ?? { success: 0, fail: 0 };
      if (outcome === "success") current.success += 1;
      else current.fail += 1;
      counters[id] = current;
    }
    trajectories.push({ taskId: task.taskId, outcome, factIds: [...task.goldFactIds] });
  }
  return {
    schemaVersion: 1,
    provenance: {
      generator: "drift-gen",
      generatorVersion: DRIFT_GEN_VERSION,
      manifestName: "drift-gen-core",
    },
    seed: recipe.seed,
    users: recipe.users,
    epochs: recipe.epochs,
    splitTimestamp: H1_WARM_SPLIT_TIMESTAMP,
    counters,
    trajectories,
  };
}

function replayTrajectories(
  tasks: readonly OutcomeTask[],
  facts: ReadonlyMap<string, OutcomeFactRef>,
): { replay: OutcomeWarmTrajectory[] } | { reasons: string[] } {
  const reasons: string[] = [];
  const replay: OutcomeWarmTrajectory[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]!;
    const resolved = resolveGoldAnswer(task, facts);
    if (!resolved.ok) {
      reasons.push(resolved.reason);
      continue;
    }
    if (task.successCheck.value !== escapeRegexLiteral(resolved.expected)) {
      reasons.push(`task ${task.taskId} successCheck does not match its gold values`);
      continue;
    }
    const answer = isDeliberateWarmFailure(index) ? "unresolved" : resolved.expected;
    replay.push({
      taskId: task.taskId,
      outcome: answer === resolved.expected ? "success" : "fail",
      factIds: [...task.goldFactIds],
    });
  }
  if (reasons.length > 0) return { reasons };
  return { replay };
}

function countersFromTrajectories(
  trajectories: readonly OutcomeWarmTrajectory[],
): Map<string, { success: number; fail: number }> {
  const expected = new Map<string, { success: number; fail: number }>();
  for (const trajectory of trajectories) {
    for (const id of trajectory.factIds) {
      const current = expected.get(id) ?? { success: 0, fail: 0 };
      if (trajectory.outcome === "success") current.success += 1;
      else current.fail += 1;
      expected.set(id, current);
    }
  }
  return expected;
}

function sameTrajectory(left: OutcomeWarmTrajectory, right: OutcomeWarmTrajectory): boolean {
  if (left.taskId !== right.taskId || left.outcome !== right.outcome) return false;
  if (left.factIds.length !== right.factIds.length) return false;
  for (let index = 0; index < left.factIds.length; index += 1) {
    if (left.factIds[index] !== right.factIds[index]) return false;
  }
  return true;
}

export function verifyOutcomeWarm(
  tasks: readonly OutcomeTask[],
  facts: ReadonlyMap<string, OutcomeFactRef>,
  store: OutcomeWarmStore,
): WarmVerification {
  const reasons: string[] = [];
  const factIds = [...facts.keys()];
  let observed = 0;
  let successTotal = 0;
  let failTotal = 0;
  for (const id of factIds) {
    const counter = store.counters[id];
    if (!counter) continue;
    if (!Number.isInteger(counter.success) || !Number.isInteger(counter.fail) || counter.success < 0 || counter.fail < 0) {
      reasons.push(`counter for ${id} is not a pair of non-negative integers`);
      continue;
    }
    successTotal += counter.success;
    failTotal += counter.fail;
    if (counter.success + counter.fail >= 1) observed += 1;
  }
  for (const id of Object.getOwnPropertyNames(store.counters)) {
    if (!facts.has(id)) reasons.push(`counter ${id} is not a gold fact`);
  }
  const fraction = factIds.length === 0 ? 0 : observed / factIds.length;
  if (!(fraction >= H1_MIN_OBSERVED_FRACTION)) {
    reasons.push(`observed gold-fact fraction ${fraction} is below ${H1_MIN_OBSERVED_FRACTION}`);
  }
  if (!(successTotal > 0)) reasons.push("warm store has no success counters");
  if (!(failTotal > 0)) reasons.push("warm store has no failure counters");

  const replayed = replayTrajectories(tasks, facts);
  if ("reasons" in replayed) {
    reasons.push(...replayed.reasons);
  } else {
    const replay = replayed.replay;
    if (replay.length !== store.trajectories.length) {
      reasons.push("trajectory count does not match the task list");
    } else {
      for (let index = 0; index < replay.length; index += 1) {
        if (!sameTrajectory(replay[index]!, store.trajectories[index]!)) {
          reasons.push("trajectories do not match the warm replay");
          break;
        }
      }
    }
    const expected = countersFromTrajectories(replay);
    const matched = new Set<string>();
    for (const id of expected.keys()) {
      matched.add(id);
      const want = expected.get(id);
      const got = Object.hasOwn(store.counters, id) ? store.counters[id] : undefined;
      if (!want || !got || got.success !== want.success || got.fail !== want.fail) {
        reasons.push(`counter for ${id} does not match replayed trajectories`);
      }
    }
    for (const id of Object.getOwnPropertyNames(store.counters)) {
      if (matched.has(id)) continue;
      const got = store.counters[id];
      if (got && (got.success !== 0 || got.fail !== 0)) {
        reasons.push(`counter for ${id} does not match replayed trajectories`);
      }
    }
  }
  let trajectoryFacts = 0;
  let successes = 0;
  for (const trajectory of store.trajectories) {
    trajectoryFacts += trajectory.factIds.length;
    if (trajectory.outcome === "success") successes += 1;
  }
  if (successTotal + failTotal !== trajectoryFacts) {
    reasons.push("counter totals do not equal trajectory-recorded outcomes");
  }
  const rate = tasks.length === 0 ? 0 : successes / tasks.length;
  if (!(rate >= H1_WARM_SUCCESS_RATE_MIN && rate <= H1_WARM_SUCCESS_RATE_MAX)) {
    reasons.push(`task success rate ${rate} is outside ${H1_WARM_SUCCESS_RATE_MIN}..${H1_WARM_SUCCESS_RATE_MAX}`);
  }
  for (const task of tasks) {
    const epochs = new Set<number>();
    for (const id of task.goldFactIds) {
      const fact = facts.get(id);
      if (!fact) reasons.push(`task ${task.taskId} gold fact ${id} does not resolve`);
      else epochs.add(fact.introducedEpoch);
    }
    if (epochs.size < 2) reasons.push(`task ${task.taskId} does not span two epochs`);
  }
  if (store.provenance.generator !== "drift-gen") reasons.push("provenance generator must be drift-gen");
  return {
    ok: reasons.length === 0,
    reasons,
    goldFactCount: factIds.length,
    observedGoldFactCount: observed,
    observedFraction: fraction,
    taskSuccessRate: rate,
    successCounterTotal: successTotal,
    failCounterTotal: failTotal,
  };
}

export function parseOutcomeTask(raw: unknown): OutcomeTask {
  if (!isPlainObject(raw)) throw new Error("outcome task must be a plain object");
  assertExactKeys(raw, TASK_KEYS, "outcome task");
  if (own(raw, "schemaVersion") !== 1) throw new Error("outcome task schemaVersion must be 1");
  const taskId = assertExactText(own(raw, "taskId"), "taskId");
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error(`taskId ${JSON.stringify(taskId)} is not an h1 task id`);
  const userId = assertExactText(own(raw, "userId"), "userId");
  if (!USER_ID_PATTERN.test(userId)) throw new Error(`userId ${JSON.stringify(userId)} is not a drift-gen user id`);
  const instruction = assertExactText(own(raw, "instruction"), "instruction");
  const checkRaw = own(raw, "successCheck");
  if (!isPlainObject(checkRaw)) throw new Error("successCheck must be a plain object");
  assertExactKeys(checkRaw, SUCCESS_CHECK_KEYS, "successCheck");
  if (own(checkRaw, "type") !== "regex") throw new Error("successCheck.type must be regex");
  const value = assertExactText(own(checkRaw, "value"), "successCheck.value");
  const idsRaw = own(raw, "goldFactIds");
  if (!Array.isArray(idsRaw) || idsRaw.length < 2 || idsRaw.length > 4) {
    throw new Error("goldFactIds must contain 2 to 4 ids");
  }
  const goldFactIds: string[] = [];
  const seen = new Set<string>();
  for (const id of idsRaw) {
    const text = assertExactText(id, "goldFactIds entry");
    if (!FACT_ID_PATTERN.test(text)) throw new Error(`gold fact id ${JSON.stringify(text)} is not a drift-gen id`);
    if (seen.has(text)) throw new Error(`duplicate gold fact id ${text}`);
    seen.add(text);
    goldFactIds.push(text);
  }
  return {
    schemaVersion: 1,
    taskId,
    userId,
    instruction,
    successCheck: { type: "regex", value },
    goldFactIds,
  };
}

export function parseOutcomeTasksJsonl(text: string): OutcomeTask[] {
  if (!text.endsWith("\n")) throw new Error("tasks JSONL must end with a newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 0 || lines.some((line) => line.length === 0)) {
    throw new Error("tasks JSONL must be non-empty lines");
  }
  const tasks = lines.map((line) => parseOutcomeTask(JSON.parse(line) as unknown));
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.taskId)) throw new Error(`duplicate task id ${task.taskId}`);
    ids.add(task.taskId);
  }
  return tasks;
}

function parseTrajectoryOutcome(value: unknown, index: number): "success" | "fail" {
  if (value === "success" || value === "fail") return value;
  throw new Error(`trajectory ${index} outcome must be success or fail`);
}

function parseCounter(raw: unknown, label: string): OutcomeWarmCounter {
  if (!isPlainObject(raw)) throw new Error(`${label} must be a plain object`);
  assertExactKeys(raw, COUNTER_KEYS, label);
  return {
    success: assertNonNegativeInt(own(raw, "success"), `${label}.success`),
    fail: assertNonNegativeInt(own(raw, "fail"), `${label}.fail`),
  };
}

export function parseOutcomeWarmStore(raw: unknown): OutcomeWarmStore {
  if (!isPlainObject(raw)) throw new Error("warm store must be a plain object");
  assertExactKeys(raw, WARM_STORE_KEYS, "warm store");
  if (own(raw, "schemaVersion") !== 1) throw new Error("warm store schemaVersion must be 1");
  const provenanceRaw = own(raw, "provenance");
  if (!isPlainObject(provenanceRaw)) throw new Error("warm store provenance must be a plain object");
  assertExactKeys(provenanceRaw, PROVENANCE_KEYS, "warm store provenance");
  if (own(provenanceRaw, "generator") !== "drift-gen") throw new Error("warm store provenance generator must be drift-gen");
  if (own(provenanceRaw, "generatorVersion") !== DRIFT_GEN_VERSION) {
    throw new Error("warm store provenance generatorVersion must match drift-gen");
  }
  if (own(provenanceRaw, "manifestName") !== "drift-gen-core") {
    throw new Error("warm store provenance manifestName must be drift-gen-core");
  }
  if (own(raw, "splitTimestamp") !== H1_WARM_SPLIT_TIMESTAMP) {
    throw new Error("warm store splitTimestamp must be the fixed sentinel");
  }
  const countersRaw = own(raw, "counters");
  if (!isPlainObject(countersRaw)) throw new Error("warm store counters must be a plain object");
  const counters: Record<string, OutcomeWarmCounter> = {};
  for (const id of Object.getOwnPropertyNames(countersRaw)) {
    if (!FACT_ID_PATTERN.test(id)) throw new Error(`warm counter id ${JSON.stringify(id)} is not a drift-gen id`);
    counters[id] = parseCounter(own(countersRaw, id), `counter ${id}`);
  }
  const trajectoriesRaw = own(raw, "trajectories");
  if (!Array.isArray(trajectoriesRaw)) throw new Error("warm store trajectories must be an array");
  const trajectories = trajectoriesRaw.map((entry, index) => {
    if (!isPlainObject(entry)) throw new Error(`trajectory ${index} must be a plain object`);
    assertExactKeys(entry, TRAJECTORY_KEYS, `trajectory ${index}`);
    const taskId = assertExactText(own(entry, "taskId"), `trajectory ${index} taskId`);
    const outcome = parseTrajectoryOutcome(own(entry, "outcome"), index);
    const factIdsRaw = own(entry, "factIds");
    if (!Array.isArray(factIdsRaw) || factIdsRaw.length < 2) {
      throw new Error(`trajectory ${index} factIds must contain at least two ids`);
    }
    const factIds = factIdsRaw.map((id) => {
      const text = assertExactText(id, `trajectory ${index} fact id`);
      if (!FACT_ID_PATTERN.test(text)) throw new Error(`trajectory fact id ${JSON.stringify(text)} is not a drift-gen id`);
      return text;
    });
    return { taskId, outcome, factIds };
  });
  return {
    schemaVersion: 1,
    provenance: {
      generator: "drift-gen",
      generatorVersion: DRIFT_GEN_VERSION,
      manifestName: "drift-gen-core",
    },
    seed: assertPositiveInt(own(raw, "seed"), "warm store seed"),
    users: assertPositiveInt(own(raw, "users"), "warm store users"),
    epochs: assertPositiveInt(own(raw, "epochs"), "warm store epochs"),
    splitTimestamp: H1_WARM_SPLIT_TIMESTAMP,
    counters,
    trajectories,
  };
}

const FACT_REF_REQUIRED = Object.freeze(["id", "userId", "introducedEpoch", "value"] as const);

export function parseOutcomeFactRef(raw: unknown): OutcomeFactRef {
  if (!isPlainObject(raw)) throw new Error("gold fact must be a plain object");
  for (const key of FACT_REF_REQUIRED) {
    if (!Object.hasOwn(raw, key)) throw new Error(`gold fact is missing ${key}`);
  }
  const id = assertExactText(own(raw, "id"), "gold fact id");
  if (!FACT_ID_PATTERN.test(id)) throw new Error(`gold fact id ${JSON.stringify(id)} is not a drift-gen id`);
  const userId = assertExactText(own(raw, "userId"), "gold fact userId");
  if (!USER_ID_PATTERN.test(userId)) throw new Error(`gold fact userId ${JSON.stringify(userId)} is not a drift-gen user id`);
  const introducedEpoch = assertPositiveInt(own(raw, "introducedEpoch"), "gold fact introducedEpoch");
  const value = assertExactText(own(raw, "value"), "gold fact value");
  return { id, userId, introducedEpoch, value };
}

export function loadFactRefsJsonl(text: string): Map<string, OutcomeFactRef> {
  if (!text.endsWith("\n")) throw new Error("facts JSONL must end with a newline");
  const refs = new Map<string, OutcomeFactRef>();
  for (const line of text.slice(0, -1).split("\n")) {
    if (line.length === 0) throw new Error("facts JSONL has an empty line");
    const fact = parseOutcomeFactRef(JSON.parse(line) as unknown);
    if (refs.has(fact.id)) throw new Error(`duplicate gold fact id ${fact.id}`);
    refs.set(fact.id, fact);
  }
  return refs;
}

export function buildCommittedTaskArtifacts(): CommittedTaskArtifacts {
  const full = buildDriftCorpus({ ...H1_FULL_RECIPE });
  const fullTasks = deriveOutcomeTasks(full, {
    factsPerTask: H1_FACTS_PER_TASK,
    idPrefix: "h1t",
    idWidth: 3,
    minTasks: H1_MIN_FULL_TASKS,
    minObservedFraction: H1_MIN_OBSERVED_FRACTION,
  });
  const ci = buildDriftCorpus({ ...H1_CI_RECIPE });
  const ciTasks = deriveOutcomeTasks(ci, {
    factsPerTask: H1_FACTS_PER_TASK,
    idPrefix: "h1t-ci",
    idWidth: 2,
    taskCount: H1_CI_TASK_COUNT,
    minObservedFraction: H1_MIN_OBSERVED_FRACTION,
  });
  const warmStore = warmOutcomeStore(ciTasks, factRefs(ci), H1_CI_RECIPE);
  const verification = verifyOutcomeWarm(ciTasks, factRefs(ci), warmStore);
  if (!verification.ok) {
    throw new Error(`CI warm store failed verification: ${verification.reasons.join("; ")}`);
  }
  const fullVerification = verifyOutcomeWarm(fullTasks, factRefs(full), warmOutcomeStore(fullTasks, factRefs(full), H1_FULL_RECIPE));
  if (!fullVerification.ok) {
    throw new Error(`full warm store failed verification: ${fullVerification.reasons.join("; ")}`);
  }
  return {
    fullTasksJsonl: tasksToJsonl(fullTasks),
    ciTasksJsonl: tasksToJsonl(ciTasks),
    warmStore,
    warmStoreJson: canonicalJson(warmStore),
  };
}
