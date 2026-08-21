import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { parseConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import {
  recordCausalTrajectory,
  searchCausalTrajectories,
} from "../src/causal-trajectory.js";

async function seedCausalTrajectoryStore(memoryDir: string) {
  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-verification-fix",
      recordedAt: "2026-03-07T12:00:00.000Z",
      sessionKey: "agent:main",
      goal: "Repair verification after the stale thread check failure",
      actionSummary: "Reran unresolved-review-threads and resolved the stale Cursor thread",
      observationSummary: "GitHub reported a green rerun and the PR became merge-ready",
      outcomeKind: "success",
      outcomeSummary: "The PR passed review gates again",
      followUpSummary: "Merge the PR and start trajectory-aware retrieval",
      tags: ["verification", "pr-loop"],
      entityRefs: ["pr:144"],
      objectiveStateSnapshotRefs: ["snap-rerun-thread-check"],
    },
  });

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-unrelated",
      recordedAt: "2026-03-05T09:00:00.000Z",
      sessionKey: "agent:archive",
      goal: "Refresh the README landing page",
      actionSummary: "Updated the docs hero copy",
      observationSummary: "The page rendered correctly",
      outcomeKind: "success",
      outcomeSummary: "Docs copy refresh shipped",
      tags: ["docs"],
      entityRefs: ["page:readme"],
    },
  });
}

async function buildCausalTrajectoryRecallHarness(options: {
  causalTrajectoryRecallEnabled: boolean;
  recallSectionEnabled?: boolean;
}) {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-recall-"));
  await seedCausalTrajectoryStore(memoryDir);

  const cfg = parseConfig({
    openaiApiKey: "test-openai-key",
    memoryDir,
    qmdEnabled: false,
    transcriptEnabled: false,
    sharedContextEnabled: false,
    conversationIndexEnabled: false,
    hourlySummariesEnabled: false,
    injectQuestions: false,
    causalTrajectoryMemoryEnabled: true,
    causalTrajectoryRecallEnabled: options.causalTrajectoryRecallEnabled,
    recallPipeline: [
      {
        id: "causal-trajectories",
        enabled: options.recallSectionEnabled ?? true,
        maxResults: 2,
        maxChars: 1800,
      },
    ],
  });

  return new Orchestrator(cfg);
}

test("searchCausalTrajectories ranks prompt-relevant chains and explains the match", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-search-"));
  await seedCausalTrajectoryStore(memoryDir);

  const results = await searchCausalTrajectories({
    memoryDir,
    query: "Why did the stale thread verification rerun make the PR merge-ready?",
    maxResults: 2,
    sessionKey: "agent:main",
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.record.trajectoryId, "traj-verification-fix");
  assert.match(results[0]?.matchedFields.join(",") ?? "", /goal|action|observation|outcome/i);
});

test("searchCausalTrajectories returns no matches when query normalization strips all tokens", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-causal-trajectory-stopwords-"));
  await seedCausalTrajectoryStore(memoryDir);

  const results = await searchCausalTrajectories({
    memoryDir,
    query: "why did it go?",
    maxResults: 3,
    sessionKey: "agent:main",
  });

  assert.deepEqual(results, []);
});

test("recall injects causal trajectory section when retrieval is enabled", async () => {
  const orchestrator = await buildCausalTrajectoryRecallHarness({
    causalTrajectoryRecallEnabled: true,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did the rerun make the PR merge-ready again?",
    "agent:main",
  );

  assert.match(context, /## Causal Trajectories/);
  assert.match(context, /goal: Repair verification after the stale thread check failure/i);
  assert.match(context, /matched:/i);
  assert.equal(context.includes("## Relevant Memories"), false);
});

test("recall omits causal trajectory section when retrieval flag is disabled", async () => {
  const orchestrator = await buildCausalTrajectoryRecallHarness({
    causalTrajectoryRecallEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did the rerun make the PR merge-ready again?",
    "agent:main",
  );

  assert.equal(context.includes("## Causal Trajectories"), false);
});

test("recall omits causal trajectory section when pipeline section is disabled", async () => {
  const orchestrator = await buildCausalTrajectoryRecallHarness({
    causalTrajectoryRecallEnabled: true,
    recallSectionEnabled: false,
  });

  const context = await (orchestrator as any).recallInternal(
    "Why did the rerun make the PR merge-ready again?",
    "agent:main",
  );

  assert.equal(context.includes("## Causal Trajectories"), false);
});
