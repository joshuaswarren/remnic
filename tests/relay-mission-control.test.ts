import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { RelayMissionEventInputSchema } from "@remnic/core";

import { createRelayUiReplay } from "../scripts/generate-relay-ui-replay.js";

interface RelayBrowserModel {
  agentCards(snapshot: unknown): Array<{
    slot: string;
    agentId: string | null;
    label: string;
    status: string;
    decision: { decisionId: string; status: string } | null;
    recall: { coldStart: boolean } | null;
  }>;
  collectEvidence(snapshot: unknown): Array<{ id: string; capture: string; contexts: string[] }>;
  createApprovalEvent(input: Record<string, string>): unknown;
  isValidActorId(value: unknown): boolean;
  isReusableApprovalEvent(candidate: unknown, correctionId: string, operatorId?: string): boolean;
  lineage(snapshot: unknown): {
    stale: { decisionId: string; status: string } | null;
    replacement: { decisionId: string; status: string } | null;
    state: string;
  };
  phase(snapshot: unknown): { id: string; label: string };
  receipt(snapshot: unknown): { complete: boolean; propagated: boolean; contractPassed: boolean };
  timeline(snapshot: unknown): Array<{ kind: string; id: string }>;
  validateReplay(replay: unknown): unknown;
}

async function loadModel(): Promise<RelayBrowserModel> {
  const scriptPath = path.resolve("admin-console/public/relay/relay-model.js");
  const source = await readFile(scriptPath, "utf8");
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: scriptPath });
  return vm.runInContext("RelayModel", context) as RelayBrowserModel;
}

async function committedReplay(): Promise<ReturnType<typeof createRelayUiReplay>> {
  const raw = await readFile(path.resolve("admin-console/public/relay/replay.json"), "utf8");
  return JSON.parse(raw) as ReturnType<typeof createRelayUiReplay>;
}

test("committed Relay replay is generated exactly from the authoritative core reducer", async () => {
  const committed = await committedReplay();
  assert.equal(JSON.stringify(committed), JSON.stringify(createRelayUiReplay()));
  assert.equal(committed.initialFrameId, "conflict");
  assert.equal(committed.frames.length, 12);
  assert.deepEqual(
    committed.frames.map((frame) => frame.snapshot.events.length),
    [1, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
  );
  assert.equal(committed.frames.at(-1)?.snapshot.receipt.complete, true);
});

test("browser model derives Scout, Builder, and late cold-start Reviewer from snapshot state", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  model.validateReplay(replay);

  const conflict = replay.frames.find((frame) => frame.id === "conflict")?.snapshot;
  assert.ok(conflict);
  const conflictCards = model.agentCards(conflict);
  assert.deepEqual(
    Array.from(conflictCards, (card) => `${card.slot}:${card.label}:${card.decision?.decisionId ?? "waiting"}`),
    [
      "scout:Nova:decision-refresh-after-expiry",
      "builder:Atlas:decision-new-token-every-request",
      "reviewer:Reviewer:waiting",
    ]
  );

  const completed = replay.frames.at(-1)?.snapshot;
  assert.ok(completed);
  const completedCards = model.agentCards(completed);
  const reviewer = completedCards.find((card) => card.slot === "reviewer");
  assert.equal(reviewer?.label, "Orbit");
  assert.equal(reviewer?.status, "verified");
  assert.equal(reviewer?.recall?.coldStart, true);
  assert.equal(reviewer?.decision?.decisionId, "decision-refresh-after-expiry");
});

test("browser model preserves the causal event order through recovered receipt", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const finalSnapshot = replay.frames.at(-1)?.snapshot;
  assert.ok(finalSnapshot);

  const kinds = Array.from(model.timeline(finalSnapshot), (item) => item.kind);
  assert.deepEqual(kinds, [
    "mission_started",
    "belief_observed",
    "belief_observed",
    "conflict_detected",
    "test_result",
    "correction_proposed",
    "correction_approved",
    "decision_superseded",
    "recall_observed",
    "propagation_verified",
    "test_result",
    "mission_completed",
  ]);
  assert.equal(model.phase(finalSnapshot).id, "recovered");
  assert.deepEqual(JSON.parse(JSON.stringify(model.receipt(finalSnapshot))), {
    complete: true,
    outcome: "recovered",
    eventCount: 16,
    correctionCount: 1,
    humanApproved: true,
    propagated: true,
    contractPassed: true,
    missingEvidence: [],
    summary: "One approved correction reached a cold agent and changed the observable outcome.",
  });
  const lineage = model.lineage(finalSnapshot);
  assert.equal(lineage.stale?.status, "superseded");
  assert.equal(lineage.replacement?.decisionId, "decision-refresh-after-expiry");
  assert.equal(lineage.state, "propagated");
});

