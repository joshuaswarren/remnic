import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodexCreditReceipt, CodexCreditReceiptScope } from "@remnic/bench";
import {
  RELAY_DEMO_MISSION_ID,
  RELAY_DEMO_NAMESPACE,
  RelayMissionEventSchema,
  createRelayMissionFixture,
  reduceRelayMission,
  relayMissionReceiptDigest,
} from "@remnic/core";

import {
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MODEL,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_PLANNED_SPEND_CEILING_UNITS,
  RELAY_RECALL_DISCLOSURE,
  RELAY_RECALL_MODE,
  RELAY_RECALL_TAGS,
  RELAY_RECALL_TAG_MATCH,
  RELAY_RECALL_TOP_K,
  type RelayCodexCallSummary,
  type RelayPreflightReceipt,
  type RelayRole,
  relayBuilderSessionKey,
} from "../scripts/relay/contracts.js";
import { verifyRelayFixtureManifest } from "../scripts/relay/fixture-manifest.js";
import { digestFixtureTree } from "../scripts/relay/isolation.js";
import type { RelayMissionRunResult, SanitizedRelayCall } from "../scripts/relay/mission-runner.js";
import { verifyRelayRecording, writeRelayRecording } from "../scripts/relay/recording.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "remnic-relay");

function callSummary(role: RelayRole): RelayCodexCallSummary {
  return {
    role,
    model: RELAY_MODEL,
    reasoningEffort: "medium",
    threadId: randomUUID(),
    promptSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    exitCode: 0,
    durationMs: 100,
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 5 },
    recallToolCalls: role === "stale-builder" || role === "cold-builder" ? 1 : 0,
    recallReceipt:
      role === "stale-builder"
        ? {
            query: "checkout token retry policy decision",
            namespace: "relay-build-week",
            sessionKey: relayBuilderSessionKey(role),
            mode: RELAY_RECALL_MODE,
            topK: RELAY_RECALL_TOP_K,
            disclosure: RELAY_RECALL_DISCLOSURE,
            tags: [...RELAY_RECALL_TAGS],
            tagMatch: RELAY_RECALL_TAG_MATCH,
            count: 1,
            plannerMode: RELAY_RECALL_MODE,
            memoryIds: ["memory-stale-token-policy"],
          }
        : role === "cold-builder"
          ? {
              query: "checkout token retry policy decision",
              namespace: "relay-build-week",
              sessionKey: relayBuilderSessionKey(role),
              mode: RELAY_RECALL_MODE,
              topK: RELAY_RECALL_TOP_K,
              disclosure: RELAY_RECALL_DISCLOSURE,
              tags: [...RELAY_RECALL_TAGS],
              tagMatch: RELAY_RECALL_TAG_MATCH,
              count: 1,
              plannerMode: RELAY_RECALL_MODE,
              memoryIds: ["memory-replacement-token-policy"],
            }
          : null,
    status: "completed",
  };
}

function fixtureCalls(): RelayMissionRunResult["calls"] {
  const scout: SanitizedRelayCall = {
    summary: callSummary("scout"),
    output: {
      decision: "Reuse the session token and mint exactly one replacement after expiry.",
      rationale: "The sources agree.",
      source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"],
      confidence: 0.99,
    },
  };
  const stale: SanitizedRelayCall = {
    summary: callSummary("stale-builder"),
    output: {
      summary: "Implemented stale rotation.",
      recall_memory_id: "memory-stale-token-policy",
      recall_provenance: "Remnic recall",
      decision_applied: "Mint every retry.",
      files_changed: ["src/token-policy.mjs"],
      tests_run: ["npm test"],
    },
  };
  const resolver: SanitizedRelayCall = {
    summary: callSummary("resolver"),
    output: {
      replacement_decision: "Reuse the session token and mint exactly one replacement after expiry.",
      rationale: "The accepted contract and executable test agree.",
      source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs", "test/token-policy.contract.test.mjs"],
      confidence: 0.99,
    },
  };
  const cold: SanitizedRelayCall = {
    summary: callSummary("cold-builder"),
    output: {
      summary: "Implemented corrected reuse.",
      recall_memory_id: "memory-replacement-token-policy",
      recall_provenance: "Remnic recall",
      decision_applied: "Reuse until expiry and mint exactly one replacement.",
      files_changed: ["src/token-policy.mjs"],
      tests_run: ["npm test"],
    },
  };
  return [scout, stale, resolver, cold] as RelayMissionRunResult["calls"];
}

