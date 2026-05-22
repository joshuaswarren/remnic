import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveCausalPromotionCandidates } from "./causal-consolidation.js";
import type { CausalTrajectoryRecord } from "./causal-trajectory.js";

function trajectory(
  id: string,
  sessionKey: string,
  outcomeKind: CausalTrajectoryRecord["outcomeKind"] = "success",
): CausalTrajectoryRecord {
  return {
    schemaVersion: 1,
    trajectoryId: id,
    recordedAt: "2026-05-21T00:00:00.000Z",
    sessionKey,
    goal: "fix the recurring benchmark issue",
    actionSummary: "run the focused regression and patch the boundary",
    observationSummary: "the regression captured the failure",
    outcomeKind,
    outcomeSummary: outcomeKind === "success" ? "the fix passed" : "the fix did not pass",
  };
}

async function withTrajectoryStore<T>(
  trajectories: CausalTrajectoryRecord[],
  run: (dirs: { memoryDir: string; storeDir: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-causal-consolidation-"));
  const storeDir = path.join(root, "causal-store");
  const trajectoriesDir = path.join(storeDir, "trajectories", "2026-05-21");
  await mkdir(trajectoriesDir, { recursive: true });
  for (const record of trajectories) {
    await writeFile(
      path.join(trajectoriesDir, `${record.trajectoryId}.json`),
      JSON.stringify(record, null, 2),
      "utf8",
    );
  }
  try {
    return await run({ memoryDir: root, storeDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function llmStub() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    isAvailable() {
      return true;
    },
    async chatCompletion() {
      calls += 1;
      return {
        content: JSON.stringify({
          rules: [
            {
              content: "Prefer focused regressions before broad benchmark reruns.",
              category: "rule",
              confidence: 0.9,
              evidence: ["t1", "t2"],
            },
          ],
          preferences: [],
        }),
      };
    },
  };
}

function llmWithContent(content: string) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    isAvailable() {
      return true;
    },
    async chatCompletion() {
      calls += 1;
      return { content };
    },
  };
}

test("deriveCausalPromotionCandidates enforces minSessions before LLM consolidation", async () => {
  const llm = llmStub();
  await withTrajectoryStore(
    [trajectory("t1", "same"), trajectory("t2", "same"), trajectory("t3", "same")],
    async ({ memoryDir, storeDir }) => {
      const candidates = await deriveCausalPromotionCandidates({
        memoryDir,
        causalTrajectoryStoreDir: storeDir,
        config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
        llmClient: llm,
      });

      assert.deepEqual(candidates, []);
      assert.equal(llm.calls, 0);
    },
  );
});

test("deriveCausalPromotionCandidates enforces successThreshold before LLM consolidation", async () => {
  const llm = llmStub();
  await withTrajectoryStore(
    [
      trajectory("t1", "a", "success"),
      trajectory("t2", "b", "failure"),
      trajectory("t3", "c", "failure"),
    ],
    async ({ memoryDir, storeDir }) => {
      const candidates = await deriveCausalPromotionCandidates({
        memoryDir,
        causalTrajectoryStoreDir: storeDir,
        config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
        llmClient: llm,
      });

      assert.deepEqual(candidates, []);
      assert.equal(llm.calls, 0);
    },
  );
});

test("deriveCausalPromotionCandidates calls LLM when recurrence session and success gates pass", async () => {
  const llm = llmStub();
  await withTrajectoryStore(
    [
      trajectory("t1", "a", "success"),
      trajectory("t2", "b", "success"),
      trajectory("t3", "c", "partial"),
    ],
    async ({ memoryDir, storeDir }) => {
      const candidates = await deriveCausalPromotionCandidates({
        memoryDir,
        causalTrajectoryStoreDir: storeDir,
        config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
        llmClient: llm,
      });

      assert.equal(llm.calls, 1);
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0]?.content, "Prefer focused regressions before broad benchmark reruns.");
    },
  );
});

test("deriveCausalPromotionCandidates validates LLM-derived rule fields", async () => {
  const llm = llmWithContent(JSON.stringify({
    rules: [
      {
        content: "This invalid category must be dropped.",
        category: "bad",
        confidence: 0.9,
        evidence: ["t1"],
      },
      {
        content: "This invalid confidence must be dropped.",
        category: "rule",
        confidence: "0.9",
        evidence: ["t2"],
      },
      {
        content: "Clamp high confidence and filter evidence values.",
        category: "rule",
        confidence: 999,
        evidence: [123, "t1", "", "t2"],
      },
    ],
    preferences: [
      {
        statement: "Drop invalid preference confidence.",
        confidence: null,
        evidence: ["t3"],
      },
      {
        statement: "The user prefers narrow verification claims.",
        confidence: 0.8,
        evidence: "t3",
      },
    ],
  }));

  await withTrajectoryStore(
    [
      trajectory("t1", "a", "success"),
      trajectory("t2", "b", "success"),
      trajectory("t3", "c", "partial"),
    ],
    async ({ memoryDir, storeDir }) => {
      const candidates = await deriveCausalPromotionCandidates({
        memoryDir,
        causalTrajectoryStoreDir: storeDir,
        config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
        llmClient: llm,
      });

      assert.equal(candidates.length, 2);
      assert.equal(candidates[0]?.score, 1);
      assert.deepEqual(candidates[0]?.provenance, ["t1", "t2"]);
      assert.equal(candidates[1]?.category, "preference");
      assert.deepEqual(candidates[1]?.provenance, []);
    },
  );
});
