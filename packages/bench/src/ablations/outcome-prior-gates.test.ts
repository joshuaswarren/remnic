import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { rerankWithOutcomePrior } from "@remnic/core/rerank-outcome.js";
import { loadOutcomePriorArms, runOutcomePriorScaffoldCli } from "./outcome-prior.js";
import { hashCanonical } from "./outcome-prior-corpus.js";
import {
  loadCiSnapshot,
  rankSmokeByArm,
  runOutcomePriorPreMainGates,
  smokeIsArmOrderInvariant,
} from "./outcome-prior-gates.js";

test("fake-model smoke matches twice, ignores arm order, and keeps the warm-store hash", async () => {
  const arms = loadOutcomePriorArms();
  const { tasks, facts, store } = loadCiSnapshot();
  const before = hashCanonical(store);
  const forward = rankSmokeByArm(tasks, facts, store, arms);
  const reversed = rankSmokeByArm(tasks, facts, store, [...arms].reverse());
  const again = rankSmokeByArm(tasks, facts, store, arms);
  assert.match(forward.hash, /^[0-9a-f]{64}$/);
  assert.equal(forward.hash, again.hash);
  assert.equal(forward.hash, reversed.hash);
  assert.equal(forward.warmStoreHash, before);
  assert.equal(again.warmStoreHash, before);
  assert.equal(reversed.warmStoreHash, before);
  assert.equal(hashCanonical(store), before);
  for (const id of Object.getOwnPropertyNames(forward.byArm)) {
    assert.equal(hashCanonical(forward.byArm[id]), hashCanonical(reversed.byArm[id]));
  }
  assert.notEqual(hashCanonical(forward.byArm["h1-w0"]), hashCanonical(forward.byArm["h1-w050"]));

  const shown = forward.byArm["h1-w050"]?.[0]?.top.find((row) => row.state === "OBSERVED");
  assert.ok(shown);
  const mutated = structuredClone(store);
  const counter = mutated.counters[shown.id];
  assert.ok(counter);
  counter.fail += 1;
  const mutatedSmoke = rankSmokeByArm(tasks, facts, mutated, arms);
  assert.notEqual(mutatedSmoke.hash, forward.hash);
  assert.notEqual(mutatedSmoke.warmStoreHash, forward.warmStoreHash);

  const gates = await runOutcomePriorPreMainGates(arms);
  assert.equal(gates.ok, true, gates.reasons.join("; "));
  assert.equal(gates.repeated, true);
  assert.equal(gates.armOrderInvariant, true);
  assert.equal(gates.warmStoreImmutable, true);
  assert.equal(gates.smokeHash, forward.hash);
  assert.equal(gates.warmStoreHash, before);
});

test("scaffold --gates reports the smoke hash and does not run an experiment", async () => {
  const result = await runOutcomePriorScaffoldCli(["--gates"]);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.runsExecuted, 0);
  assert.equal(result.h1b, "NOT RUN");
  assert.match(result.message, /no experiment runs/);
  assert.match(result.gates?.smokeHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(result.gates?.repeated, true);
  assert.equal(result.gates?.armOrderInvariant, true);
  assert.equal(result.gates?.warmStoreImmutable, true);
  assert.deepEqual(result.armIds, ["h1-w0", "h1-w015", "h1-w030", "h1-w050", "memory-worth-base"]);
});

test("arm-order and warm-store gates go red when ranking is order-dependent or mutates", async () => {
  const arms = loadOutcomePriorArms().filter((arm) => arm.id === "h1-w0" || arm.id === "h1-w050");
  const { tasks, facts, store } = loadCiSnapshot();
  const makeRank = (): typeof rerankWithOutcomePrior => {
    let calls = 0;
    return (candidates, weight) => {
      const ranked = rerankWithOutcomePrior(candidates, weight);
      const bump = calls;
      calls += 1;
      return ranked.map((row) => ({ ...row, score: row.score + bump }));
    };
  };
  const forward = rankSmokeByArm(tasks, facts, structuredClone(store), arms, makeRank());
  const reversed = rankSmokeByArm(tasks, facts, structuredClone(store), [...arms].reverse(), makeRank());
  assert.equal(smokeIsArmOrderInvariant(forward, reversed), false);

  const mutable = structuredClone(store);
  const factId = tasks[0]?.goldFactIds[0];
  assert.ok(factId);
  assert.throws(
    () =>
      rankSmokeByArm(tasks, facts, mutable, arms.slice(0, 1), (candidates, weight) => {
        const counter = mutable.counters[factId];
        if (counter) counter.fail += 1;
        return rerankWithOutcomePrior(candidates, weight);
      }),
    /warm store changed/,
  );

  const root = await mkdtemp(path.join(tmpdir(), "h1-gates-"));
  try {
    const gates = await runOutcomePriorPreMainGates(loadOutcomePriorArms(), root);
    assert.equal(gates.ok, false);
    assert.equal(gates.smokeHash, "");
    assert.equal(gates.warmStoreHash, "");
    assert.equal(gates.repeated, false);
    assert.equal(gates.armOrderInvariant, false);
    assert.equal(gates.warmStoreImmutable, false);
    assert.ok(gates.reasons.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
