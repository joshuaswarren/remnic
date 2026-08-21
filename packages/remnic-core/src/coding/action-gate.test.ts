import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordCausalTrajectory } from "../causal-trajectory.js";
import type { CodingContext, MemoryFile } from "../types.js";
import {
  ACTION_GATE_DEFAULTS,
  type ActionGateAuditRecord,
  type ActionGateCandidateSource,
  type ActionGateRequest,
  ActionGateService,
  actionTermsFor,
  createFailureMemoryCandidateSource,
  createTrajectoryCandidateSource,
  isFailureClassMemory,
  parseActionGateConfig,
} from "./action-gate.js";
import { PreActionFailureGate, normalizeActionIntent } from "./pre-action-gate.js";

const codingContext: CodingContext = {
  projectId: "proj-gate",
  branch: "main",
  rootPath: "/work/project",
  defaultBranch: null,
};

function memory(id: string, content: string, overrides: Record<string, unknown> = {}): MemoryFile {
  return {
    path: `facts/2026-08-18/${id}.md`,
    content,
    frontmatter: {
      id,
      category: "correction",
      created: "2026-08-18T00:00:00Z",
      updated: "2026-08-18T00:00:00Z",
      source: "test",
      confidence: 0.9,
      confidenceTier: "explicit",
      tags: [],
      status: "active",
      ...overrides,
    } as MemoryFile["frontmatter"],
  };
}

function request(overrides: Partial<ActionGateRequest> = {}): ActionGateRequest {
  return {
    sessionKey: "session-a",
    turnId: "turn-1",
    strategyId: "RUN_CHECK",
    intent: { kind: "command", command: "pnpm", args: ["migrate", "--force"] },
    codingContext,
    memoryDir: "/tmp/does-not-matter",
    ...overrides,
  };
}

function staticSource(id: string, memoryIds: string[]): ActionGateCandidateSource {
  return {
    id,
    async find() {
      return {
        ok: true,
        candidates: memoryIds.map((memoryId, index) => ({
          memoryId,
          score: memoryIds.length - index,
          advisoryText: `advisory for ${memoryId}`,
        })),
      };
    },
  };
}

test("parses the actionGate block with safe defaults and zero-limit semantics", () => {
  assert.deepEqual(parseActionGateConfig(undefined), ACTION_GATE_DEFAULTS);
  assert.equal(parseActionGateConfig(undefined).enabled, false);
  // CLI values arrive as strings.
  assert.equal(parseActionGateConfig({ enabled: "false" }).enabled, false);
  assert.equal(parseActionGateConfig({ enabled: "on" }).enabled, true);
  assert.equal(parseActionGateConfig({ maxAdvisoriesPerTurn: "0" }).maxAdvisoriesPerTurn, 0);
  assert.equal(parseActionGateConfig({ timeoutMs: "120" }).timeoutMs, 120);
  assert.equal(parseActionGateConfig({ timeoutMs: 0 }).timeoutMs, 1);
  assert.throws(() => parseActionGateConfig({ enabled: "maybe" }), /actionGate.enabled/);
  assert.throws(() => parseActionGateConfig([]), /must be an object/);
  assert.throws(() => parseActionGateConfig(null), /must be an object/);
});

test("disabled gate performs no lookup on any path", async () => {
  let calls = 0;
  const source: ActionGateCandidateSource = {
    id: "spy",
    async find() {
      calls += 1;
      return { ok: true, candidates: [{ memoryId: "m1", advisoryText: "never" }] };
    },
  };
  const audits: ActionGateAuditRecord[] = [];
  const disabled = new ActionGateService(parseActionGateConfig({}), {
    sources: [source],
    audit: (record) => void audits.push(record),
  });
  const decision = await disabled.evaluate(request());
  assert.equal(decision.status, "DISABLED");
  assert.deepEqual(decision.advisories, []);
  assert.equal(calls, 0);
  assert.deepEqual(disabled.suppressedForTurnStart("session-a"), []);
  disabled.noteTurnStartDelivery("session-a", ["m1"]);
  assert.deepEqual(disabled.suppressedForTurnStart("session-a"), []);

  const zeroBudget = new ActionGateService(parseActionGateConfig({ enabled: true, maxAdvisoriesPerTurn: 0 }), {
    sources: [source],
  });
  const zeroDecision = await zeroBudget.evaluate(request());
  assert.equal(zeroDecision.status, "DISABLED");
  assert.match(zeroDecision.reason ?? "", /maxAdvisoriesPerTurn is 0/);
  assert.equal(calls, 0);
});

