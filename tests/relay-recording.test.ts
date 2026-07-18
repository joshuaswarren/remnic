import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RELAY_DEMO_MISSION_ID,
  RELAY_DEMO_NAMESPACE,
  RelayMissionEventSchema,
  createRelayMissionFixture,
  reduceRelayMission,
  relayMissionReceiptDigest,
} from "@remnic/core";
import type { CodexCreditReceipt, CodexCreditReceiptScope } from "@remnic/bench";

import {
  RELAY_CREDIT_BUDGET_UNITS,
  RELAY_CREDIT_RESERVE_UNITS,
  RELAY_MAX_LIVE_CALLS,
  RELAY_MODEL,
  RELAY_OPERATOR_PRINCIPAL,
  RELAY_PLANNED_SPEND_CEILING_UNITS,
  type RelayCodexCallSummary,
  type RelayPreflightReceipt,
  type RelayRole,
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
    status: "completed",
  };
}

function fixtureCalls(): RelayMissionRunResult["calls"] {
  const scout: SanitizedRelayCall = {
    summary: callSummary("scout"),
    output: {
      decision: "Reuse the session token and mint exactly one replacement after expiry.",
      rationale: "The sources agree.",
      source_locators: ["CONTRACT.md", "src/reference-token-policy.mjs"],
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
      source_locators: ["CONTRACT.md", "test/token-policy.contract.test.mjs"],
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
      2,
    )}\n`,
  );
}

test("Relay recording is sanitized, run-scoped, and integrity checked", async () => {
  const fixtureManifest = await verifyRelayFixtureManifest(fixtureRoot);
  const events = createRelayMissionFixture().map((input, index) =>
    RelayMissionEventSchema.parse({
      schemaVersion: "1",
      eventId: `recording-event-${String(index + 1).padStart(3, "0")}`,
      missionId: RELAY_DEMO_MISSION_ID,
      namespace: RELAY_DEMO_NAMESPACE,
      authenticatedPrincipal: RELAY_OPERATOR_PRINCIPAL,
      recordedAt: input.occurredAt,
      occurredAt: input.occurredAt,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      payload: {
        ...input.payload,
        ...(input.payload.kind === "mission_started" ? { runMode: "live" as const } : {}),
        ...(input.payload.kind === "correction_approved"
          ? {
              approvedBy: {
                kind: "human" as const,
                id: RELAY_OPERATOR_PRINCIPAL,
                label: "Build Week operator",
              },
            }
          : {}),
        evidence: input.payload.evidence.map((item) => ({ ...item, capture: "at_action" as const })),
      },
    }),
  );
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
    isolation: { userNamespace: true, mountNamespace: true, chroot: true },
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
    calls: fixtureCalls(),
    tests: [
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
    ],
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

    const metadataPath = path.join(recordingDir, "recording.json");
    const originalMetadata = await readFile(metadataPath, "utf8");
    const tamperedMetadata = JSON.parse(originalMetadata) as { threadIds: string[] };
    tamperedMetadata.threadIds[0] = randomUUID();
    await writeFile(metadataPath, `${JSON.stringify(tamperedMetadata, null, 2)}\n`);
    await resealRecordingManifest(recordingDir);
    await assert.rejects(verifyRelayRecording(recordingDir, repoRoot), /declared thread IDs/);

    await writeFile(metadataPath, originalMetadata);
    await resealRecordingManifest(recordingDir);
    await verifyRelayRecording(recordingDir, repoRoot);

    await writeFile(path.join(recordingDir, "approval.json"), "{}\n");
    await assert.rejects(verifyRelayRecording(recordingDir, repoRoot), /integrity manifest/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
