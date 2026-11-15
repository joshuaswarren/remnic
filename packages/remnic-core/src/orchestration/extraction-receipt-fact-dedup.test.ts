import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { admitExtractionReceipt } from "../extraction-receipt-admission.js";
import { blockReceiptCoverage, receiptPersisted, withExtractionReceipt } from "../extraction-receipt-runtime.js";
import { ExtractionReceiptStore } from "../extraction-receipts.js";
import { StorageManager } from "../storage.js";
import { makeLifecycleConfig } from "../testing/orchestrator-lite.js";
import type { MemoryFrontmatter } from "../types.js";
import { type ReceiptFactDedupOptions, confirmReceiptFactDuplicate } from "./extraction-receipt-fact-dedup.js";
import { findActiveFactDuplicate, persistUnderFactDedupWindow } from "./fact-dedup-window.js";

const content = "The bounded synthetic fact is stable.";
const predicate = { category: "fact", contentHashDedupKey: content, citationEnabled: false, citationTemplate: "" };
async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "receipt-dedup-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new StorageManager(dir);
  await storage.writeMemory("fact", content, { confidence: 0.95 });
  const match = await findActiveFactDuplicate(storage, predicate);
  assert.ok(match);
  const admission = await admitExtractionReceipt({
    memoryDir: dir,
    chunk: { sourceDigest: "a".repeat(64), chunkStart: 0, chunkEnd: 1, chunkVersion: "v1" },
    principal: "owner",
    namespace: "tenant",
    sessionKey: "session",
    scope: {},
    messages: [{ role: "user", content }],
    turns: [
      { source: "openclaw", role: "user", sessionKey: "session", timestamp: "2026-01-01T00:00:00.000Z", content },
    ],
    maxChars: 1000,
  });
  const options: ReceiptFactDedupOptions = {
    fact: { category: "fact", content, confidence: 0.9, tags: [] },
    config: makeLifecycleConfig(dir),
    importance: "high",
    temporal: false,
    toolScoped: false,
  };
  async function run(namespace = "tenant", opts = options, pred = predicate) {
    let confirmed = false;
    await withExtractionReceipt(dir, admission.turns, 1000, async () => {
      confirmed = await confirmReceiptFactDuplicate(storage, namespace, match, pred, opts);
      if (!confirmed) blockReceiptCoverage();
      receiptPersisted(0, []);
    });
    const receipt = await new ExtractionReceiptStore(dir).get(admission.receipt.receiptId);
    assert.ok(receipt);
    return { confirmed, receipt };
  }
  return { storage, match, options, run };
}

test("locked recheck retains the actual winning ID and durable existing-effect digest", async (t) => {
  const f = await fixture(t);
  const outcome = await persistUnderFactDedupWindow(
    f.storage.dir,
    async () => (await findActiveFactDuplicate(f.storage, predicate)) ?? false,
    async () => assert.fail("duplicate must not be written again")
  );
  assert.equal(outcome.suppressed, true);
  assert.ok(outcome.suppressed && outcome.match);
  assert.equal(outcome.match.frontmatter.id, f.match.frontmatter.id);
  const { confirmed, receipt } = await f.run();
  assert.equal(confirmed, true);
  assert.equal(receipt.coverageComplete, true);
  const artifact = receipt.artifacts[0];
  assert.ok(artifact?.effectDigest);
  assert.equal(artifact.id, f.match.frontmatter.id);
  assert.equal(artifact.disposition, "deduplicated");
  assert.match(artifact.effectDigest, /^[a-f0-9]{64}$/);
});

