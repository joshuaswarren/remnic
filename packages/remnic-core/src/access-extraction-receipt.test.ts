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
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "access-receipt-"));
  const config = makeLifecycleConfig(dir, {
    extractionReceiptsEnabled: true, namespacesEnabled: true,
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

test("experimental receipt admission is default off", async t => {
  const f = await fixture(t);
  assert.equal(makeLifecycleConfig(f.dir).extractionReceiptsEnabled, false);
  f.orchestrator.config.extractionReceiptsEnabled = false;
  await assert.rejects(f.service.observe({ sessionKey: "owner:disabled", namespace: "owner", authenticatedPrincipal: "owner", messages: [{ role: "user", content: "Synthetic input" }], extractionReceipt: { sourceDigest: "d".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" } }), /Extraction receipts are disabled/);
});
