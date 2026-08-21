/**
 * Tests for `EngramAccessService.patternReinforcementRun` (issue #687
 * PR 2/4) — specifically the cadence enforcement and force bypass added
 * in PR #730 (Codex P2 review feedback).
 *
 * The MCP-triggered path must delegate to
 * `orchestrator.runPatternReinforcement` so the cadence floor
 * (`patternReinforcementCadenceMs`) is shared with the cron path.
 * Operators must be able to bypass the cadence with `force: true` for
 * ad-hoc runs — mirroring the pattern used by other maintenance tools.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EngramAccessService } from "../src/access-service.js";

function createOrchestratorStub(opts: { enabled?: boolean } = {}) {
  const calls: Array<{ namespace?: string; force?: boolean }> = [];
  // Simulate the orchestrator's per-namespace cadence behaviour.  The
  // stub returns "ran: true" on first call per ns, then "skippedReason:
  // cadence" on a second call within the cadence window — UNLESS
  // `force: true`.
  const lastRunAt = new Map<string, number>();
  const cadence = 60_000;
  const orchestrator = {
    config: {
      memoryDir: "/tmp/engram",
      namespacesEnabled: false,
      defaultNamespace: "global",
      sharedNamespace: "shared",
      principalFromSessionKeyMode: "prefix",
      principalFromSessionKeyRules: [],
      namespacePolicies: [],
      defaultRecallNamespaces: ["self"],
      searchBackend: "qmd",
      qmdEnabled: true,
      nativeKnowledge: undefined,
      patternReinforcementEnabled: opts.enabled ?? true,
      patternReinforcementCadenceMs: cadence,
      patternReinforcementCategories: ["fact"],
      patternReinforcementMinCount: 2,
    },
    recall: async () => "ctx",
    lastRecall: { get: () => null, getMostRecent: () => null },
    getStorage: async () => ({}) as any,
    runPatternReinforcement: async (
      input: { namespace?: string; force?: boolean } = {},
    ) => {
      calls.push(input);
      if (!orchestrator.config.patternReinforcementEnabled && !input.force) {
        return {
          ran: false,
          skippedReason: "disabled" as const,
          namespace: input.namespace ?? "",
        };
      }
      const key = input.namespace ?? "";
      const last = lastRunAt.get(key);
      if (
        !input.force &&
        cadence > 0 &&
        last !== undefined &&
        Date.now() - last < cadence
      ) {
        return { ran: false, skippedReason: "cadence" as const, namespace: key };
      }
      lastRunAt.set(key, Date.now());
      return {
        ran: true,
        namespace: key,
        result: {
          clustersFound: 1,
          canonicalsUpdated: 1,
          duplicatesSuperseded: 2,
          clusters: [],
        },
      };
    },
  };
  return { orchestrator, calls };
}

test("patternReinforcementRun: second call inside cadence returns skippedReason=cadence", async () => {
  const { orchestrator, calls } = createOrchestratorStub();
  const service = new EngramAccessService(orchestrator as any);

  const first = await service.patternReinforcementRun({});
  assert.equal(first.ran, true);
  assert.equal(first.clustersFound, 1);

  // Immediate second call — must hit the cadence floor.
  const second = await service.patternReinforcementRun({});
  assert.equal(second.ran, false);
  assert.equal(second.skippedReason, "cadence");
  assert.equal(second.clustersFound, 0);
  // Both calls reach the orchestrator (which owns the gate).
  assert.equal(calls.length, 2);
  assert.equal(calls[1].force, false);
});

test("patternReinforcementRun: force=true bypasses cadence floor", async () => {
  const { orchestrator, calls } = createOrchestratorStub();
  const service = new EngramAccessService(orchestrator as any);

  const first = await service.patternReinforcementRun({});
  assert.equal(first.ran, true);

  // force=true bypasses the cadence — second call must run.
  const forced = await service.patternReinforcementRun({ force: true });
  assert.equal(forced.ran, true);
  assert.equal(forced.skippedReason, undefined);
  // Most importantly: the orchestrator received force=true.
  assert.equal(calls[1].force, true);
});

test("patternReinforcementRun: when feature disabled returns skippedReason=disabled without throwing", async () => {
  const { orchestrator } = createOrchestratorStub({ enabled: false });
  const service = new EngramAccessService(orchestrator as any);

  const result = await service.patternReinforcementRun({});
  assert.equal(result.ran, false);
  assert.equal(result.skippedReason, "disabled");
  assert.equal(result.clustersFound, 0);
});
