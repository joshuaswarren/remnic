import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EngramAccessService } from "./access-service.js";
import { admitExtractionReceipt } from "./extraction-receipt-admission.js";
import { receiptProviderPayload } from "./extraction-receipt-runtime.js";
import { ExtractionReceiptStore } from "./extraction-receipts.js";
import { Orchestrator } from "./orchestrator.js";
import { makeLifecycleConfig, singleFactResult, stubExtraction } from "./testing/orchestrator-lite.js";
import type { ExtractionResult } from "./types.js";

const empty: ExtractionResult = { facts: [], entities: [], questions: [], profileUpdates: [], relationships: [] };
async function fixture(t: import("node:test").TestContext, factDeduplicationEnabled = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "access-receipt-"));
  const config = makeLifecycleConfig(dir, {
    extractionReceiptsEnabled: true,
    factDeduplicationEnabled,
    namespacesEnabled: true,
    defaultNamespace: "default",
    sharedNamespace: "shared",
    sharedContextEnabled: false,
    transcriptEnabled: false,
    objectiveStateMemoryEnabled: false,
    objectiveStateSnapshotWritesEnabled: false,
    extractionFaithfulnessEnabled: false,
    extractionMaxTurnChars: 500,
    bufferMaxTurns: 100,
    namespacePolicies: [
      { name: "owner", readPrincipals: ["owner", "reader"], writePrincipals: ["owner"] },
      { name: "foreign", readPrincipals: ["reader"], writePrincipals: ["reader"] },
    ],
  });
  const orchestrator = new Orchestrator(config);
  t.after(async () => {
    await orchestrator.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, orchestrator, service: new EngramAccessService(orchestrator) };
}