test("browser approval builder emits a schema-valid, at-action human approval", async () => {
  const model = await loadModel();
  const candidate = model.createApprovalEvent({
    correctionId: "correction-token-refresh",
    operatorId: "relay-operator",
    operatorLabel: "Build Week operator",
    occurredAt: "2026-07-17T20:00:00.000Z",
    idempotencyKey: "relay-approval-001",
  });
  const parsed = RelayMissionEventInputSchema.parse(candidate);
  assert.equal(parsed.payload.kind, "correction_approved");
  if (parsed.payload.kind !== "correction_approved") assert.fail("approval payload was not preserved");
  assert.equal(parsed.payload.approvedBy.kind, "human");
  assert.equal(parsed.payload.approvedBy.id, "relay-operator");
  assert.equal(parsed.payload.evidence[0]?.capture, "at_action");
  assert.equal(model.isReusableApprovalEvent(candidate, "correction-token-refresh"), true);
  assert.equal(model.isReusableApprovalEvent(candidate, "correction-token-refresh", "relay-operator"), true);
  assert.equal(model.isReusableApprovalEvent(candidate, "correction-token-refresh", "other-operator"), false);
  assert.equal(model.isReusableApprovalEvent(candidate, "different-correction"), false);
  assert.equal(model.isReusableApprovalEvent({ payload: { kind: "correction_approved" } }, "correction-token-refresh"), false);
  assert.throws(
    () => model.createApprovalEvent({
      correctionId: "correction-token-refresh",
      operatorId: "not a valid principal",
      operatorLabel: "Build Week operator",
      occurredAt: "2026-07-17T20:00:00.000Z",
      idempotencyKey: "relay-approval-002",
    }),
    /principal/
  );
});

test("replay validation rejects non-advancing frames and identity drift", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const nonAdvancing = structuredClone(replay);
  nonAdvancing.frames[1]!.snapshot.events = structuredClone(nonAdvancing.frames[0]!.snapshot.events);
  assert.throws(() => model.validateReplay(nonAdvancing), /advance/);

  const drifted = structuredClone(replay);
  drifted.frames[0]!.snapshot.namespace = "production";
  assert.throws(() => model.validateReplay(drifted), /identity/);

  const rewrittenPrefix = structuredClone(replay);
  const secondFrameEvents = rewrittenPrefix.frames[1]!.snapshot.events;
  [secondFrameEvents[0], secondFrameEvents[1]] = [secondFrameEvents[1]!, secondFrameEvents[0]!];
  assert.throws(() => model.validateReplay(rewrittenPrefix), /append-only event prefix/);
});

test("Mission Control assets expose honest modes, keyboard paths, and session-only auth", async () => {
  const [html, controller, css] = await Promise.all([
    readFile(path.resolve("admin-console/public/relay/index.html"), "utf8"),
    readFile(path.resolve("admin-console/public/relay/relay.js"), "utf8"),
    readFile(path.resolve("admin-console/public/relay/relay.css"), "utf8"),
  ]);
  assert.match(html, /DETERMINISTIC SYNTHETIC REPLAY · ZERO MODEL CREDITS/);
  assert.match(html, /Type <strong>APPROVE<\/strong>/);
  assert.match(html, /Fresh inspection/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(controller, /sessionStorage/);
  assert.doesNotMatch(controller, /localStorage/);
  assert.match(controller, /\/engram\/v1\/relay\/missions/);
  assert.match(controller, /x-remnic-authenticated-principal/);
  assert.match(controller, /Model\.isValidActorId\(state\.authenticatedPrincipal\)/);
  assert.match(controller, /operatorLabelInput\.readOnly = Boolean\(pendingDraft\)/);
  assert.match(controller, /Retry will reuse this exact approval event/);
  assert.doesNotMatch(controller, /if \(!approved\) \{\s*safeSessionRemove\(key\)/);
  assert.match(html, /id="operatorIdInput"[^>]*readonly/);
  assert.doesNotMatch(html, /value="relay-operator"/);
  assert.match(controller, /OFFLINE FALLBACK/);
  assert.match(controller, /event\.key === "ArrowRight"/);
});
