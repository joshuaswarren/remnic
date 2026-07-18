import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { RelayMissionEventInputSchema } from "@remnic/core";

import { createRelayUiReplayFromRecording } from "../scripts/generate-relay-ui-replay.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const recordingDir = path.join(repoRoot, "docs", "remnic-relay", "recordings", "gpt-5-6-checkout-recovery");

interface RelayBrowserModel {
  agentCards(snapshot: unknown): Array<{
    slot: string;
    agentId: string | null;
    label: string;
    status: string;
    decision: { decisionId: string; status: string } | null;
    recall: { coldStart: boolean } | null;
  }>;
  approvalView(snapshot: unknown): {
    correctionId: string;
    status: string;
    title: string;
    retirementStatements: string[];
    replacementStatement: string;
    rationale: string;
    evidence: Array<{ kind: string; id: string; label: string; capture: string }>;
    complete: boolean;
    consentKey: string;
  } | null;
  collectEvidence(snapshot: unknown): Array<{ id: string; capture: string; contexts: string[] }>;
  canRetainAuthenticatedPrincipal(input: {
    sameConnection: boolean;
    priorPrincipalValid: boolean;
    status: number | null;
    metadataInvalid: boolean;
  }): boolean;
  createApprovalId(cryptoSource: unknown): string;
  createApprovalEvent(input: Record<string, string>): unknown;
  currentCorrection(snapshot: unknown): { correctionId: string; status: string; proposedAt: string } | null;
  isCompleteEvidenceSnapshot(snapshot: unknown): boolean;
  isValidActorId(value: unknown): boolean;
  isReusableApprovalEvent(candidate: unknown, correctionId: string, operatorId?: string): boolean;
  lineage(snapshot: unknown): {
    correction: { correctionId: string } | null;
    stale: { decisionId: string; status: string } | null;
    replacement: { decisionId: string; status: string } | null;
    state: string;
  };
  phase(snapshot: unknown): { id: string; label: string };
  receipt(snapshot: unknown): { complete: boolean; humanApproved: boolean; propagated: boolean; contractPassed: boolean };
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

async function committedReplay(): Promise<Awaited<ReturnType<typeof createRelayUiReplayFromRecording>>> {
  const raw = await readFile(path.resolve("admin-console/public/relay/replay.json"), "utf8");
  return JSON.parse(raw) as Awaited<ReturnType<typeof createRelayUiReplayFromRecording>>;
}

test("committed Relay replay is generated exactly from the authoritative core reducer", async () => {
  const committed = await committedReplay();
  const generated = await createRelayUiReplayFromRecording(recordingDir, repoRoot);
  assert.equal(JSON.stringify(committed), JSON.stringify(generated));
  assert.match(committed.source, /^integrity-checked Remnic Relay recording sha256:[a-f0-9]{64}$/);
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
      "scout:Scout:decision-refresh-after-expiry",
      "builder:Builder A:decision-new-token-every-request",
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

test("browser model selects an agent decision with stable total ordering", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const completed = replay.frames.at(-1)?.snapshot;
  assert.ok(completed);
  const stale = completed.decisions.find((decision) => decision.decisionId === "decision-new-token-every-request");
  assert.ok(stale);

  const ordered = structuredClone(completed);
  ordered.decisions = [
    { ...structuredClone(stale), decisionId: "decision-z-retired", status: "superseded" },
    { ...structuredClone(stale), decisionId: "decision-proposed", status: "proposed" },
    { ...structuredClone(stale), decisionId: "decision-active", status: "active" },
    { ...structuredClone(stale), decisionId: "decision-a-retired", status: "superseded" },
  ];
  assert.equal(model.agentCards(ordered).find((card) => card.slot === "builder")?.decision?.decisionId, "decision-active");

  ordered.decisions = ordered.decisions.filter((decision) => decision.status !== "active").reverse();
  assert.equal(model.agentCards(ordered).find((card) => card.slot === "builder")?.decision?.decisionId, "decision-proposed");

  ordered.decisions = ordered.decisions.filter((decision) => decision.status === "superseded").reverse();
  assert.equal(model.agentCards(ordered).find((card) => card.slot === "builder")?.decision?.decisionId, "decision-a-retired");
});

test("browser model selects a pending correction before lexically later history", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const completed = replay.frames.at(-1)?.snapshot;
  assert.ok(completed);
  const historical = structuredClone(completed.corrections[0]);
  assert.ok(historical);
  historical.correctionId = "z-historical";

  const pending = structuredClone(historical);
  pending.correctionId = "a-pending";
  pending.status = "proposed";
  pending.proposedAt = "2026-07-17T20:30:00.000Z";
  delete pending.approvedAt;
  delete pending.approvedBy;
  delete pending.appliedAt;
  delete pending.propagatedAt;

  const multi = structuredClone(completed);
  multi.corrections = [pending, historical];
  assert.equal(model.currentCorrection(multi)?.correctionId, "a-pending");
  assert.equal(model.lineage(multi).correction?.correctionId, "a-pending");
  assert.equal(model.receipt(multi).humanApproved, false);

  const newerPending = { ...structuredClone(pending), correctionId: "b-newer", proposedAt: "2026-07-17T20:31:00.000Z" };
  multi.corrections = [pending, newerPending, historical];
  assert.equal(model.currentCorrection(multi)?.correctionId, "b-newer");

  newerPending.status = "applied";
  multi.corrections = [newerPending, historical];
  assert.equal(model.currentCorrection(multi)?.correctionId, "b-newer");
});

test("approval consent is derived from the exact selected correction", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const proposal = replay.frames.find((frame) => frame.id === "proposal")?.snapshot;
  assert.ok(proposal);

  const view = model.approvalView(proposal);
  assert.ok(view);
  assert.equal(view.correctionId, "correction-token-refresh");
  assert.equal(view.title, "Approve correction-token-refresh?");
  assert.deepEqual(Array.from(view.retirementStatements), [
    "decision-new-token-every-request — Mint a new checkout token for every request and every retry.",
  ]);
  assert.equal(
    view.replacementStatement,
    "decision-refresh-after-expiry — Reuse the checkout-session token while it is valid and mint exactly one replacement only after expiry."
  );
  assert.equal(view.complete, true);

  const alternate = structuredClone(proposal);
  const stale = alternate.decisions.find((decision) => decision.decisionId === "decision-new-token-every-request");
  const replacement = alternate.decisions.find((decision) => decision.decisionId === "decision-refresh-after-expiry");
  const correction = alternate.corrections[0];
  assert.ok(stale && replacement && correction);
  stale.decisionId = "decision-cache-forever";
  stale.statement = "Cache every response forever.";
  replacement.decisionId = "decision-cache-by-etag";
  replacement.statement = "Revalidate cached responses with the current ETag.";
  correction.correctionId = "correction-cache-etag";
  correction.supersedesDecisionIds = [stale.decisionId];
  correction.proposedDecisionId = replacement.decisionId;
  correction.statement = replacement.statement;
  correction.rationale = "The cache contract and failing conditional-request test agree.";
  correction.evidence = [{
    kind: "test",
    id: "test-cache-contract",
    label: "Conditional request contract",
    locator: "fixture://cache/contract.test.ts",
    capture: "fixture",
  }];
  const alternateView = model.approvalView(alternate);
  assert.ok(alternateView);
  assert.equal(alternateView.title, "Approve correction-cache-etag?");
  assert.deepEqual(Array.from(alternateView.retirementStatements), [
    "decision-cache-forever — Cache every response forever.",
  ]);
  assert.equal(
    alternateView.replacementStatement,
    "decision-cache-by-etag — Revalidate cached responses with the current ETag."
  );
  assert.equal(alternateView.rationale, "The cache contract and failing conditional-request test agree.");
  assert.equal(alternateView.evidence[0]?.label, "Conditional request contract");
  assert.notEqual(alternateView.consentKey, view.consentKey);

  alternate.corrections[0]!.evidence = [];
  assert.equal(model.approvalView(alternate)?.complete, false);

  const alreadyApproved = replay.frames.find((frame) => frame.id === "approval")?.snapshot;
  assert.ok(alreadyApproved);
  assert.equal(model.approvalView(alreadyApproved)?.complete, false);

  const mismatchedStatement = structuredClone(proposal);
  mismatchedStatement.corrections[0]!.statement = "A different replacement statement.";
  assert.equal(model.approvalView(mismatchedStatement)?.complete, false);
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
    summary: "One human-approved correction reached a fresh GPT-5.6 thread and changed a hidden contract from fail to pass.",
  });
  const lineage = model.lineage(finalSnapshot);
  assert.equal(lineage.stale?.status, "superseded");
  assert.equal(lineage.replacement?.decisionId, "decision-refresh-after-expiry");
  assert.equal(lineage.state, "propagated");

  const withOlderRetiredDecision = structuredClone(finalSnapshot);
  withOlderRetiredDecision.decisions.unshift({
    ...structuredClone(withOlderRetiredDecision.decisions.find((item) => item.status === "superseded")!),
    decisionId: "decision-unrelated-retired-belief",
    statement: "An older, unrelated belief.",
  });
  assert.equal(
    model.lineage(withOlderRetiredDecision).stale?.decisionId,
    "decision-new-token-every-request",
    "lineage must select the decision targeted by the active correction"
  );
});