function creditScope(): CodexCreditReceiptScope {
  return {
    calls: 4,
    budgetUnits: 1,
    inputTokens: 400,
    cachedInputTokens: 0,
    outputTokens: 80,
    reasoningOutputTokens: 20,
    accountBalanceResolutionCount: 0,
    conservativeResolutionChargeUnits: 0,
    models: [
      {
        model: RELAY_MODEL,
        calls: 4,
        budgetUnits: 1,
        inputTokens: 400,
        cachedInputTokens: 0,
        outputTokens: 80,
        reasoningOutputTokens: 20,
      },
    ],
  };
}

async function resealRecordingManifest(recordingDir: string): Promise<void> {
  const files = await digestFixtureTree(recordingDir, ["manifest.json"]);
  await writeFile(
    path.join(recordingDir, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        files,
        rootSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      },
      null,
      2
    )}\n`
  );
}

async function assertResealedJsonTamperRejected<T>(
  recordingDir: string,
  relativePath: string,
  mutate: (value: T) => void,
  expected: RegExp
): Promise<void> {
  const artifactPath = path.join(recordingDir, relativePath);
  const original = await readFile(artifactPath, "utf8");
  try {
    const tampered = JSON.parse(original) as T;
    mutate(tampered);
    await writeFile(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
    await resealRecordingManifest(recordingDir);
    await assert.rejects(verifyRelayRecording(recordingDir, repoRoot), expected);
  } finally {
    await writeFile(artifactPath, original);
    await resealRecordingManifest(recordingDir);
  }
  await verifyRelayRecording(recordingDir, repoRoot);
}

async function assertResealedJsonSetTamperRejected(
  recordingDir: string,
  mutations: Array<{ relativePath: string; mutate: (value: Record<string, unknown>) => void }>,
  expected: RegExp
): Promise<void> {
  const originals = new Map<string, string>();
  try {
    for (const mutation of mutations) {
      const artifactPath = path.join(recordingDir, mutation.relativePath);
      const original = await readFile(artifactPath, "utf8");
      originals.set(mutation.relativePath, original);
      const tampered = JSON.parse(original) as Record<string, unknown>;
      mutation.mutate(tampered);
      await writeFile(artifactPath, `${JSON.stringify(tampered, null, 2)}\n`);
    }
    await resealRecordingManifest(recordingDir);
    await assert.rejects(verifyRelayRecording(recordingDir, repoRoot), expected);
  } finally {
    for (const [relativePath, original] of originals) {
      await writeFile(path.join(recordingDir, relativePath), original);
    }
    await resealRecordingManifest(recordingDir);
  }
  await verifyRelayRecording(recordingDir, repoRoot);
}

test("Relay recording is sanitized, run-scoped, and integrity checked", async () => {
  const fixtureManifest = await verifyRelayFixtureManifest(fixtureRoot);
  const calls = fixtureCalls();
  const scoutCall = calls[0];
  const resolverCall = calls[2];
  const coldCall = calls[3];
  assert.equal(scoutCall.summary.role, "scout");
  assert.equal(resolverCall.summary.role, "resolver");
  assert.equal(coldCall.summary.role, "cold-builder");
  const coldThreadId = coldCall.summary.threadId;
  const testArtifacts: RelayMissionRunResult["tests"] = [
    {
      phase: "before-correction",
      status: "failed",
      exitCode: 1,
      durationMs: 100,
      command: "node --test fixtures/remnic-relay/hidden/token-policy.hidden.test.mjs",
      summary: "Stale retry failed.",
      outputSha256: "d".repeat(64),
    },
    {
      phase: "after-correction",
      status: "passed",
      exitCode: 0,
      durationMs: 100,
      command: "node --test fixtures/remnic-relay/hidden/token-policy.hidden.test.mjs",
      summary: "Corrected retry passed.",
      outputSha256: "e".repeat(64),
    },
  ];
  const callEvidence = (role: RelayRole) => ({
    kind: "agent_output" as const,
    id: `output-${role}`,
    label: `${role} GPT-5.6 one-shot output`,
    locator: `recording://calls/${role}.json`,
    capture: "at_action" as const,
  });
  const correctionEvidence = {
    kind: "correction" as const,
    id: "correction-token-refresh",
    label: "Applied Remnic correction",
    locator: "recording://correction.json",
    capture: "at_action" as const,
  };
  const approvalEvidence = {
    kind: "approval" as const,
    id: `approval-${RELAY_OPERATOR_PRINCIPAL}`,
    label: "Human approval receipt",
    locator: "recording://approval.json",
    capture: "at_action" as const,
  };
  const events = createRelayMissionFixture().map((input, index) => {
    const normalizedEvidence = input.payload.evidence.map((item) => ({ ...item, capture: "at_action" as const }));
    let payload: unknown;
    switch (input.payload.kind) {
      case "mission_started":
        payload = { ...input.payload, runMode: "live" as const, evidence: normalizedEvidence };
        break;
      case "belief_observed":
        payload =
          input.payload.decisionId === "decision-new-token-every-request"
            ? {
                ...input.payload,
                statement: "Mint a new checkout token for every request and every retry.",
                evidence: [
                  {
                    kind: "memory" as const,
                    id: "memory-stale-token-policy",
                    label: "Stale project decision",
                    locator: "recording://memories/stale.json",
                    capture: "at_action" as const,
                  },
                  callEvidence("stale-builder"),
                ],
              }
            : {
                ...input.payload,
                statement:
                  "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
                confidence: scoutCall.output.confidence,
                evidence: [...normalizedEvidence, callEvidence("scout")],
              };
        break;
      case "correction_proposed":
        payload = {
          ...input.payload,
          statement:
            "Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry.",
          rationale: resolverCall.output.rationale,
          evidence: [...normalizedEvidence, callEvidence("resolver")],
        };
        break;
      case "correction_approved":
        payload = {
          ...input.payload,
          approvedBy: {
            kind: "human" as const,
            id: RELAY_OPERATOR_PRINCIPAL,
            label: "Build Week operator",
          },
          evidence: [approvalEvidence],
        };
        break;
      case "decision_superseded":
        payload = {
          ...input.payload,
          evidence: [
            correctionEvidence,
            {
              kind: "correction" as const,
              id: "plan-relay-recording",
              label: "Remnic correction plan receipt",
              locator: "recording://correction.json",
              capture: "at_action" as const,
            },
          ],
        };
        break;
      case "recall_observed":
        payload = {
          ...input.payload,
          agentId: "agent-cold-builder",
          sessionId: `session-${coldThreadId}`,
          recallReceiptId: "recall-cold-builder",
          evidence: [
            {
              kind: "recall_audit" as const,
              id: "recall-cold-builder",
              label: "Transcript-free cold Builder recall",
              locator: "recording://calls/cold-builder.json",
              capture: "at_action" as const,
            },
            {
              kind: "memory" as const,
              id: "memory-replacement-token-policy",
              label: "Active replacement Remnic decision",
              locator: "recording://memories/replacement.json",
              capture: "at_action" as const,
            },
          ],
        };
        break;
      case "propagation_verified":
        payload = {
          ...input.payload,
          agentId: "agent-cold-builder",
          sessionId: `session-${coldThreadId}`,
          recallReceiptId: "recall-cold-builder",
          evidence: [
            {
              kind: "recall_audit" as const,
              id: "recall-cold-builder",
              label: "Transcript-free cold Builder recall",
              locator: "recording://calls/cold-builder.json",
              capture: "at_action" as const,
            },
            correctionEvidence,
          ],
        };
        break;
      case "test_result": {
        const artifact = input.payload.testId === "test-before-correction" ? testArtifacts[0] : testArtifacts[1];
        const afterCorrection = artifact.phase === "after-correction";
        payload = {
          ...input.payload,
          ...(afterCorrection ? { correctionId: "correction-token-refresh" } : {}),
          command: artifact.command,
          status: artifact.status,
          summary: artifact.summary,
          durationMs: artifact.durationMs,
          evidence: [
            ...normalizedEvidence,
            callEvidence(afterCorrection ? "cold-builder" : "stale-builder"),
            ...(afterCorrection ? [correctionEvidence] : []),
          ],
        };
        break;
      }
      case "mission_completed":
        payload = { ...input.payload, evidence: [...normalizedEvidence, approvalEvidence] };
        break;
      default:
        payload = { ...input.payload, evidence: normalizedEvidence };
    }
    return RelayMissionEventSchema.parse({
      schemaVersion: "1",
      eventId: `recording-event-${String(index + 1).padStart(3, "0")}`,
      missionId: RELAY_DEMO_MISSION_ID,
      namespace: RELAY_DEMO_NAMESPACE,
      authenticatedPrincipal: RELAY_OPERATOR_PRINCIPAL,
      recordedAt: input.occurredAt,
      occurredAt: input.occurredAt,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload,
    });
  });
  const mission = reduceRelayMission({
    missionId: RELAY_DEMO_MISSION_ID,
    namespace: RELAY_DEMO_NAMESPACE,
    events,
    fileExists: true,
  });
  assert.equal(mission.receipt.complete, true);
  const missionReceiptSha256 = relayMissionReceiptDigest(mission);
  const runId = "relay-recording-test";
  const preflight: RelayPreflightReceipt = {
    schemaVersion: 1,
    checkedAt: "2026-07-17T20:00:00.000Z",
    status: "passed",
    model: RELAY_MODEL,
    reasoningEffort: "medium",
    modelCatalogVerified: true,
    maxLiveCalls: RELAY_MAX_LIVE_CALLS,
    accountCreditCapUnits: RELAY_CREDIT_BUDGET_UNITS,
    quarantinedUncertainUnits: 0,
    quarantinedLedgerSha256: null,
    budgetUnits: RELAY_CREDIT_BUDGET_UNITS,
    reserveUnits: RELAY_CREDIT_RESERVE_UNITS,
    plannedSpendCeilingUnits: RELAY_PLANNED_SPEND_CEILING_UNITS,
    worstCasePlannedSpendUnits: 1_200,
    ledgerSpentUnits: 0,
    ledgerRemainingPlannedUnits: 2_000,
    codexVersion: "codex-cli 0.144.4",
    authMethod: "ChatGPT",
    codexToolSurface: {
      accountLinkedAppsDisabled: true,
      mcpServers: ["relay"],
      mcpTools: ["relay.remnic.recall"],
    },
    fixtureManifestSha256: fixtureManifest.rootSha256,
    isolation: {
      userNamespace: true,
      mountNamespace: true,
      networkNamespace: true,
      chroot: true,
      egressPolicy: "openai-and-relay-only",
    },
    remnic: {
      loopbackOnly: true,
      namespace: "relay-build-week",
      advertisedTools: ["remnic.recall"],
      isolatedMemoryDir: true,
    },
    productionDataRead: false,
    solAllowed: false,
  };
  const scope = creditScope();
  const creditReceipt: CodexCreditReceipt = {
    schemaVersion: 2,
    ledgerSha256: "c".repeat(64),
    budgetUnits: RELAY_CREDIT_BUDGET_UNITS,
    reserveUnits: RELAY_CREDIT_RESERVE_UNITS,
    plannedSpendCeilingUnits: RELAY_PLANNED_SPEND_CEILING_UNITS,
    totalSpentUnits: 1,
    remainingBudgetUnits: RELAY_CREDIT_BUDGET_UNITS - 1,
    blocked: false,
    cumulative: scope,
    run: { id: runId, ...scope },
  };
  const missionRun: RelayMissionRunResult = {
    fixtureManifestSha256: fixtureManifest.rootSha256,
    mission,
    missionReceiptSha256,
    calls,
    tests: testArtifacts,
    staleMemoryId: "memory-stale-token-policy",
    replacementMemoryId: "memory-replacement-token-policy",
    correction: {
      planId: "plan-relay-recording",
      outcomeStatus: "applied",
      staleMemoryStatus: "superseded",
      resolverBridgeRequests: 1,
    },
    approval: { approved: true, operatorPrincipal: RELAY_OPERATOR_PRINCIPAL },
  };
  const parent = await mkdtemp(path.join(os.tmpdir(), "relay-recording-test-"));
  const recordingDir = path.join(parent, "recording");
  try {
    const rootSha256 = await writeRelayRecording({
      recordingDir,
      repoRoot,
      generatedAt: "2026-07-17T20:01:00.000Z",
      preflight,
      creditReceipt,
      runId,
      missionRun,
    });
    const verified = await verifyRelayRecording(recordingDir, repoRoot);
    assert.equal(verified.rootSha256, rootSha256);
    assert.equal(verified.events.length, 16);
    assert.equal(verified.calls.length, 4);
    assert.equal(verified.creditReceipt.run.calls, 4);
    const callFile = await readFile(path.join(recordingDir, "calls", "cold-builder.json"), "utf8");
    assert.doesNotMatch(callFile, /stdout|stderr|REMNIC_RELAY_MCP_TOKEN|\/home\//);

    await assertResealedJsonTamperRejected<{ threadIds: string[] }>(
      recordingDir,
      "recording.json",
      (metadata) => {
        metadata.threadIds[0] = randomUUID();
      },
      /declared thread IDs/
    );
    await assertResealedJsonTamperRejected<{ output: { decision: string } }>(
      recordingDir,
      "calls/scout.json",
      (scout) => {
        scout.output.decision = "Mint a new checkout token for every request and every retry.";
      },
      /Scout decision/
    );
    await assertResealedJsonTamperRejected<{ output: { replacement_decision: string } }>(
      recordingDir,
      "calls/resolver.json",
      (resolver) => {
        resolver.output.replacement_decision = "Keep per-request rotation as the active policy.";
      },
      /Resolver decision/
    );
    await assertResealedJsonTamperRejected<{ output: { source_locators: string[] } }>(
      recordingDir,
      "calls/resolver.json",
      (resolver) => {
        resolver.output.source_locators = ["CONTRACT.md", "package.json"];
      },
      /non-authoritative fixture path/
    );
    await assertResealedJsonTamperRejected<{ summary: { recallReceipt: { memoryIds: string[] } } }>(
      recordingDir,
      "calls/cold-builder.json",
      (cold) => {
        cold.summary.recallReceipt.memoryIds = ["memory-unrelated"];
      },
      /MCP receipts are not bound/
    );
    await assertResealedJsonSetTamperRejected(
      recordingDir,
      ["recording.json", "preflight.json"].map((relativePath) => ({
        relativePath,
        mutate: (artifact: Record<string, unknown>) => {
          artifact.fixtureManifestSha256 = "f".repeat(64);
        },
      })),
      /committed synthetic fixture manifest/
    );
    await assertResealedJsonTamperRejected<{
      quarantinedUncertainUnits: number;
      quarantinedLedgerSha256: string | null;
      budgetUnits: number;
      plannedSpendCeilingUnits: number;
    }>(
      recordingDir,
      "preflight.json",
      (tamperedPreflight) => {
        tamperedPreflight.quarantinedUncertainUnits = 300;
        tamperedPreflight.quarantinedLedgerSha256 = "a".repeat(64);
        tamperedPreflight.budgetUnits = 2_173;
        tamperedPreflight.plannedSpendCeilingUnits = 1_700;
      },
      /preflight budget evidence/
    );
    await assertResealedJsonTamperRejected<Array<{ payload: { kind: string; sessionId?: string } }>>(
      recordingDir,
      "events.json",
      (tamperedEvents) => {
        const coldRecall = tamperedEvents.find((event) => event.payload.kind === "recall_observed");
        assert.ok(coldRecall);
        coldRecall.payload.sessionId = `session-${randomUUID()}`;
      },
      /cold Builder thread/
    );
    await assertResealedJsonTamperRejected<{ replacementMemoryId: string }>(
      recordingDir,
      "correction.json",
      (correction) => {
        correction.replacementMemoryId = "memory-unrelated-replacement";
      },
      /correction and memory artifacts/
    );
    await assertResealedJsonTamperRejected<
      Array<{
        payload: { kind: string; approvedBy?: { id: string }; evidence: Array<{ id: string; locator?: string }> };
      }>
    >(
      recordingDir,
      "events.json",
      (tamperedEvents) => {
        const approval = tamperedEvents.find((event) => event.payload.kind === "correction_approved");
        assert.ok(approval?.payload.approvedBy);
        approval.payload.approvedBy.id = "different-operator";
      },
      /approval artifact does not match/
    );
    await assertResealedJsonTamperRejected<
      Array<{ payload: { kind: string; evidence: Array<{ kind?: string; id: string; locator?: string }> } }>
    >(
      recordingDir,
      "events.json",
      (tamperedEvents) => {
        const recall = tamperedEvents.find((event) => event.payload.kind === "recall_observed");
        const memory = recall?.payload.evidence.find((item) => item.kind === "memory");
        assert.ok(memory);
        memory.id = "memory-unrelated-replacement";
      },
      /cold recall is not bound/
    );
    await assertResealedJsonTamperRejected<{ activeDecisionIds: string[] }>(
      recordingDir,
      "mission-receipt.json",
      (receipt) => {
        receipt.activeDecisionIds = ["decision-unrelated"];
      },
      /mission receipt artifact does not match/
    );
    await assertResealedJsonTamperRejected<Array<{ summary: string }>>(
      recordingDir,
      "tests.json",
      (testResults) => {
        testResults[1].summary = "Unrelated passing result.";
      },
      /after-correction artifact does not match/
    );
    await assertResealedJsonTamperRejected<Array<{ payload: { evidence: Array<{ locator?: string }> } }>>(
      recordingDir,
      "events.json",
      (tamperedEvents) => {
        const evidence = tamperedEvents
          .flatMap((event) => event.payload.evidence)
          .find((item) => item.locator?.startsWith("recording://calls/"));
        assert.ok(evidence);
        evidence.locator = "recording://calls/missing.json";
      },
      /does not resolve to a sealed artifact/
    );

    await writeFile(path.join(recordingDir, "approval.json"), "{}\n");
    await assert.rejects(verifyRelayRecording(recordingDir, repoRoot), /integrity manifest/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
