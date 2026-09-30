import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDriftCorpus, generateDriftCorpus } from "../generators/drift-gen/index.js";
import type { DriftGenCorpus } from "../generators/drift-gen/types.js";
import {
  H1_CI_RECIPE,
  H1_CI_TASK_COUNT,
  H1_FULL_RECIPE,
  H1_MIN_FULL_TASKS,
  H1_MIN_OBSERVED_FRACTION,
  buildCommittedTaskArtifacts,
  h1OutcomeFixtureRoot,
  parseOutcomeTask,
  parseOutcomeTasksJsonl,
  verifyOutcomeWarm,
  warmOutcomeStore,
  type OutcomeFactRef,
} from "./outcome-prior-corpus.js";

function refs(corpus: DriftGenCorpus): Map<string, OutcomeFactRef> {
  const facts = new Map<string, OutcomeFactRef>();
  for (const fact of corpus.facts) {
    facts.set(fact.id, {
      id: fact.id,
      userId: fact.userId,
      introducedEpoch: fact.introducedEpoch,
      value: fact.value,
    });
  }
  return facts;
}

test("committed task family and CI snapshot match the drift-gen recipes", async () => {
  const root = h1OutcomeFixtureRoot();
  const artifacts = buildCommittedTaskArtifacts();
  const fullText = readFileSync(path.join(root, "tasks.jsonl"), "utf8");
  const ciText = readFileSync(path.join(root, "corpus-ci", "tasks.jsonl"), "utf8");
  const warmText = readFileSync(path.join(root, "corpus-ci", "warm-store.json"), "utf8");
  assert.equal(fullText, artifacts.fullTasksJsonl);
  assert.equal(ciText, artifacts.ciTasksJsonl);
  assert.equal(warmText, artifacts.warmStoreJson);

  const fullTasks = parseOutcomeTasksJsonl(fullText);
  const ciTasks = parseOutcomeTasksJsonl(ciText);
  assert.ok(fullTasks.length >= H1_MIN_FULL_TASKS);
  assert.equal(ciTasks.length, H1_CI_TASK_COUNT);
  for (const task of [...fullTasks, ...ciTasks]) {
    assert.equal(task.successCheck.type, "regex");
    assert.ok(task.goldFactIds.length >= 2);
  }

  const fullFacts = refs(buildDriftCorpus({ ...H1_FULL_RECIPE }));
  const fullWarm = warmOutcomeStore(fullTasks, fullFacts, H1_FULL_RECIPE);
  const fullReport = verifyOutcomeWarm(fullTasks, fullFacts, fullWarm);
  assert.equal(fullReport.ok, true, fullReport.reasons.join("; "));
  assert.ok(fullReport.observedFraction >= H1_MIN_OBSERVED_FRACTION);
  assert.ok(fullReport.successCounterTotal > 0);
  assert.ok(fullReport.failCounterTotal > 0);

  const ciFacts = refs(buildDriftCorpus({ ...H1_CI_RECIPE }));
  const ciReport = verifyOutcomeWarm(ciTasks, ciFacts, artifacts.warmStore);
  assert.equal(ciReport.ok, true, ciReport.reasons.join("; "));
  const ciIds = new Set(ciFacts.keys());
  assert.equal(fullTasks.every((task) => task.goldFactIds.every((id) => ciIds.has(id))), false);

  const scratch = await mkdtemp(path.join(tmpdir(), "h1-outcome-ci-"));
  try {
    await generateDriftCorpus({ ...H1_CI_RECIPE, outDir: scratch });
    for (const rel of [
      "dataset.manifest.json",
      "21/gold/facts.jsonl",
      "21/gold/probes.jsonl",
      "21/users/u1/sessions.jsonl",
      "21/users/u2/sessions.jsonl",
    ]) {
      const committed = readFileSync(path.join(root, "corpus-ci", rel), "utf8");
      const fresh = await readFile(path.join(scratch, rel), "utf8");
      assert.equal(committed, fresh, rel);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("warm verification rejects an all-success store and a counter mismatch", () => {
  const tasks = parseOutcomeTasksJsonl(buildCommittedTaskArtifacts().ciTasksJsonl);
  const facts = refs(buildDriftCorpus({ ...H1_CI_RECIPE }));
  const store = warmOutcomeStore(tasks, facts, H1_CI_RECIPE);

  const allSuccess = structuredClone(store);
  for (const id of Object.getOwnPropertyNames(allSuccess.counters)) {
    const counter = allSuccess.counters[id];
    if (!counter) continue;
    counter.success += counter.fail;
    counter.fail = 0;
  }
  for (const trajectory of allSuccess.trajectories) trajectory.outcome = "success";
  const noFailures = verifyOutcomeWarm(tasks, facts, allSuccess);
  assert.equal(noFailures.ok, false);
  assert.equal(noFailures.reasons.some((reason) => reason.includes("no failure counters")), true);

  const mismatched = structuredClone(store);
  const firstId = Object.getOwnPropertyNames(mismatched.counters)[0];
  assert.ok(firstId);
  const counter = mismatched.counters[firstId];
  assert.ok(counter);
  counter.success += 1;
  const mismatch = verifyOutcomeWarm(tasks, facts, mismatched);
  assert.equal(mismatch.ok, false);
  assert.equal(
    mismatch.reasons.some((reason) => reason.includes("counter totals do not equal")),
    true,
  );
});

test("task parsing rejects a whitespace-padded fact id and an unhandled check type", () => {
  const base = {
    schemaVersion: 1,
    taskId: "h1t-ci-01",
    userId: "u1",
    instruction: "Report the recorded value of each cited fact.",
    successCheck: { type: "regex", value: "alpha" },
    goldFactIds: ["gf-u1-1-1", "gf-u1-2-1"],
  };
  assert.throws(
    () => parseOutcomeTask({ ...base, goldFactIds: [" gf-u1-1-1", "gf-u1-2-1"] }),
    /surrounding whitespace/,
  );
  assert.throws(
    () => parseOutcomeTask({ ...base, successCheck: { type: "tool-called", value: "alpha" } }),
    /successCheck.type must be regex/,
  );
});