test("authenticated principal retention distinguishes transient refreshes from invalid auth", async () => {
  const model = await loadModel();
  const base = { sameConnection: true, priorPrincipalValid: true, status: null, metadataInvalid: false };
  assert.equal(model.canRetainAuthenticatedPrincipal(base), true);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, status: 503 }), true);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, status: 401 }), false);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, status: 403 }), false);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, sameConnection: false }), false);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, metadataInvalid: true }), false);
  assert.equal(model.canRetainAuthenticatedPrincipal({ ...base, priorPrincipalValid: false }), false);
});

test("live approval safety requires the complete evidence window", async () => {
  const model = await loadModel();
  const replay = await committedReplay();
  const completed = replay.frames.at(-1)?.snapshot;
  assert.ok(completed);
  assert.equal(model.isCompleteEvidenceSnapshot(completed), true);

  const partial = structuredClone(completed);
  partial.readHealth = "partial";
  assert.equal(model.isCompleteEvidenceSnapshot(partial), false);

  const truncated = structuredClone(completed);
  truncated.bounds.truncated = true;
  assert.equal(model.isCompleteEvidenceSnapshot(truncated), false);

  const corrupt = structuredClone(completed);
  corrupt.bounds.corruptLines = 1;
  assert.equal(model.isCompleteEvidenceSnapshot(corrupt), false);

  const underfilled = structuredClone(completed);
  underfilled.bounds.returnedEvents -= 1;
  assert.equal(model.isCompleteEvidenceSnapshot(underfilled), false);

  const boundsMissing = structuredClone(completed);
  delete (boundsMissing as Partial<typeof completed>).bounds;
  assert.equal(model.isCompleteEvidenceSnapshot(boundsMissing), false);
});

