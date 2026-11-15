/** Receipt-specific real observe/buffer lifecycle; provider results are synthetic. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EngramAccessService } from "../../access-service.js";
import { receiptProviderPayload } from "../../extraction-receipt-runtime.js";
import { ExtractionReceiptStore } from "../../extraction-receipts.js";
import { Orchestrator } from "../../orchestrator.js";
import { type LifecycleSubject, runLifecycleMatrix } from "../lifecycle-matrix.js";
import { makeLifecycleConfig, stubExtraction } from "../orchestrator-lite.js";

const request = {
  sessionKey: "owner:receipt",
  namespace: "owner",
  authenticatedPrincipal: "owner",
  messages: [{ role: "user" as const, content: "The synthetic canary gate remains pending for review." }],
  extractionReceipt: { sourceDigest: "c".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
};
function build(dir: string) {
  const orchestrator = new Orchestrator(
    makeLifecycleConfig(dir, {
      extractionReceiptsEnabled: true,
      namespacesEnabled: true,
      defaultNamespace: "default",
      sharedNamespace: "shared",
      sharedContextEnabled: false,
      transcriptEnabled: false,
      objectiveStateMemoryEnabled: false,
      objectiveStateSnapshotWritesEnabled: false,
      bufferMaxTurns: 100,
      namespacePolicies: [{ name: "owner", readPrincipals: ["owner"], writePrincipals: ["owner"] }],
    })
  );
  stubExtraction(orchestrator, () => {
    const empty = { facts: [], entities: [], questions: [], profileUpdates: [], relationships: [] };
    return receiptProviderPayload(empty, empty);
  });
  return orchestrator;
}
interface State {
  dir: string;
  orchestrator: Orchestrator;
  receiptId: string;
}
const subject: LifecycleSubject<State> = {
  appliesTo(row) {
    if (["sparse-metadata-with-binding", "sparse-metadata-without-binding", "provider-rebinding"].includes(row.id))
      return "Receipt admission requires explicit authenticated principal; provider identity inference is exercised by the extraction-lifecycle subject.";
    return true;
  },
  async setup() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-lifecycle-"));
    const orchestrator = build(dir);
    try {
      const observed = await new EngramAccessService(orchestrator).observe(request);
      assert.ok(observed.extractionReceiptId);
      return { dir, orchestrator, receiptId: observed.extractionReceiptId };
    } catch (error) {
      await orchestrator.destroy();
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  },
  async exercise(state, row) {
    assert.equal(
      (await new ExtractionReceiptStore(state.dir).get(state.receiptId))?.coverageComplete,
      false,
      "Admission is not coverage"
    );
    if (row.dimensions.restart) {
      await state.orchestrator.destroy();
      state.orchestrator = build(state.dir);
    }
    if (row.dimensions.flush !== "none")
      await state.orchestrator.flushSession(request.sessionKey, {
        reason: row.dimensions.flush,
        writeNamespaceOverride: "owner",
        principalOverride: "owner",
      });
    else await new EngramAccessService(state.orchestrator).extractionForceFlush(request);
    if (row.dimensions.dedupeOrReplay) {
      const replay = await new EngramAccessService(state.orchestrator).observe(request);
      assert.equal(replay.extractionReceiptId, state.receiptId);
      await new EngramAccessService(state.orchestrator).extractionForceFlush(request);
    }
  },
  async invariants(state) {
    const receipt = await new ExtractionReceiptStore(state.dir).get(state.receiptId);
    assert.equal(receipt?.coverageComplete, true, JSON.stringify(receipt));
    assert.equal(receipt?.status, "empty_success");
    assert.equal(receipt?.identity.principal, "owner");
    assert.equal(receipt?.identity.namespace, "owner");
    assert.deepEqual(receipt?.artifacts, []);
  },
  async teardown(state) {
    await state.orchestrator.destroy();
    await rm(state.dir, { recursive: true, force: true });
  },
};
runLifecycleMatrix("extraction-receipts-lifecycle", subject);