for (const mismatch of [
  "namespace",
  "connector",
  "category",
  "subject",
  "entity",
  "project",
  "temporal",
  "tags",
  "confidence",
  "missing",
  "low-importance",
  "judge",
  "spans",
  "faithfulness",
] as const) {
  test(`existing-effect proof rejects ${mismatch} mismatch`, async (t) => {
    const f = await fixture(t);
    const options: ReceiptFactDedupOptions = { ...f.options, fact: { ...f.options.fact } };
    const pred = { ...predicate };
    if (mismatch === "low-importance") {
      options.importance = "trivial";
      options.config = { ...options.config, extractionMinImportanceLevel: "normal" };
    }
    if (mismatch === "judge") {
      options.judge = { durable: false, reason: "synthetic rejection" };
      options.config = { ...options.config, extractionJudgeShadow: false };
    }
    if (mismatch === "spans") {
      options.fact.requireSpansPending = true;
      options.config = { ...options.config, provenance: { ...options.config.provenance, requireSpans: true } };
    }
    if (mismatch === "faithfulness") {
      options.faithfulness = { ok: true, verdict: "contradicted", model: "synthetic" };
      options.config = { ...options.config, extractionFaithfulnessGate: "enforce" };
    }
    if (mismatch === "connector") Object.assign(pred, { connector: "other" });
    if (mismatch === "category") pred.category = "decision";
    if (mismatch === "subject") options.subject = "agent";
    if (mismatch === "entity") options.fact.entityRef = "other-entity";
    if (mismatch === "project") options.fact.scope = "project";
    if (mismatch === "temporal") options.temporal = true;
    if (mismatch === "tags") options.fact.tags = ["missing-tag"];
    if (mismatch === "confidence") options.fact.confidence = 1;
    if (mismatch === "missing") await rm(f.match.path);
    const result = await f.run(mismatch === "namespace" ? "other" : "tenant", options, pred);
    assert.equal(result.confirmed, false);
    assert.equal(result.receipt.coverageComplete, false);
  });
}

test("a record changed between read-back and confirmation leaves an unresolved journal", async (t) => {
  const f = await fixture(t);
  const original = f.storage.readMemoryByPath.bind(f.storage);
  let reads = 0;
  t.mock.method(f.storage, "readMemoryByPath", async (file: string) => {
    const memory = await original(file);
    reads += 1;
    return memory && reads > 1 ? { ...memory, content: "Changed while checking." } : memory;
  });
  const { confirmed, receipt } = await f.run();
  assert.equal(confirmed, false);
  assert.equal(receipt.coverageComplete, false);
  assert.ok(receipt.members.some((member) => member.journal.some((journal) => !journal.confirmed)));
});

const unsupportedStoredEffects = {
  expired: { expiresAt: "2020-01-01T00:00:00.000Z" },
  future: { valid_at: "2099-01-01T00:00:00.000Z" },
  invalidated: { invalid_at: "2020-01-01T00:00:00.000Z" },
  eventTime: { eventTimeSource: "extracted" },
  chunkedParent: { tags: ["chunked"] },
  chunkChild: { parentId: "missing-parent", chunkIndex: 0, chunkTotal: 2 },
  artifactSource: { source: "artifact" },
  artifactLineage: { artifactType: "fact", sourceMemoryId: "unverified-source" },
} satisfies Record<string, Partial<MemoryFrontmatter>>;
for (const [name, patch] of Object.entries(unsupportedStoredEffects)) {
  test(`stored ${name} does not prove an unbounded plain fact`, async (t) => {
    const f = await fixture(t);
    assert.equal(await f.storage.updateMemoryFrontmatter(f.match.frontmatter.id, patch), true);
    const { confirmed, receipt } = await f.run();
    assert.equal(confirmed, false);
    assert.equal(receipt.coverageComplete, false);
  });
}

test("same-body inode replacement after sync cannot confirm an unsynced replacement", async (t) => {
  const f = await fixture(t);
  const original = f.storage.readMemoryByPath.bind(f.storage);
  let reads = 0;
  t.mock.method(f.storage, "readMemoryByPath", async (file: string) => {
    reads += 1;
    if (reads === 2) {
      const replacement = `${file}.replacement`;
      await writeFile(replacement, await readFile(file));
      await rename(replacement, file);
    }
    return original(file);
  });
  const { confirmed, receipt } = await f.run();
  assert.equal(confirmed, false);
  assert.equal(receipt.coverageComplete, false);
  assert.ok(receipt.members.some((member) => member.journal.some((journal) => !journal.confirmed)));
});

test("legacy artifact path without lineage does not prove a plain fact", async (t) => {
  const f = await fixture(t);
  const artifactDir = path.join(f.storage.dir, "artifacts", "2026-01-01");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, path.basename(f.match.path));
  await rename(f.match.path, artifactPath);
  f.match.path = artifactPath;
  const { confirmed, receipt } = await f.run();
  assert.equal(confirmed, false);
  assert.equal(receipt.coverageComplete, false);
});