test("delivers one bounded advisory and suppresses it from turn-start recall", async () => {
  const audits: ActionGateAuditRecord[] = [];
  const service = new ActionGateService(parseActionGateConfig({ enabled: true }), {
    sources: [
      createFailureMemoryCandidateSource({
        async listMemories() {
          return [
            memory("mem-match", "Running pnpm migrate --force dropped the dev database."),
            memory("mem-other", "Unrelated note about documentation."),
            memory("mem-archived", "pnpm migrate --force failed again", { status: "archived" }),
          ];
        },
      }),
    ],
    audit: (record) => void audits.push(record),
  });

  const decision = await service.evaluate(request());
  assert.equal(decision.status, "MATCH_WARN");
  assert.equal(decision.advisories.length, 1);
  assert.equal(decision.advisories[0].memoryId, "mem-match");
  assert.equal(decision.advisories[0].sourceId, "failure-memory");
  assert.match(decision.advisories[0].text, /dropped the dev database/);
  assert.ok(decision.advisories[0].text.length <= 400);
  assert.deepEqual(decision.degradations, []);

  // Double-delivery suppression: turn-start recall must skip what the gate sent.
  assert.deepEqual(service.suppressedForTurnStart("session-a"), ["mem-match"]);

  // Same turn, same action: deduplicated per fact per turn.
  const repeat = await service.evaluate(request());
  assert.deepEqual(repeat.advisories, []);
  assert.deepEqual(repeat.suppressedIds, ["mem-match"]);
  assert.equal(repeat.status, "NO_MATCH");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[0].deliveredIds, ["mem-match"]);
  assert.deepEqual(audits[1].suppressedIds, ["mem-match"]);
  assert.match(audits[0].fingerprint ?? "", /^v1:sha256:/);
});

test("skips candidates turn-start recall already delivered", async () => {
  const service = new ActionGateService(parseActionGateConfig({ enabled: true }), {
    sources: [staticSource("static", ["mem-a"])],
  });
  service.noteTurnStartDelivery("session-a", ["mem-a"]);
  const decision = await service.evaluate(request());
  assert.equal(decision.status, "NO_MATCH");
  assert.deepEqual(decision.suppressedIds, ["mem-a"]);
  assert.deepEqual(decision.advisories, []);
});

test("caps advisories per turn and resets the budget on the next turn", async () => {
  const service = new ActionGateService(parseActionGateConfig({ enabled: true, maxAdvisoriesPerTurn: 2 }), {
    sources: [staticSource("static", ["mem-a", "mem-b", "mem-c"])],
  });
  const first = await service.evaluate(request());
  assert.deepEqual(
    first.advisories.map((advisory) => advisory.memoryId),
    ["mem-a", "mem-b"]
  );
  assert.deepEqual(first.suppressedIds, ["mem-c"]);

  const nextTurn = await service.evaluate(request({ turnId: "turn-2" }));
  // A new turn re-arms the budget: proposing the same action again warns again,
  // which is the whole point of action-site delivery.
  assert.deepEqual(
    nextTurn.advisories.map((advisory) => advisory.memoryId),
    ["mem-a", "mem-b"]
  );
  assert.deepEqual(nextTurn.suppressedIds, ["mem-c"]);
});

test("namespace scoping keeps advisories inside the requesting principal", async () => {
  const byNamespace: Record<string, MemoryFile[]> = {
    "tenant-a": [memory("mem-a", "pnpm migrate --force wiped tenant a data")],
    "tenant-b": [memory("mem-b", "pnpm migrate --force wiped tenant b data")],
  };
  const service = new ActionGateService(parseActionGateConfig({ enabled: true }), {
    sources: [
      createFailureMemoryCandidateSource({
        async listMemories({ namespace }) {
          return byNamespace[namespace ?? ""] ?? [];
        },
      }),
    ],
  });
  const a = await service.evaluate(request({ sessionKey: "s-a", namespace: "tenant-a" }));
  const b = await service.evaluate(request({ sessionKey: "s-b", namespace: "tenant-b" }));
  assert.deepEqual(
    a.advisories.map((advisory) => advisory.memoryId),
    ["mem-a"]
  );
  assert.deepEqual(
    b.advisories.map((advisory) => advisory.memoryId),
    ["mem-b"]
  );
});