test("receipt read requires authenticated owner and authorized exact namespace", async (t) => {
  const f = await fixture(t);
  const { receipt } = await admitExtractionReceipt({
    memoryDir: f.dir,
    chunk: { sourceDigest: "a".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    principal: "owner",
    namespace: "owner",
    sessionKey: "session",
    scope: { project: "project" },
    messages: [{ content: "text" }],
    turns: [
      {
        source: "openclaw",
        sessionKey: "session",
        timestamp: "2026-01-01T00:00:00.000Z",
        role: "user",
        content: "text",
      },
    ],
    maxChars: 500,
  });
  await assert.rejects(
    f.service.extractionReceiptGet({ receiptId: receipt.receiptId, namespace: "owner" }),
    /Authentication required/
  );
  await assert.rejects(
    f.service.extractionReceiptGet({
      receiptId: receipt.receiptId,
      namespace: "owner",
      authenticatedPrincipal: "stranger",
    }),
    /not readable/
  );
  assert.deepEqual(
    await f.service.extractionReceiptGet({
      receiptId: receipt.receiptId,
      namespace: "owner",
      authenticatedPrincipal: "reader",
    }),
    { found: false }
  );
  assert.deepEqual(
    await f.service.extractionReceiptGet({
      receiptId: receipt.receiptId,
      namespace: "foreign",
      authenticatedPrincipal: "reader",
    }),
    { found: false }
  );
  const found = await f.service.extractionReceiptGet({
    receiptId: receipt.receiptId,
    namespace: "owner",
    authenticatedPrincipal: "owner",
  });
  assert.equal(found.found, true);
  assert.equal(found.receipt?.coverageComplete, false);
});

test("observe -> durable buffer -> writer distinguishes valid empty from persisted nonempty", async (t) => {
  for (const mode of ["empty", "fact"] as const) {
    const f = await fixture(t);
    const content = "The synthetic project's release gate requires a green test result before deployment.";
    stubExtraction(f.orchestrator, () => {
      const result = mode === "empty" ? empty : singleFactResult(content);
      return receiptProviderPayload(result, result);
    });
    const accepted = await f.service.observe({
      sessionKey: `owner:${mode}`,
      namespace: "owner",
      authenticatedPrincipal: "owner",
      messages: [{ role: "user", content }],
      extractionReceipt: { sourceDigest: "b".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    });
    assert.ok(accepted.extractionReceiptId);
    await f.service.extractionForceFlush({
      sessionKey: `owner:${mode}`,
      namespace: "owner",
      authenticatedPrincipal: "owner",
    });
    const receipt = (await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId))!;
    assert.equal(receipt.coverageComplete, true, JSON.stringify(receipt));
    assert.equal(receipt.status, mode === "empty" ? "empty_success" : "durable_extracted");
    assert.equal(receipt.artifacts.length === 0, mode === "empty");
  }
});

test("experimental receipt admission is default off", async (t) => {
  const f = await fixture(t);
  assert.equal(makeLifecycleConfig(f.dir).extractionReceiptsEnabled, false);
  f.orchestrator.config.extractionReceiptsEnabled = false;
  await assert.rejects(
    f.service.observe({
      sessionKey: "owner:disabled",
      namespace: "owner",
      authenticatedPrincipal: "owner",
      messages: [{ role: "user", content: "Synthetic input" }],
      extractionReceipt: { sourceDigest: "d".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    }),
    /Extraction receipts are disabled/
  );
});

test("a repeated exact fact uses a verified existing ID rather than a boolean dedup hit", async (t) => {
  const f = await fixture(t);
  const content = "The synthetic project's release gate requires a green test result before deployment.";
  stubExtraction(f.orchestrator, () => {
    const result = singleFactResult(content);
    return receiptProviderPayload(result, result);
  });
  const receipts = [];
  for (const iteration of [1, 2]) {
    const sessionKey = `owner:duplicate-${iteration}`;
    const accepted = await f.service.observe({
      sessionKey,
      namespace: "owner",
      authenticatedPrincipal: "owner",
      messages: [{ role: "user", content }],
      extractionReceipt: { sourceDigest: String(iteration).repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    });
    assert.ok(accepted.extractionReceiptId);
    await f.service.extractionForceFlush({ sessionKey, namespace: "owner", authenticatedPrincipal: "owner" });
    const receipt = await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId);
    assert.ok(receipt);
    assert.equal(receipt.coverageComplete, true, JSON.stringify(receipt));
    receipts.push(receipt);
  }
  assert.equal(receipts[1]!.artifacts[0]!.id, receipts[0]!.artifacts[0]!.id);
  assert.equal(receipts[1]!.artifacts[0]!.disposition, "deduplicated");
  assert.match(receipts[1]!.artifacts[0]!.effectDigest!, /^[a-f0-9]{64}$/);
});

test("observe retry reconciles a real fact committed before receipt confirmation", async (t) => {
  const f = await fixture(t, false);
  const content = "The synthetic release gate requires green tests before publishing.";
  stubExtraction(f.orchestrator, () => {
    const result = singleFactResult(content);
    return receiptProviderPayload(result, result);
  });
  const sessionKey = "owner:crash-recovery";
  const accepted = await f.service.observe({
    sessionKey,
    namespace: "owner",
    authenticatedPrincipal: "owner",
    messages: [{ role: "user", content }],
    extractionReceipt: { sourceDigest: "e".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
  });
  assert.ok(accepted.extractionReceiptId);
  const flush = () =>
    f.service.extractionForceFlush({ sessionKey, namespace: "owner", authenticatedPrincipal: "owner" });
  const confirm = ExtractionReceiptStore.prototype.confirmArtifact;
  ExtractionReceiptStore.prototype.confirmArtifact = async () => {
    throw new Error("synthetic lost receipt confirmation");
  };
  try {
    await assert.rejects(flush(), /synthetic lost receipt confirmation/);
  } finally {
    ExtractionReceiptStore.prototype.confirmArtifact = confirm;
  }
  const interrupted = (await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId))!;
  assert.equal(interrupted.coverageComplete, false);
  await flush();
  const recovered = (await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId))!;
  assert.equal(recovered.coverageComplete, true, JSON.stringify(recovered));
  assert.equal(new Set(recovered.artifacts.map((a) => a.id)).size, 1);
});

test("prepare-only journal stays incomplete without hiding later real fact recovery", async (t) => {
  const f = await fixture(t, false);
  const content = "The synthetic immutable plan must survive retries without duplicate fact writes.";
  stubExtraction(f.orchestrator, () => {
    const result = singleFactResult(content);
    return receiptProviderPayload(result, result);
  });
  const sessionKey = "owner:prepare-only";
  const accepted = await f.service.observe({
    sessionKey,
    namespace: "owner",
    authenticatedPrincipal: "owner",
    messages: [{ role: "user", content }],
    extractionReceipt: { sourceDigest: "f".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
  });
  assert.ok(accepted.extractionReceiptId);
  const flush = () =>
    f.service.extractionForceFlush({ sessionKey, namespace: "owner", authenticatedPrincipal: "owner" });
  const prepare = ExtractionReceiptStore.prototype.prepareArtifact;
  ExtractionReceiptStore.prototype.prepareArtifact = async function (...args) {
    await prepare.apply(this, args);
    throw new Error("synthetic prepare-only interruption");
  };
  try {
    await assert.rejects(flush(), /synthetic prepare-only interruption/);
  } finally {
    ExtractionReceiptStore.prototype.prepareArtifact = prepare;
  }
  await flush();
  const first = (await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId))!;
  assert.equal(first.coverageComplete, false);
  assert.equal(first.artifacts.length, 1);
  await flush();
  const retry = (await new ExtractionReceiptStore(f.dir).get(accepted.extractionReceiptId))!;
  assert.equal(retry.coverageComplete, false);
  assert.deepEqual(
    retry.artifacts.map((a) => a.id),
    first.artifacts.map((a) => a.id)
  );
  assert.equal(retry.journal.length, 2);
});
