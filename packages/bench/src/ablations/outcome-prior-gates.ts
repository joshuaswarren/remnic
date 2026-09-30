/**
 * Pre-main gates for H1 (issue #1958, plan step 5).
 *
 * The fake model ranks the CI snapshot twice and in reversed arm order.
 * The smoke hash must match, and the warm-store hash must be unchanged
 * after every arm. This does not write result JSONL and does not decide H1.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { rerankWithOutcomePrior } from "@remnic/core/rerank-outcome.js";
import type { OutcomePriorArm } from "./outcome-prior.js";
import { validateDriftCorpus } from "../generators/drift-gen/validate.js";
import {
  H1_CI_RECIPE,
  H1_CI_TASK_COUNT,
  hashCanonical,
  h1OutcomeFixtureRoot,
  loadFactRefsJsonl,
  parseOutcomeTasksJsonl,
  parseOutcomeWarmStore,
  verifyOutcomeWarm,
  type OutcomeFactRef,
  type OutcomeTask,
  type OutcomeWarmStore,
} from "./outcome-prior-corpus.js";

export interface SmokeArmRow {
  taskId: string;
  top: Array<{ id: string; score: number; state: string }>;
}

export interface FakeModelSmoke {
  hash: string;
  warmStoreHash: string;
  byArm: Record<string, SmokeArmRow[]>;
}

export interface PreMainGateResult {
  ok: boolean;
  reasons: string[];
  smokeHash: string;
  warmStoreHash: string;
  repeated: boolean;
  armOrderInvariant: boolean;
  warmStoreImmutable: boolean;
}

function textScore(taskId: string, factId: string): number {
  const digest = createHash("sha256").update(`${taskId}\0${factId}`).digest();
  return digest.readUInt32BE(0) / 4294967296;
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function rankSmokeByArm(
  tasks: readonly OutcomeTask[],
  facts: ReadonlyMap<string, OutcomeFactRef>,
  store: OutcomeWarmStore,
  arms: readonly OutcomePriorArm[],
): FakeModelSmoke {
  const hashes = [hashCanonical(store)];
  const byArm: Record<string, SmokeArmRow[]> = {};
  const k = arms[0]?.retrieval.k ?? 0;
  for (const arm of arms) {
    if (arm.retrieval.k !== k) throw new Error("smoke arms must share one k");
    const rows: SmokeArmRow[] = [];
    for (const task of tasks) {
      const candidates = [...facts.values()]
        .filter((fact) => fact.userId === task.userId)
        .sort((left, right) => compareText(left.id, right.id))
        .map((fact) => {
          const counter = Object.hasOwn(store.counters, fact.id) ? store.counters[fact.id] : undefined;
          return {
            item: fact.id,
            textScore: textScore(task.taskId, fact.id),
            success: counter?.success,
            fail: counter?.fail,
          };
        });
      const ranked = rerankWithOutcomePrior(candidates, arm.outcomeBoostWeight);
      const top = ranked.slice(0, arm.retrieval.k).map((row) => ({
        id: row.item,
        score: row.score,
        state: row.state,
      }));
      rows.push({ taskId: task.taskId, top });
    }
    byArm[arm.id] = rows;
    hashes.push(hashCanonical(store));
  }
  const warmStoreHash = hashes[0] ?? "";
  if (hashes.some((hash) => hash !== warmStoreHash)) {
    throw new Error("warm store changed while ranking an arm");
  }
  return {
    hash: createHash("sha256").update(hashCanonical(byArm)).digest("hex"),
    warmStoreHash,
    byArm,
  };
}

export function loadCiSnapshot(root = h1OutcomeFixtureRoot()): {
  tasks: OutcomeTask[];
  facts: Map<string, OutcomeFactRef>;
  store: OutcomeWarmStore;
} {
  const dir = path.join(root, "corpus-ci");
  const tasks = parseOutcomeTasksJsonl(readFileSync(path.join(dir, "tasks.jsonl"), "utf8"));
  const facts = loadFactRefsJsonl(readFileSync(path.join(dir, String(H1_CI_RECIPE.seed), "gold", "facts.jsonl"), "utf8"));
  const store = parseOutcomeWarmStore(JSON.parse(readFileSync(path.join(dir, "warm-store.json"), "utf8")) as unknown);
  return { tasks, facts, store };
}

function sameRows(left: readonly SmokeArmRow[], right: readonly SmokeArmRow[]): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

export async function runOutcomePriorPreMainGates(
  arms: readonly OutcomePriorArm[],
  root = h1OutcomeFixtureRoot(),
): Promise<PreMainGateResult> {
  const reasons: string[] = [];
  const corpusDir = path.join(root, "corpus-ci");
  const report = await validateDriftCorpus(corpusDir);
  if (!report.ok) reasons.push(...report.errors.map((error) => `drift-gen: ${error}`));
  if (report.stats.users !== H1_CI_RECIPE.users || report.stats.epochs !== H1_CI_RECIPE.epochs) {
    reasons.push("CI snapshot is not 2 users and 4 epochs");
  }
  const { tasks, facts, store } = loadCiSnapshot(root);
  if (tasks.length !== H1_CI_TASK_COUNT) reasons.push(`CI snapshot has ${tasks.length} tasks, need ${H1_CI_TASK_COUNT}`);
  if (store.seed !== H1_CI_RECIPE.seed || store.users !== H1_CI_RECIPE.users || store.epochs !== H1_CI_RECIPE.epochs) {
    reasons.push("warm store recipe does not match the CI snapshot");
  }
  const verification = verifyOutcomeWarm(tasks, facts, store);
  if (!verification.ok) reasons.push(...verification.reasons);
  const forward = rankSmokeByArm(tasks, facts, store, arms);
  const reversed = rankSmokeByArm(tasks, facts, store, [...arms].reverse());
  const repeated = rankSmokeByArm(tasks, facts, store, arms);
  const armOrderInvariant = forward.hash === reversed.hash && Object.getOwnPropertyNames(forward.byArm).every((id) => {
    const left = forward.byArm[id];
    const right = reversed.byArm[id];
    return left !== undefined && right !== undefined && sameRows(left, right);
  });
  const hashesMatch = forward.hash === repeated.hash && forward.warmStoreHash === repeated.warmStoreHash;
  if (!armOrderInvariant) reasons.push("arm order changed the smoke hash");
  if (!hashesMatch) reasons.push("repeated fake-model smoke hashes differ");
  if (forward.warmStoreHash !== reversed.warmStoreHash) reasons.push("warm store hash changed across arm order");
  return {
    ok: reasons.length === 0,
    reasons,
    smokeHash: forward.hash,
    warmStoreHash: forward.warmStoreHash,
    repeated: hashesMatch,
    armOrderInvariant,
    warmStoreImmutable: forward.warmStoreHash === reversed.warmStoreHash && forward.warmStoreHash === repeated.warmStoreHash,
  };
}
