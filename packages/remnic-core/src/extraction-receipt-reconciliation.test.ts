import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admitExtractionReceipt } from "./extraction-receipt-admission.js";
import { receiptHash } from "./extraction-receipt-provenance.js";
import {
  receiptExistingMemory,
  receiptFactSlot,
  receiptPersisted,
  receiptProviderPayload,
  receiptProviderResult,
  receiptReconcile,
  receiptStorage,
  withExtractionReceipt,
} from "./extraction-receipt-runtime.js";
import { ExtractionReceiptStore } from "./extraction-receipts.js";
import { StorageManager } from "./storage.js";
import type { ExtractionResult, MemoryFrontmatter } from "./types.js";
import { composeMemoryEnvelope } from "./write-envelope.js";

const fact = {
  content: "The synthetic release requires green tests.",
  category: "fact" as const,
  confidence: 0.95,
  tags: [],
};
const result: ExtractionResult = { facts: [fact], entities: [], questions: [], profileUpdates: [] };
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const admission = await admitExtractionReceipt({
    memoryDir: dir,
    principal: "owner",
    namespace: "tenant",
    sessionKey: "session",
    scope: { project: "synthetic" },
    chunk: { sourceDigest: "a".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    messages: [{ content: "synthetic input" }],
    turns: [
      {
        role: "user",
        source: "openclaw",
        sessionKey: "session",
        timestamp: "2026-01-01T00:00:00Z",
        content: "synthetic input",
      },
    ],
    maxChars: 500,
  });
  const storage = new StorageManager(dir);
  const store = new ExtractionReceiptStore(dir);
  const run = async (r = result, stopAfter = Number.POSITIVE_INFINITY) =>
    withExtractionReceipt(dir, admission.turns, 500, async () => {
      receiptProviderPayload(r, r);
      await receiptProviderResult(r);
      await receiptReconcile(storage);
      let count = 0;
      for (const candidate of r.facts) {
        receiptFactSlot(candidate);
        const existing = (await storage.readAllMemories()).find((m) => m.content === candidate.content);
        if (existing) await receiptExistingMemory(storage, "tenant", () => storage.readMemoryByPath(existing.path));
        else
          await receiptStorage(storage, "tenant").writeSealedMemory(
            composeMemoryEnvelope(
              { category: "fact", content: candidate.content, confidence: candidate.confidence, tags: candidate.tags },
              { source: "extraction" }
            )
          );
        if (++count >= stopAfter) throw new Error("synthetic crash");
      }
      receiptPersisted(0, []);
    });
  return { dir, storage, store, admission, run };
}
test("same-plan retry recovers actual committed provenance after lost confirmation", async (t) => {
  const f = await fixture(t);
  const original = ExtractionReceiptStore.prototype.confirmArtifact;
  ExtractionReceiptStore.prototype.confirmArtifact = async () => {
    throw new Error("synthetic crash before confirm");
  };
  try {
    await assert.rejects(f.run(), /synthetic crash/);
  } finally {
    ExtractionReceiptStore.prototype.confirmArtifact = original;
  }
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
  const before = await f.storage.readAllMemories();
  assert.equal(before.length, 1);
  assert.ok(before[0]!.frontmatter.extractionEffects?.length);
  await f.run();
  const after = await f.storage.readAllMemories();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.frontmatter.id, before[0]!.frontmatter.id);
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, true);
});
test("recovery claims only the exact settled plan and never fences a live attempt", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(result, 1), /synthetic crash/);
  const receipt = (await f.store.get(f.admission.receipt.receiptId))!;
  const plan = receipt.members[0]!.plan!;
  assert.ok(plan);
  await assert.rejects(f.store.beginRecovery({ ...plan, identityDigest: "b".repeat(64) }), /Invalid recovery plan/);
  const token = await f.store.beginRecovery(plan);
  await assert.rejects(f.store.beginRecovery(plan), /not eligible/);
  await f.store.assertCurrent(token);
  assert.equal((await f.store.get(receipt.receiptId))!.coverageComplete, false);
  await f.store.finish(token, { status: "retry", artifacts: [], reason: "synthetic" });
  const retry = await f.store.beginRecovery(plan);
  await assert.rejects(f.store.assertCurrent(token), /Stale/);
  await f.store.assertCurrent(retry);
});
test("different provider plan cannot write over an interrupted plan", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(result, 1), /synthetic crash/);
  const changed = { ...result, facts: [{ ...fact, content: "A different synthetic fact." }] };
  await assert.rejects(f.run(changed), /plan changed/);
  assert.equal((await f.storage.readAllMemories()).length, 1);
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
});
test("partial multi-fact plan cannot become complete from one recovered effect", async (t) => {
  const f = await fixture(t);
  const r = { ...result, facts: [fact, { ...fact, content: "The second synthetic effect must also exist." }] };
  await assert.rejects(f.run(r, 1), /synthetic crash/);
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
  await f.run(r);
  assert.equal((await f.storage.readAllMemories()).length, 2);
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
  await f.run(r);
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, true);
});

