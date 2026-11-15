import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  type ArtifactEvidence,
  type AttemptToken,
  ExtractionReceiptStore,
  type ReceiptDiskPayload,
  type ReceiptIdentity,
} from "./extraction-receipts.js";

// Contract/scenario matrix before implementation:
// complete identity/scope -> immutable admission; malformed/missing identity -> reject;
// overlap/reset/retry -> fence stale attempt; disjoint members -> independent;
// partial persistence -> never terminal; all registered pieces -> coverage;
// prepare/crash/restart -> uncertain, not coverage; explicit confirm -> evidence;
// failed/deferred/retry -> preserve references; validated empty -> no artifacts;
// cross-receipt write/commit failure -> no partial coverage; corruption -> fail closed;
// namespace/principal/session/source/version changes -> isolated receipts;
// lifecycle flush/end/reset routing is exercised by integration owner, not this store.
const identity: ReceiptIdentity = {
  principal: "principal-a",
  namespace: "tenant-a",
  sessionKey: "session-a",
  scopeHash: "scope-a",
  sourceDigest: "source-a",
  chunkStart: 0,
  chunkEnd: 2,
  chunkVersion: "v1",
  messagesHash: "messages-a",
};
const artifact: ArtifactEvidence = { kind: "memory", namespace: "tenant-a", id: "memory-a", disposition: "written" };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "extraction-receipts-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new ExtractionReceiptStore(dir) };
}
async function confirmed(store: ExtractionReceiptStore, token: AttemptToken, a = artifact) {
  const journalId = await store.prepareArtifact(token, a);
  await store.confirmArtifact(token, journalId, a);
  return journalId;
}
test("admission is replay-safe, immutable and has no transcript payload", async (t) => {
  const { dir, store } = await fixture(t);
  const r = await store.admit(identity, ["m1", "m2"]);
  assert.equal(r.version, 1);
  assert.equal(r.coverageComplete, false);
  assert.equal((await store.admit({ ...identity }, ["m2", "m1"])).receiptId, r.receiptId);
  await assert.rejects(store.admit(identity, ["m1"]), /membership mismatch/);
  await assert.rejects(store.admit({ ...identity, principal: "" }, ["m1"]), /principal/);
  await assert.rejects(store.admit(identity, []), /requires members/);
  const raw = JSON.parse(await readFile(path.join(dir, "state/extraction-receipts", `${r.receiptId}.json`), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["identity", "members", "receiptId", "version"]);
});
test("each identity axis isolates coverage including scope, source and chunk version", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
  await store.finish(a, { status: "empty_success", artifacts: [], emptyValidated: true });
  for (const axis of [
    "principal",
    "namespace",
    "sessionKey",
    "scopeHash",
    "sourceDigest",
    "messagesHash",
    "chunkVersion",
  ] as const) {
    const other = await store.admit({ ...identity, [axis]: `${identity[axis]}-other` }, ["m1"]);
    assert.notEqual(other.receiptId, r.receiptId);
    assert.equal(other.coverageComplete, false);
  }
});
test("disjoint attempts remain valid while overlapping generations are fenced", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1", "m2"]);
  const m1 = [{ receiptId: r.receiptId, memberId: "m1" }];
  const m2 = [{ receiptId: r.receiptId, memberId: "m2" }];
  const stale = await store.begin(m1);
  const separate = await store.begin(m2);
  const current = await store.begin(m1);
  await assert.rejects(store.assertCurrent(stale), /Stale/);
  await assert.rejects(store.prepareArtifact(stale, artifact), /Stale/);
  await assert.rejects(store.finish(stale, { status: "empty_success", artifacts: [], emptyValidated: true }), /Stale/);
  await store.assertCurrent(separate);
  await store.assertCurrent(current);
  await store.finish(current, { status: "empty_success", artifacts: [], emptyValidated: true });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, false);
  await store.finish(separate, { status: "empty_success", artifacts: [], emptyValidated: true });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, true);
});
test("durable outcome requires confirmed nonpending evidence, not a caller assertion", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
  await assert.rejects(store.finish(a, { status: "durable_extracted", artifacts: [] }), /confirmed evidence/);
  await assert.rejects(store.finish(a, { status: "durable_extracted", artifacts: [artifact] }), /not confirmed/);
  const id = await store.prepareArtifact(a, artifact);
  await assert.rejects(store.finish(a, { status: "durable_extracted", artifacts: [artifact] }), /confirmed evidence/);
  await store.confirmArtifact(a, id, artifact);
  await store.finish(a, { status: "durable_extracted", artifacts: [artifact] });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, true);
  await assert.rejects(store.begin(a.members), /already covered/);
});
test("restart preserves unconfirmed WAL and permits only explicit caller reconciliation", async (t) => {
  const { dir, store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const members = [{ receiptId: r.receiptId, memberId: "m1" }];
  const a = await store.begin(members);
  const j = await store.prepareArtifact(a, artifact);
  const restart = new ExtractionReceiptStore(dir);
  assert.equal((await restart.get(r.receiptId))?.journal[0].confirmed, false);
  assert.equal((await restart.get(r.receiptId))?.coverageComplete, false);
  const retry = await restart.begin(members);
  await assert.rejects(restart.confirmArtifact(a, j, artifact), /Stale/);
  await assert.rejects(
    restart.finish(retry, { status: "durable_extracted", artifacts: [artifact] }),
    /confirmed evidence/
  );
  await restart.confirmArtifact(retry, j, { ...artifact, disposition: "deduplicated" });
  await restart.finish(retry, {
    status: "durable_extracted",
    artifacts: [{ ...artifact, disposition: "deduplicated" }],
  });
  assert.equal((await new ExtractionReceiptStore(dir).get(r.receiptId))?.coverageComplete, true);
});
test("failed/deferred/retry preserve artifacts without coverage and pending review never covers", async (t) => {
  for (const status of ["failed", "deferred", "retry"] as const) {
    const { store } = await fixture(t);
    const r = await store.admit(identity, ["m1"]);
    const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
    const pending = { ...artifact, disposition: "pending_review" as const };
    await confirmed(store, a, pending);
    await assert.rejects(store.finish(a, { status: "durable_extracted", artifacts: [pending] }), /confirmed evidence/);
    await store.finish(a, { status, artifacts: [pending], reason: "persistence incomplete" });
    const result = await store.get(r.receiptId);
    assert.ok(result);
    assert.equal(result.coverageComplete, false);
    assert.deepEqual(result.artifacts, [pending]);
    assert.equal(result.status, status);
  }
});
test("empty success requires explicit validation and rejects any artifact/WAL", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
  await assert.rejects(store.finish(a, { status: "empty_success", artifacts: [] }), /Empty success/);
  await store.prepareArtifact(a, artifact);
  await assert.rejects(
    store.finish(a, { status: "empty_success", artifacts: [], emptyValidated: true }),
    /Empty success/
  );
});
test("mixed tenant attempts, foreign artifacts and unknown members fail closed", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const foreign = await store.admit({ ...identity, principal: "other" }, ["m1"]);
  await assert.rejects(
    store.begin([
      { receiptId: r.receiptId, memberId: "m1" },
      { receiptId: foreign.receiptId, memberId: "m1" },
    ]),
    /scope mismatch/
  );
  await assert.rejects(store.begin([{ receiptId: r.receiptId, memberId: "unknown" }]), /Unknown receipt member/);
  const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
  await assert.rejects(store.prepareArtifact(a, { ...artifact, namespace: "other" }), /scope mismatch/);
  assert.equal((await store.get(r.receiptId))?.journal.length, 0);
});
test("receipt identity corruption and symlinked roots are rejected", async (t) => {
  const { dir, store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const file = path.join(dir, "state/extraction-receipts", `${r.receiptId}.json`);
  const data = JSON.parse(await readFile(file, "utf8"));
  data.identity.principal = "other";
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(store.get(r.receiptId), /identity or schema mismatch/);
  const link = `${dir}-link`;
  t.after(() => rm(link, { force: true }));
  await symlink(dir, link);
  await assert.rejects(new ExtractionReceiptStore(link).admit(identity, ["m1"]), /symlinks/);
});
test("concurrent store instances serialize generations and recover after rejected operations", async (t) => {
  const { dir, store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const members = [{ receiptId: r.receiptId, memberId: "m1" }];
  const [a, b] = await Promise.all([store.begin(members), new ExtractionReceiptStore(dir).begin(members)]);
  await assert.rejects(store.assertCurrent(a), /Stale/);
  await store.assertCurrent(b);
  await store.finish(b, { status: "empty_success", artifacts: [], emptyValidated: true });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, true);
});
test("cross-receipt record or commit write failure exposes no partial coverage, including restart", async (t) => {
  for (const failAt of [2, 3]) {
    const { dir, store } = await fixture(t);
    const first = await store.admit(identity, ["m1"]);
    const second = await store.admit({ ...identity, sourceDigest: "source-b" }, ["m2"]);
    const a = await store.begin([
      { receiptId: first.receiptId, memberId: "m1" },
      { receiptId: second.receiptId, memberId: "m2" },
    ]);
    const writeTarget: object = store;
    // SAFETY: The class declares this private method with these arguments; this
    // test-only seam injects I/O failures and restores the original before reuse.
    const internals = writeTarget as {
      writeJSON: (file: string, data: ReceiptDiskPayload, refresh: () => Promise<boolean>) => Promise<void>;
    };
    const original = internals.writeJSON.bind(store);
    let writes = 0;
    internals.writeJSON = async (...args) => {
      if (++writes === failAt) throw new Error("injected disk failure");
      return original(...args);
    };
    await assert.rejects(
      store.finish(a, { status: "empty_success", artifacts: [], emptyValidated: true }),
      /injected disk failure/
    );
    internals.writeJSON = original;
    const restart = new ExtractionReceiptStore(dir);
    assert.equal((await restart.get(first.receiptId))?.coverageComplete, false);
    assert.equal((await restart.get(second.receiptId))?.coverageComplete, false);
    await restart.finish(a, { status: "empty_success", artifacts: [], emptyValidated: true });
    assert.equal((await restart.get(first.receiptId))?.coverageComplete, true);
    assert.equal((await restart.get(second.receiptId))?.coverageComplete, true);
  }
});
test("pending prewrite ids resolve to actual artifact ids while retaining provenance", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const a = await store.begin([{ receiptId: r.receiptId, memberId: "m1" }]);
  const proposed = { ...artifact, id: "pending:00000000-0000-0000-0000-000000000001" };
  const id = await store.prepareArtifact(a, proposed);
  await assert.rejects(store.confirmArtifact(a, id, { ...artifact, kind: "entity" }), /journal mismatch/);
  await store.confirmArtifact(a, id, artifact);
  const journal = (await store.get(r.receiptId))?.journal[0];
  assert.ok(journal);
  assert.equal(journal.proposedArtifact?.id, proposed.id);
  assert.equal(journal.artifact.id, artifact.id);
  await assert.rejects(store.confirmArtifact(a, id, { ...artifact, id: "different" }), /journal mismatch/);
  await store.finish(a, { status: "durable_extracted", artifacts: [artifact] });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, true);
});
test("prior failed references cannot silently become durable and review can be explicitly resolved", async (t) => {
  const { store } = await fixture(t);
  const r = await store.admit(identity, ["m1"]);
  const members = [{ receiptId: r.receiptId, memberId: "m1" }];
  let a = await store.begin(members);
  await store.finish(a, { status: "failed", artifacts: [{ ...artifact, id: "uncertain-write" }] });
  a = await store.begin(members);
  await confirmed(store, a);
  await assert.rejects(store.finish(a, { status: "durable_extracted", artifacts: [artifact] }), /not confirmed/);
  const ref = { ...artifact, id: "uncertain-write" };
  await confirmed(store, a, ref);
  await store.finish(a, { status: "durable_extracted", artifacts: [artifact, ref] });
  assert.equal((await store.get(r.receiptId))?.coverageComplete, true);
  const second = await store.admit({ ...identity, sourceDigest: "review-source" }, ["m1"]);
  const t2 = await store.begin([{ receiptId: second.receiptId, memberId: "m1" }]);
  const pending = { ...artifact, disposition: "pending_review" as const };
  const j = await confirmed(store, t2, pending);
  await store.finish(t2, { status: "deferred", artifacts: [pending] });
  const t3 = await store.begin(t2.members);
  await store.confirmArtifact(t3, j, artifact);
  await store.finish(t3, { status: "durable_extracted", artifacts: [artifact] });
  assert.deepEqual((await store.get(second.receiptId))?.artifacts, [artifact]);
});