test("source failure fails open with a distinct status and audit degradation", async () => {
  const audits: ActionGateAuditRecord[] = [];
  const service = new ActionGateService(parseActionGateConfig({ enabled: true }), {
    sources: [
      {
        id: "broken",
        async find() {
          throw new Error("store unreadable");
        },
      },
    ],
    audit: (record) => void audits.push(record),
  });
  const decision = await service.evaluate(request());
  assert.equal(decision.status, "ERROR_FAIL_OPEN");
  assert.deepEqual(decision.advisories, []);
  assert.match(decision.degradations[0], /broken: store unreadable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audits[0].status, "ERROR_FAIL_OPEN");
});

test("an over-deadline source fails open instead of delaying the action", async () => {
  const service = new ActionGateService(parseActionGateConfig({ enabled: true, timeoutMs: 5 }), {
    sources: [
      {
        id: "slow",
        find() {
          return new Promise((resolve) =>
            setTimeout(() => resolve({ ok: true, candidates: [{ memoryId: "late", advisoryText: "late" }] }), 200)
          );
        },
      },
    ],
  });
  const startedAt = Date.now();
  const decision = await service.evaluate(request());
  assert.ok(Date.now() - startedAt < 150, "gate must not wait for the slow source");
  assert.equal(decision.status, "ERROR_FAIL_OPEN");
  assert.match(decision.degradations[0], /timed out after 5ms/);
});

test("an invalid action intent fails open rather than throwing", async () => {
  const service = new ActionGateService(parseActionGateConfig({ enabled: true }), {
    sources: [staticSource("static", ["mem-a"])],
  });
  const decision = await service.evaluate(
    request({ intent: { kind: "edit", filePath: "/elsewhere/secret.ts", editKind: "update" } })
  );
  assert.equal(decision.status, "ERROR_FAIL_OPEN");
  assert.match(decision.reason ?? "", /contained/);
  assert.deepEqual(decision.advisories, []);
});

test("trajectory source surfaces a recorded failure at the action site", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-action-gate-"));
  try {
    const intent = { kind: "command" as const, command: "pnpm", args: ["migrate", "--force"] };
    await recordCausalTrajectory({
      memoryDir,
      record: {
        schemaVersion: 1,
        trajectoryId: "traj-failure",
        recordedAt: "2026-08-17T12:00:00Z",
        sessionKey: "historical-session",
        goal: "Migrate the database",
        actionSummary: "Ran the forced migration",
        observationSummary: "The migration destroyed local data",
        outcomeKind: "failure",
        outcomeSummary: "Dev database dropped",
        followUpSummary: "Take a snapshot before migrating",
        codingContext: { projectId: codingContext.projectId, branch: "main" },
        actionIdentity: {
          fingerprintVersion: 1,
          fingerprint: normalizeActionIntent(intent, "RUN_CHECK", codingContext).fingerprint,
          strategyId: "RUN_CHECK",
        },
      },
    });
    const service = new ActionGateService(parseActionGateConfig({ enabled: true, timeoutMs: 2000 }), {
      sources: [createTrajectoryCandidateSource(new PreActionFailureGate({ timeoutMs: 1000 }))],
    });
    const decision = await service.evaluate(request({ intent, memoryDir }));
    assert.equal(decision.status, "MATCH_WARN");
    assert.equal(decision.advisories[0].memoryId, "traj-failure");
    assert.equal(decision.advisories[0].sourceId, "causal-trajectory");
    assert.match(decision.advisories[0].text, /Dev database dropped/);

    const unrelated = await service.evaluate(
      request({
        turnId: "turn-2",
        intent: { kind: "command", command: "pnpm", args: ["build"] },
        memoryDir,
      })
    );
    assert.equal(unrelated.status, "NO_MATCH");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});

test("failure-class detection and action terms stay deterministic", () => {
  assert.equal(isFailureClassMemory(memory("m", "x")), true);
  assert.equal(isFailureClassMemory(memory("m", "x", { category: "fact" })), false);
  assert.equal(
    isFailureClassMemory(memory("m", "x", { category: "procedure", structuredAttributes: { needsRepair: "true" } })),
    true
  );
  assert.equal(isFailureClassMemory(memory("m", "x", { category: "fact", mw_fail: 3, mw_success: 1 })), true);
  assert.equal(isFailureClassMemory(memory("m", "x", { category: "fact", mw_fail: 1, mw_success: 4 })), false);
  assert.equal(isFailureClassMemory(memory("m", "x", { status: "pending_review" })), false);

  assert.deepEqual(actionTermsFor({ kind: "command", command: "pnpm", args: ["migrate", "-f", "migrate"] }), [
    "pnpm",
    "migrate",
  ]);
  assert.deepEqual(actionTermsFor({ kind: "edit", filePath: "src/config.ts", editKind: "update" }), [
    "src",
    "config.ts",
    "update",
  ]);
});
