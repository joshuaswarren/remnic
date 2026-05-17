import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  deriveCausalPromotionCandidates,
  synthesizeCausalPreferencesViaLlm,
} from "../src/causal-consolidation.js";
import { parseConfig } from "../src/config.js";
import { recordCausalTrajectory, type CausalTrajectoryRecord } from "../src/causal-trajectory.js";
import type { GatewayConfig } from "../src/types.js";

type ChatCompletionRequest = {
  messages: Array<{ role: string; content: string }>;
};

function testGatewayConfig(): GatewayConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "test-provider/test-model",
        },
      },
    },
    models: {
      providers: {
        "test-provider": {
          baseUrl: "http://llm.test/v1",
          api: "openai-completions",
          apiKey: "test-key",
          models: [],
        },
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("deriveCausalPromotionCandidates returns empty for empty store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-empty-"));
  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
    // No gatewayConfig — LLM not available, should return empty
  });
  assert.equal(candidates.length, 0);
});

test("deriveCausalPromotionCandidates returns empty when too few trajectories", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-few-"));

  await recordCausalTrajectory({
    memoryDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-1",
      recordedAt: new Date().toISOString(),
      sessionKey: "session-1",
      goal: "Fix auth",
      actionSummary: "Patched handler",
      observationSummary: "Tests pass",
      outcomeKind: "success",
      outcomeSummary: "Done",
    },
  });

  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
  });
  assert.equal(candidates.length, 0, "Should need at least minRecurrence trajectories");
});

test("deriveCausalPromotionCandidates returns empty without LLM when trajectories exist", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-nollm-"));

  for (let i = 0; i < 3; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-${i}`,
        recordedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
        sessionKey: `session-${i}`,
        goal: "Fix authentication error handling",
        actionSummary: "Updated login handler",
        observationSummary: "Tests pass",
        outcomeKind: "success",
        outcomeSummary: "Auth fixed",
      },
    });
  }

  // No gatewayConfig — LLM not available
  const candidates = await deriveCausalPromotionCandidates({
    memoryDir,
    config: { minRecurrence: 3, minSessions: 2, successThreshold: 0.7 },
  });
  assert.equal(candidates.length, 0, "Without LLM, should return empty");
});

test("deriveCausalPromotionCandidates reads trajectories from parsed config store dir", async (t) => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-consol-config-dir-"));
  const cfg = parseConfig({ memoryDir });
  assert.equal(
    cfg.causalTrajectoryStoreDir,
    path.join(memoryDir, "state", "causal-trajectories"),
  );

  await recordCausalTrajectory({
    memoryDir: cfg.memoryDir,
    causalTrajectoryStoreDir: cfg.causalTrajectoryStoreDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-config-a",
      recordedAt: new Date("2026-05-01T10:00:00.000Z").toISOString(),
      sessionKey: "session-a",
      goal: "Fix authentication regression",
      actionSummary: "Added regression tests before refactoring the handler",
      observationSummary: "The focused test caught the stale branch",
      outcomeKind: "success",
      outcomeSummary: "Authentication regression fixed",
    },
  });

  await recordCausalTrajectory({
    memoryDir: cfg.memoryDir,
    causalTrajectoryStoreDir: cfg.causalTrajectoryStoreDir,
    record: {
      schemaVersion: 1,
      trajectoryId: "traj-config-b",
      recordedAt: new Date("2026-05-02T10:00:00.000Z").toISOString(),
      sessionKey: "session-b",
      goal: "Fix authentication follow-up",
      actionSummary: "Kept the regression test while simplifying the handler",
      observationSummary: "The second pass stayed green",
      outcomeKind: "success",
      outcomeSummary: "Follow-up authentication fix landed",
    },
  });

  const requests: ChatCompletionRequest[] = [];
  const originalFetch = globalThis.fetch;
  const mockFetch: typeof fetch = async (_input, init) => {
    if (typeof init?.body === "string") {
      requests.push(JSON.parse(init.body) as ChatCompletionRequest);
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                rules: [
                  {
                    content: "When fixing auth bugs, add regression tests before refactoring.",
                    category: "rule",
                    confidence: 0.92,
                    evidence: ["traj-config-a", "traj-config-b"],
                  },
                ],
                preferences: [],
              }),
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  globalThis.fetch = mockFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const candidates = await deriveCausalPromotionCandidates({
    memoryDir: cfg.memoryDir,
    causalTrajectoryStoreDir: cfg.causalTrajectoryStoreDir,
    config: { minRecurrence: 2, minSessions: 1, successThreshold: 0.7 },
    gatewayConfig: testGatewayConfig(),
  });

  assert.equal(requests.length, 1, "expected consolidation to call the LLM with recorded trajectories");
  assert.match(requests[0].messages[1].content, /Fix authentication regression/);
  assert.match(requests[0].messages[1].content, /Fix authentication follow-up/);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].provenance, ["traj-config-a", "traj-config-b"]);
});

test("synthesizeCausalPreferencesViaLlm returns null for empty store", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-pref-empty-"));
  const result = await synthesizeCausalPreferencesViaLlm({ memoryDir });
  assert.equal(result, null);
});

test("synthesizeCausalPreferencesViaLlm returns null without LLM", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-pref-nollm-"));

  for (let i = 0; i < 3; i++) {
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: `traj-pref-${i}`,
        recordedAt: new Date().toISOString(),
        sessionKey: `session-${i}`,
        goal: "Use TypeScript for frontend",
        actionSummary: "Created React component in TypeScript",
        observationSummary: "Type checks pass",
        outcomeKind: "success",
        outcomeSummary: "Component works",
      },
    });
  }

  const result = await synthesizeCausalPreferencesViaLlm({ memoryDir });
  assert.equal(result, null, "Without LLM, should return null");
});