test("browser approval builder emits a schema-valid, at-action human approval", async () => {
  const model = await loadModel();
  const approvalId = model.createApprovalId({
    getRandomValues(bytes: Uint8Array) {
      bytes.fill(0);
      return bytes;
    },
  });
  assert.equal(approvalId, "relay-approval-00000000-0000-4000-8000-000000000000");
  assert.throws(() => model.createApprovalId({}), /Secure approval id generation/);
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
  assert.match(controller, /Model\.isCompleteEvidenceSnapshot\(state\.snapshot\)/);
  assert.match(controller, /else if \(!Model\.isCompleteEvidenceSnapshot\(snapshot\)\)/);
  assert.doesNotMatch(controller, /Model\.currentCorrection\(state\.snapshot\)/);
  assert.match(controller, /Model\.approvalView\(state\.snapshot\)/);
  assert.match(controller, /review\.consentKey === state\.approvalReviewKey/);
  assert.match(controller, /renderApprovalReview\(review, live\)/);
  assert.match(controller, /approvalRetireStatements\.textContent = review\.retirementStatements\.join/);
  assert.match(controller, /approvalReplacementStatement\.textContent = review\.replacementStatement/);
  assert.match(controller, /approvalEvidence\.replaceChildren/);
  assert.match(controller, /if \(approvalIndex >= 0 && nextIndex < approvalIndex\) \{\s*state\.replayApprovalGranted = false/s);
  assert.match(controller, /function liveReadStillCurrent\(context, generation, requestId\)/);
  assert.match(controller, /requestId === state\.liveReadRequestId/);
  assert.equal((controller.match(/\+\+state\.liveReadRequestId/g) || []).length, 3);
  assert.equal((controller.match(/!liveReadStillCurrent\(context, generation, requestId\)/g) || []).length, 4);
  assert.match(controller, /if \(liveReadStillCurrent\(context, generation, requestId\)\) \{\s*dom\.freshInspectionButton\.disabled = false/s);
  assert.equal((controller.match(/liveReadRequestId !== state\.liveReadRequestId/g) || []).length, 2);
  assert.doesNotMatch(controller, /Fresh inspection discarded/);
  assert.match(controller, /sameLiveContext\(state\.authenticatedContext, context\)/);
  assert.match(controller, /const requestId = \+\+state\.approvalRequestId/);
  assert.match(controller, /dom\.approvalDialog\.dataset\.pendingRequestId = requestMarker/);
  assert.match(controller, /const approvalWriteStillCurrent = \(\) => requestId === state\.approvalRequestId/);
  assert.equal((controller.match(/if \(!approvalWriteStillCurrent\(\)\) return;/g) || []).length, 3);
  assert.match(controller, /if \(dom\.approvalDialog\.dataset\.pendingRequestId === requestMarker\)/);
  assert.match(controller, /if \(dom\.approvalDialog\.open\) dom\.approvalDialog\.close\(\)/);
  assert.match(controller, /fetch\(missionApiUrl\("events", context\)/);
  assert.match(controller, /headers: liveHeaders\(true, context\)/);
  assert.match(controller, /body: JSON\.stringify\(\{ namespace: context\.namespace, event \}\)/);
  assert.match(controller, /retainOrClearAuthenticatedPrincipal\(error, context\)/);
  assert.match(controller, /function reportSupersededConnection\(\)/);
  assert.equal((controller.match(/reportSupersededConnection\(\)/g) || []).length, 3);
  assert.match(controller, /CONNECTION SUPERSEDED/);
  assert.match(controller, /function invalidateApprovalUiForConnectionChange\(\)/);
  assert.match(controller, /stopPlayback\(\);\s*invalidateApprovalUiForConnectionChange\(\);\s*state\.connectionGeneration \+= 1/s);
  assert.match(controller, /function relayResponseError\(status, body\)/);
  assert.match(controller, /Model\.createApprovalId\(globalThis\.crypto\)/);
  assert.doesNotMatch(controller, /randomUUID/);
  assert.match(controller, /error\.relayStatus = status/);
  assert.equal((controller.match(/throw relayResponseError\(response\.status, body\)/g) || []).length, 2);
  assert.doesNotMatch(controller, /retainOrClearAuthenticatedPrincipal\(error, currentLiveContext\(\)\)/);
  assert.match(controller, /operatorLabelInput\.readOnly = Boolean\(pendingDraft\)/);
  assert.match(controller, /Retry will reuse this exact approval event/);
  assert.doesNotMatch(controller, /if \(!approved\) \{\s*safeSessionRemove\(key\)/);
  assert.match(html, /id="operatorIdInput"[^>]*readonly/);
  assert.doesNotMatch(html, /value="relay-operator"/);
  assert.match(controller, /OFFLINE FALLBACK/);
  assert.match(controller, /event\.key === "ArrowRight"/);
});
