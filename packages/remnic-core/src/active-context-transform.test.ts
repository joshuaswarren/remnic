/**
 * Focused regression tests for issue #2347: host-agnostic SUMMARY/FILTER
 * plans, the pure summary seam, receipt recording, and the discriminated
 * action ledger. Fake chats only — no real user data, no host paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ContextSummaryUnavailableError,
  summarizeContextPure,
} from "./context-summary.js";
import {
  planActiveContextTransform,
  prepareActiveContextTransform,
  recordActiveContextApplyReceipt,
  buildContextTransformPlanEvent,
  type ActiveContextMessage,
  type ActiveContextSnapshot,
  type ActiveContextTransformDeps,
  type ActiveContextTransformRequest,
  type ActiveContextApplyReceipt,
  type ContextTransformTelemetryRecord,
} from "./active-context-transform.js";
import { DEFAULT_ACTIVE_CONTEXT_CAPS } from "./active-context-config.js";
import {
  readContextTransformRecordRowsFromLines,
  readMemoryActionEventRowsFromLines,
} from "./storage/secure-line-reader.js";
import { StorageManager } from "./storage.js";

const SCOPE = {
  sessionKey: "sess-fake-1",
  namespace: "ns-alpha",
  principal: "user-fake",
  adapterId: "adapter-fake",
};

function fakeMessage(
  id: string,
  ordinal: number,
  role: ActiveContextMessage["role"],
  content: string,
  extra: { protected?: boolean } = {},
): ActiveContextMessage {
  return { id, ordinal, role, content, ...(extra.protected ? { protected: true } : {}) };
}

function fakeSnapshot(messages: ActiveContextMessage[], revision: string | number = 7): ActiveContextSnapshot {
  return {
    schemaVersion: 1,
    sessionKey: SCOPE.sessionKey,
    namespace: SCOPE.namespace,
    revision,
    messages,
  };
}

function baseDeps(overrides: Partial<ActiveContextTransformDeps> = {}): ActiveContextTransformDeps {
  return { resolvedScope: { ...SCOPE }, ...overrides };
}

const CAPS = {
  ...DEFAULT_ACTIVE_CONTEXT_CAPS,
  activeContextTransforms: true,
  activeContextLlm: true,
};

const SNAPSHOT = fakeSnapshot([
  fakeMessage("m-sys", 0, "system", "system prompt text"),
  fakeMessage("m-a", 1, "user", "alpha content"),
  fakeMessage("m-b", 2, "assistant", "beta content"),
  fakeMessage("m-c", 3, "user", "gamma content", { protected: true }),
  fakeMessage("m-d", 4, "assistant", "delta content"),
  fakeMessage("m-e", 5, "user", "epsilon content"),
]);

function summaryRequest(overrides: Partial<ActiveContextTransformRequest> = {}): ActiveContextTransformRequest {
  return {
    schemaVersion: 1,
    operation: "SUMMARY",
    phase: "plan",
    snapshot: SNAPSHOT,
    selector: { messageIds: ["m-b", "m-a", "m-d"] },
    summary: { method: "deterministic" },
    ...overrides,
  };
}

function filterRequest(overrides: Partial<ActiveContextTransformRequest> = {}): ActiveContextTransformRequest {
  return {
    schemaVersion: 1,
    operation: "FILTER",
    phase: "plan",
    snapshot: SNAPSHOT,
    selector: { messageIds: ["m-a", "m-b", "m-d"] },
    filter: { keepCriterion: "relevance-to-goal", threshold: 0.6 },
    ...overrides,
  };
}

function rejectedCode(request: ActiveContextTransformRequest, deps: ActiveContextTransformDeps): string {
  const plan = planActiveContextTransform(request, deps);
  assert.equal(plan.status, "rejected");
  return plan.errorCode ?? "missing-errorCode";
}

// ── pure summary seam ──────────────────────────────────────────────────────

test("summarizeContextPure deterministic path truncates without an LLM", async () => {
  const long = "Sentence one about work. Filler sentence two. ".repeat(40);
  const result = await summarizeContextPure(long, 32, "deterministic", { deterministicMaxTokens: 32 });
  assert.equal(result.method, "deterministic");
  assert.equal(result.fallback, false);
  assert.ok(result.text.length < long.length);
});

test("summarizeContextPure auto prefers the LLM and marks fallback on degradation", async () => {
  const ok = await summarizeContextPure("some text", 64, "auto", {
    llm: async () => "llm summary",
  });
  assert.equal(ok.method, "llm");
  assert.equal(ok.fallback, false);
  assert.equal(ok.escalation, 0);

  const degraded = await summarizeContextPure("some text", 64, "auto", {
    llm: async () => null,
  });
  assert.equal(degraded.method, "deterministic");
  assert.equal(degraded.fallback, true);
  assert.equal(degraded.escalation, 2);
});

test("summarizeContextPure llm mode never falls back", async () => {
  await assert.rejects(
    summarizeContextPure("some text", 64, "llm", { llm: async () => null }),
    ContextSummaryUnavailableError,
  );
  await assert.rejects(
    summarizeContextPure("some text", 64, "llm", {}),
    ContextSummaryUnavailableError,
  );
});

// ── SUMMARY plan ───────────────────────────────────────────────────────────

test("SUMMARY plan is content-addressed, bounded, and carries no raw text", () => {
  const fixedNow = () => new Date("2026-08-18T10:00:00.000Z");
  const first = planActiveContextTransform(summaryRequest(), baseDeps({ now: fixedNow }));
  const second = planActiveContextTransform(summaryRequest(), baseDeps({ now: fixedNow }));

  assert.equal(first.status, "ready");
  assert.equal(first.planId, second.planId); // content-addressed, idempotent
  assert.equal(first.planHash, second.planHash);
  assert.deepEqual(first.selectedMessageIds, ["m-a", "m-b", "m-d"]); // snapshot order
  assert.deepEqual(first.proposedRemovalIds, ["m-a", "m-b", "m-d"]);
  assert.deepEqual(first.retainedMessageIds, ["m-sys", "m-c", "m-e"]);
  assert.equal(first.replacement?.messageId.startsWith("actxr-"), true);
  assert.deepEqual(first.replacement?.sourceMessageIds, ["m-a", "m-b", "m-d"]);
  assert.equal(first.replacement?.method, "deterministic");
  assert.deepEqual(first.inverse.sourceMessageIds, ["m-a", "m-b", "m-d"]);
  assert.equal(first.inverse.removeReplacementMessageId, first.replacement?.messageId);
  assert.equal(first.retention.mode, "adapter-local");
  assert.equal(first.precondition.snapshotRevision, 7);
  assert.equal(first.precondition.principal, SCOPE.principal);
  assert.ok(first.planHash.length === 64);

  // Plans carry hashes and counts, never message text.
  const serialized = JSON.stringify(first);
  for (const needle of ["alpha content", "beta content", "gamma content", "system prompt text"]) {
    assert.equal(serialized.includes(needle), false, `plan leaked raw text: ${needle}`);
  }
});

test("scope checks run before selection: session or namespace mismatch rejects with scope_mismatch", () => {
  const badSession = baseDeps({ resolvedScope: { ...SCOPE, sessionKey: "sess-other" } });
  // Selector is ALSO invalid (unknown ID) — scope must still win.
  assert.equal(
    rejectedCode(summaryRequest({ selector: { messageIds: ["nope"] } }), badSession),
    "scope_mismatch",
  );
  const badNamespace = baseDeps({ resolvedScope: { ...SCOPE, namespace: "ns-other" } });
  assert.equal(rejectedCode(summaryRequest(), badNamespace), "scope_mismatch");
});

test("selector rules: duplicate, unknown, dual-form, and inverted spans reject", () => {
  const deps = baseDeps();
  assert.equal(rejectedCode(summaryRequest({ selector: { messageIds: ["m-a", "m-a"] } }), deps), "invalid_request");
  assert.equal(rejectedCode(summaryRequest({ selector: { messageIds: ["missing"] } }), deps), "invalid_request");
  assert.equal(
    rejectedCode(
      summaryRequest({ selector: { messageIds: ["m-a"], span: { startMessageId: "m-a", endMessageId: "m-d" } } }),
      deps,
    ),
    "invalid_request",
  );
  assert.equal(
    rejectedCode(summaryRequest({ selector: { span: { startMessageId: "m-d", endMessageId: "m-a" } } }), deps),
    "invalid_request",
  );
});

test("system/developer/protected/named messages are never removable", () => {
  const deps = baseDeps();
  // Everything selected is protected → preserve_conflict, not a no-op plan.
  assert.equal(
    rejectedCode(summaryRequest({ selector: { messageIds: ["m-sys", "m-c"] } }), deps),
    "preserve_conflict",
  );
  // Developer role protected even when named as removable.
  const devSnapshot = fakeSnapshot([
    fakeMessage("d-1", 0, "developer", "dev text"),
    fakeMessage("u-1", 1, "user", "user text"),
    fakeMessage("u-2", 2, "user", "more text"),
    fakeMessage("u-3", 3, "user", "even more text"),
  ]);
  const plan = planActiveContextTransform(
    summaryRequest({ snapshot: devSnapshot, selector: { messageIds: ["d-1", "u-1"] } }),
    deps,
  );
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.proposedRemovalIds, ["u-1"]);
  assert.deepEqual(plan.preserve.protectedMessageIds, ["d-1"]);
});

test("keep floor rejects plans that would leave too little behind", () => {
  assert.equal(
    rejectedCode(summaryRequest({ preserve: { minRetainedMessages: 4 } }), baseDeps()),
    "preserve_conflict",
  );
});

test("closed span selects inclusively; expectedRevision mismatch is stale_context", () => {
  const plan = planActiveContextTransform(
    summaryRequest({ selector: { span: { startMessageId: "m-a", endMessageId: "m-d" } } }),
    baseDeps(),
  );
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.selectedMessageIds, ["m-a", "m-b", "m-c", "m-d"]);

  assert.equal(
    rejectedCode(summaryRequest({ expectedRevision: 6 }), baseDeps()),
    "stale_context",
  );
});

test("closed gate returns feature_disabled before any other check", () => {
  const deps = baseDeps({ actionsEnabled: false });
  assert.equal(rejectedCode(summaryRequest({ selector: { messageIds: ["missing"] } }), deps), "feature_disabled");
});

test("message and char caps reject oversized snapshots", () => {
  const bigSnapshot = fakeSnapshot(
    Array.from({ length: 12 }, (_, i) => fakeMessage(`x-${i}`, i, "user", `text ${i}`)),
  );
  const tightCaps = { ...CAPS, activeContextMaxMessages: 10 };
  assert.equal(
    rejectedCode(summaryRequest({ snapshot: bigSnapshot }), baseDeps({ caps: tightCaps })),
    "invalid_request",
  );
  const wideSnapshot = fakeSnapshot([fakeMessage("w-1", 0, "user", "x".repeat(500)), fakeMessage("w-2", 1, "user", "y"), fakeMessage("w-3", 2, "user", "z")]);
  const tightChars = { ...CAPS, activeContextMaxSnapshotChars: 100 };
  assert.equal(
    rejectedCode(summaryRequest({ snapshot: wideSnapshot }), baseDeps({ caps: tightChars })),
    "invalid_request",
  );
});

test("explicit llm method behind a closed llm gate is unsupported", () => {
  const noLlm = { ...CAPS, activeContextLlm: false };
  assert.equal(
    rejectedCode(summaryRequest({ summary: { method: "llm" } }), baseDeps({ caps: noLlm })),
    "unsupported",
  );
});

// ── FILTER plan ────────────────────────────────────────────────────────────

test("FILTER keeps score >= threshold, drops only chosen non-protected IDs, and hashes the criterion", () => {
  const scores: Record<string, number> = { "m-a": 0.9, "m-b": 0.5, "m-d": 0.6 };
  const plan = planActiveContextTransform(filterRequest(), baseDeps({
    scoreMessage: (m) => scores[m.id],
  }));
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.proposedRemovalIds, ["m-b"]); // 0.5 < 0.6; 0.6 stays (>=)
  assert.deepEqual(
    plan.scoreRows?.map((r) => [r.messageId, r.decision]),
    [["m-a", "keep"], ["m-b", "drop"], ["m-d", "keep"]],
  );
  assert.ok(plan.provenance.criterionHash?.length === 64);
  assert.equal(JSON.stringify(plan).includes("relevance-to-goal"), false); // rule text never logged
});

test("FILTER requires keepCriterion, a threshold in [0,1], and a score function", () => {
  const deps = baseDeps({ scoreMessage: () => 0.9 });
  assert.equal(
    rejectedCode(filterRequest({ filter: { keepCriterion: "", threshold: 0.6 } }), deps),
    "invalid_request",
  );
  assert.equal(
    rejectedCode(filterRequest({ filter: { keepCriterion: "rule", threshold: 1.5 } }), deps),
    "invalid_request",
  );
  assert.equal(rejectedCode(filterRequest(), baseDeps()), "filter_unavailable");
});

test("FILTER rejects missing, NaN, and out-of-range scores", () => {
  assert.equal(
    rejectedCode(filterRequest(), baseDeps({ scoreMessage: () => Number.NaN })),
    "filter_unavailable",
  );
  assert.equal(
    rejectedCode(filterRequest(), baseDeps({ scoreMessage: () => 1.2 })),
    "filter_unavailable",
  );
  assert.equal(
    rejectedCode(filterRequest(), baseDeps({ scoreMessage: () => undefined })),
    "filter_unavailable",
  );
});

// ── prepare ────────────────────────────────────────────────────────────────

test("prepare joins source text in order and content-addresses the replacement", async () => {
  const plan = planActiveContextTransform(summaryRequest(), baseDeps());
  const prepared = await prepareActiveContextTransform(plan, { ...baseDeps(), snapshot: SNAPSHOT });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.replacement?.text, "alpha content\n\nbeta content\n\ndelta content");
  assert.equal(
    prepared.replacement?.contentHash,
    createHash("sha256").update(prepared.replacement.text, "utf8").digest("hex"),
  );
  assert.equal(prepared.replacement?.method, "deterministic");
  assert.equal(prepared.replacement?.fallback, false);
});

test("prepare uses the injected LLM seam for llm method", async () => {
  const plan = planActiveContextTransform(
    summaryRequest({ summary: { method: "llm" } }),
    baseDeps({ caps: CAPS }),
  );
  assert.equal(plan.status, "ready");
  const prepared = await prepareActiveContextTransform(
    plan,
    { ...baseDeps({ caps: CAPS, summarize: async (text) => `summary of ${text.length} chars` }), snapshot: SNAPSHOT },
  );
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.replacement?.method, "llm");
});

test("prepare rejects a changed transcript fence, expired plans, and scope drift", async () => {
  const plan = planActiveContextTransform(summaryRequest(), baseDeps());
  const changed = fakeSnapshot(SNAPSHOT.messages.map((m) => (m.id === "m-a" ? { ...m, content: "tampered" } : m)));
  const fence = await prepareActiveContextTransform(plan, { ...baseDeps(), snapshot: changed });
  assert.equal(fence.status, "rejected");
  assert.equal(fence.errorCode, "plan_conflict");

  const expired = await prepareActiveContextTransform(
    plan,
    { ...baseDeps({ now: () => new Date(Date.parse(plan.retention.expiresAt) + 1) }), snapshot: SNAPSHOT },
  );
  assert.equal(expired.errorCode, "stale_context");

  const drifted = await prepareActiveContextTransform(
    plan,
    { ...baseDeps({ resolvedScope: { ...SCOPE, principal: "other" } }), snapshot: SNAPSHOT },
  );
  assert.equal(drifted.errorCode, "scope_mismatch");
});

test("prepare passes FILTER plans through after revalidation", async () => {
  const plan = planActiveContextTransform(filterRequest(), baseDeps({ scoreMessage: () => 0.9 }));
  const prepared = await prepareActiveContextTransform(plan, { ...baseDeps(), snapshot: SNAPSHOT });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.replacement, undefined);
});

// ── receipts ───────────────────────────────────────────────────────────────

function appliedReceipt(
  planId: string,
  planHash: string,
  overrides: Partial<ActiveContextApplyReceipt> = {},
): ActiveContextApplyReceipt {
  return {
    schemaVersion: 1,
    planId,
    planHash,
    adapterId: SCOPE.adapterId,
    outcome: "applied",
    hostRevisionBefore: 7,
    hostRevisionAfter: 8,
    appliedAt: "2026-08-18T10:05:00.000Z",
    ...overrides,
  };
}

test("recordActiveContextApplyReceipt validates and appends a text-free context record", async () => {
  const plan = planActiveContextTransform(summaryRequest(), baseDeps());
  const appended: unknown[] = [];
  const { recorded, event } = await recordActiveContextApplyReceipt(
    plan,
    appliedReceipt(plan.planId, plan.planHash),
    { ...SCOPE },
    { append: async (record) => { appended.push(record); return true; } },
  );
  assert.equal(recorded, true);
  assert.equal(event.recordKind, "context_transform");
  assert.equal(event.actionId, plan.planId);
  assert.equal(event.action, "summarize_context");
  const { telemetryRecorded: _flag, ...ledgerRow } = event;
  assert.deepEqual(appended, [ledgerRow]);
  assert.equal(event.proposedRemovalCount, 3);
  assert.equal(event.planHash, plan.planHash);
  assert.equal(event.snapshotRevision, 7);
  assert.equal(JSON.stringify(event).includes("alpha content"), false);
});

test("recordActiveContextApplyReceipt rejects bad scope, hash, revision, and shape", async () => {
  const plan = planActiveContextTransform(summaryRequest(), baseDeps());
  const recorder = { append: async () => true };

  await assert.rejects(
    recordActiveContextApplyReceipt(plan, appliedReceipt(plan.planId, plan.planHash), { ...SCOPE, principal: "other" }, recorder),
    (err: Error & { code?: string }) => err.code === "scope_mismatch",
  );
  await assert.rejects(
    recordActiveContextApplyReceipt(plan, appliedReceipt(plan.planId, "0".repeat(64)), { ...SCOPE }, recorder),
    (err: Error & { code?: string }) => err.code === "plan_conflict",
  );
  await assert.rejects(
    recordActiveContextApplyReceipt(plan, appliedReceipt(plan.planId, plan.planHash, { hostRevisionBefore: 6 }), { ...SCOPE }, recorder),
    (err: Error & { code?: string }) => err.code === "stale_context",
  );
  await assert.rejects(
    recordActiveContextApplyReceipt(plan, appliedReceipt("other-plan", plan.planHash), { ...SCOPE }, recorder),
    (err: Error & { code?: string }) => err.code === "invalid_receipt",
  );
});

test("ledger write failure returns recorded:false and never claims an apply", async () => {
  const plan = planActiveContextTransform(summaryRequest(), baseDeps());
  const { recorded, event } = await recordActiveContextApplyReceipt(
    plan,
    appliedReceipt(plan.planId, plan.planHash),
    { ...SCOPE },
    { append: async () => { throw new Error("ledger locked"); } },
  );
  assert.equal(recorded, false);
  assert.equal(event.telemetryRecorded, false);
});

test("plan-stage events are recordable without a receipt", () => {
  const plan = planActiveContextTransform(filterRequest(), baseDeps({ scoreMessage: () => 0.2 }));
  const event = buildContextTransformPlanEvent(plan, "skipped");
  assert.equal(event.recordKind, "context_transform");
  assert.equal(event.action, "filter_context");
  assert.equal(event.status, "validated");
  assert.equal(event.receiptOutcome, undefined);
});

// ── ledger discriminated union ─────────────────────────────────────────────

async function* linesOf(rows: string[]): AsyncGenerator<string> {
  yield* rows;
}

const LEGACY_ROW = JSON.stringify({ timestamp: "2026-01-01T00:00:00.000Z", action: "store_note", outcome: "applied" });
const CONTEXT_RECORD: ContextTransformTelemetryRecord = {
  recordKind: "context_transform",
  schemaVersion: 1,
  timestamp: "2026-01-02T00:00:00.000Z",
  actionId: "actx-fake",
  action: "summarize_context",
  outcome: "skipped",
  status: "validated",
  subsystem: "active-context",
  namespace: "ns-alpha",
  sourceSessionKey: "sess-fake-1",
  planHash: "h".repeat(64),
  snapshotRevision: 7,
  selectedCount: 3,
  retainedCount: 3,
  proposedRemovalCount: 3,
  selectorHash: "s".repeat(64),
  snapshotContentHash: "c".repeat(64),
};
const CONTEXT_ROW = JSON.stringify(CONTEXT_RECORD);

test("legacy action readers (CLI, compression, lifecycle, compounding) ignore context records", async () => {
  const rows = await readMemoryActionEventRowsFromLines(
    linesOf([LEGACY_ROW, CONTEXT_ROW, "{malformed", LEGACY_ROW]),
    10,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !Object.hasOwn(row.event, "recordKind")));
});

test("context readers select only context records", async () => {
  const rows = await readContextTransformRecordRowsFromLines(
    linesOf([LEGACY_ROW, CONTEXT_ROW, CONTEXT_ROW]),
    10,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.line), [2, 3]);
  assert.ok(rows.every((r) => r.record.recordKind === "context_transform"));
});

test("storage round-trip: one ledger, two record families, isolated reads", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-actx-ledger-"));
  try {
    const storage = new StorageManager(memoryDir);
    await storage.appendMemoryActionEvents([
      { timestamp: "2026-01-01T00:00:00.000Z", action: "discard", outcome: "skipped" },
    ]);
    await storage.appendContextTransformRecords([CONTEXT_RECORD]);

    const actions = await storage.readMemoryActionEvents(10);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, "discard");

    const contexts = await storage.readContextTransformRecords(10);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].recordKind, "context_transform");
    assert.equal(contexts[0].actionId, "actx-fake");
  } finally {
    await rm(memoryDir, { recursive: true, force: true });
  }
});