test("fresh closed plan has no recovered effect and cannot complete before persistence", async (t) => {
  const f = await fixture(t);
  await withExtractionReceipt(f.dir, f.admission.turns, 500, async () => {
    receiptProviderPayload(result, result);
    await receiptProviderResult(result);
    await receiptReconcile(f.storage);
    receiptPersisted(0, []);
  });
  const receipt = (await f.store.get(f.admission.receipt.receiptId))!;
  assert.equal(receipt.coverageComplete, false);
  assert.equal(receipt.artifacts.length, 0);
});
test("identical candidate occurrences are explicitly unsupported rather than Set-covered", async (t) => {
  const f = await fixture(t);
  await f.run({ ...result, facts: [fact, { ...fact }] });
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
});
for (const boundary of ["prepare", "write", "finish"] as const)
  test(`crash at ${boundary} preserves honest recovery state`, async (t) => {
    const f = await fixture(t);
    const prepare = ExtractionReceiptStore.prototype.prepareArtifact;
    const finish = ExtractionReceiptStore.prototype.finish;
    const write = f.storage.writeSealedMemory;
    if (boundary === "prepare")
      ExtractionReceiptStore.prototype.prepareArtifact = async function (...args) {
        await prepare.apply(this, args);
        throw new Error("synthetic boundary crash");
      };
    if (boundary === "write")
      f.storage.writeSealedMemory = async function (...args) {
        await write.apply(this, args);
        throw new Error("synthetic boundary crash");
      };
    if (boundary === "finish")
      ExtractionReceiptStore.prototype.finish = async () => {
        throw new Error("synthetic boundary crash");
      };
    try {
      await assert.rejects(f.run(), /synthetic boundary crash/);
    } finally {
      ExtractionReceiptStore.prototype.prepareArtifact = prepare;
      ExtractionReceiptStore.prototype.finish = finish;
      f.storage.writeSealedMemory = write;
    }
    assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
    await f.run();
    assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, boundary !== "prepare");
  });
for (const corruption of [
  "body",
  "missing",
  "legacy",
  "namespace",
  "attempt",
  "identity",
  "membership",
  "chunkIndex",
  "chunkTotal",
  "entityRef",
  "structuredAttributes",
  "sourceMemoryId",
] as const)
  test(`recovery rejects ${corruption} artifact evidence`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.run(result, 1), /synthetic crash/);
    const [memory] = await f.storage.readAllMemories();
    assert.ok(memory);
    if (corruption === "missing") await rm(memory.path);
    else if (corruption === "body") await f.storage.updateMemory(memory.frontmatter.id, "Changed synthetic body");
    else {
      const effects = structuredClone(memory.frontmatter.extractionEffects!);
      if (corruption === "namespace") effects[0]!.namespace = "foreign";
      if (corruption === "attempt") effects[0]!.attemptId = "foreign-attempt";
      if (corruption === "identity") effects[0]!.identityDigest = "b".repeat(64);
      if (corruption === "membership") effects[0]!.members[0]!.memberId = "foreign-member";
      const metadata: Partial<MemoryFrontmatter> = { extractionEffects: corruption === "legacy" ? undefined : effects };
      if (corruption === "chunkIndex") metadata.chunkIndex = 0;
      if (corruption === "chunkTotal") metadata.chunkTotal = 2;
      if (corruption === "entityRef") metadata.entityRef = "synthetic-entity";
      if (corruption === "structuredAttributes") metadata.structuredAttributes = { synthetic: "value" };
      if (corruption === "sourceMemoryId") metadata.sourceMemoryId = "synthetic-source";
      await f.storage.writeMemoryFrontmatterIfUnchanged(memory, metadata);
    }
    if (corruption === "missing") await assert.rejects(f.run(), /artifact changed/);
    else await f.run();
    assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
  });
test("changed provider output kind stops before effects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run(result, 1), /synthetic crash/);
  await assert.rejects(
    f.run({ ...result, facts: [], questions: [{ question: "Synthetic question", context: "synthetic", priority: 1 }] }),
    /plan changed or unsupported/
  );
  assert.equal((await f.storage.readAllMemories()).length, 1);
});
test("new attempt waits for fenced artifact write and stale writer cannot confirm", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  const write = f.storage.writeSealedMemory;
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  f.storage.writeSealedMemory = async function (...args) {
    const value = await write.apply(this, args);
    entered.resolve();
    await release.promise;
    return value;
  };
  const running = f.run();
  await entered.promise;
  const next = f.store.begin(f.admission.turns.flatMap((turn) => turn.extractionReceiptMembers ?? []));
  release.resolve();
  await next;
  await assert.rejects(running, /Stale extraction attempt/);
  f.storage.writeSealedMemory = write;
  await f.run();
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, true);
  assert.equal((await f.storage.readAllMemories()).length, 1);
});

test("crash on artifact fsync leaves a recoverable actual file, not terminal coverage", async (t) => {
  const f = await fixture(t);
  const handle = await open(path.join(f.dir, "synthetic-probe"), "w");
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  const write = f.storage.writeSealedMemory;
  let armed = false;
  f.storage.writeSealedMemory = async function (...args) {
    const value = await write.apply(this, args);
    armed = true;
    return value;
  };
  prototype.sync = async function () {
    if (armed) {
      armed = false;
      throw new Error("synthetic fsync crash");
    }
    return sync.call(this);
  };
  try {
    await assert.rejects(f.run(), /synthetic fsync crash/);
  } finally {
    prototype.sync = sync;
    f.storage.writeSealedMemory = write;
  }
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, false);
  await f.run();
  assert.equal((await f.store.get(f.admission.receipt.receiptId))!.coverageComplete, true);
  assert.equal((await f.storage.readAllMemories()).length, 1);
});

test("plan hashing canonicalizes optional fields at every object depth", () => {
  assert.equal(receiptHash({ z: 1, nested: { b: 2, a: undefined } }), receiptHash({ nested: { b: 2 }, z: 1 }));
});
