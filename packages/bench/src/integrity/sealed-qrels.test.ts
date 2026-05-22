import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  computeSealHash,
  loadSealedQrels,
  parseSealedQrels,
  serializeSealedQrels,
  type SealedQrelsArtifact,
} from "./sealed-qrels.ts";
import { sealPayload } from "./hash-verification.ts";

function buildArtifact(
  benchmark: string,
  qrels: unknown,
  key: Buffer,
): SealedQrelsArtifact {
  const envelope = sealPayload(JSON.stringify(qrels), key);
  return {
    benchmark,
    version: 1,
    sealHash: computeSealHash(envelope),
    envelope,
  };
}

test("parseSealedQrels round-trips through serialize and unseals correctly", () => {
  const key = randomBytes(32);
  const qrels = { task1: ["answer-a"], task2: ["answer-b"] };
  const artifact = buildArtifact("canary-benchmark", qrels, key);

  const serialized = serializeSealedQrels(artifact);
  const handle = parseSealedQrels(serialized, {
    expectedBenchmarkId: "canary-benchmark",
    expectedSealHash: artifact.sealHash,
  });

  assert.equal(handle.benchmark, "canary-benchmark");
  assert.deepEqual(handle.unseal(key), qrels);
});

test("parseSealedQrels rejects tampered envelopes via sealHash mismatch", () => {
  const key = randomBytes(32);
  const artifact = buildArtifact("canary", { t: ["a"] }, key);
  const serialized = JSON.parse(serializeSealedQrels(artifact)) as SealedQrelsArtifact;
  // Modify the envelope ciphertext but keep the old sealHash.
  serialized.envelope = {
    ...serialized.envelope,
    ciphertext: Buffer.from("tampered-bytes").toString("base64"),
  };

  assert.throws(
    () => parseSealedQrels(JSON.stringify(serialized)),
    /sealHash does not match/,
  );
});

test("computeSealHash pins the sealed envelope, not stable plaintext identity", () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ task1: ["answer-a"], task2: ["answer-b"] });
  const first = sealPayload(plaintext, key);
  const second = sealPayload(plaintext, key);

  assert.notEqual(computeSealHash(first), computeSealHash(second));
  assert.equal(first.plaintextHash, second.plaintextHash);
});

test("parseSealedQrels rejects mismatched expectedSealHash", () => {
  const key = randomBytes(32);
  const artifact = buildArtifact("canary", { t: ["a"] }, key);

  assert.throws(
    () =>
      parseSealedQrels(serializeSealedQrels(artifact), {
        expectedSealHash: "f".repeat(64),
      }),
    /does not match the expected value/,
  );
});

test("parseSealedQrels rejects mismatched benchmark IDs", () => {
  const key = randomBytes(32);
  const artifact = buildArtifact("canary", { t: ["a"] }, key);

  assert.throws(
    () =>
      parseSealedQrels(serializeSealedQrels(artifact), {
        expectedBenchmarkId: "other-benchmark",
      }),
    /benchmark mismatch/,
  );
});

test("parseSealedQrels rejects malformed JSON", () => {
  assert.throws(() => parseSealedQrels("not-json"), /not valid JSON/);
});

test("parseSealedQrels rejects payloads failing schema validation", () => {
  assert.throws(
    () => parseSealedQrels(JSON.stringify({ benchmark: "x", version: 99 })),
    /schema validation/,
  );
});

test("loadSealedQrels reads from disk", async () => {
  const key = randomBytes(32);
  const artifact = buildArtifact("canary", { t: ["a"] }, key);
  const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-sealed-qrels-"));
  const filePath = path.join(dir, "qrels.json");
  await writeFile(filePath, serializeSealedQrels(artifact));

  const handle = await loadSealedQrels(filePath, {
    expectedBenchmarkId: "canary",
    expectedSealHash: artifact.sealHash,
  });
  assert.deepEqual(handle.unseal(key), { t: ["a"] });
});

test("handle.unseal fails on wrong key", () => {
  const key = randomBytes(32);
  const wrong = randomBytes(32);
  const artifact = buildArtifact("canary", { t: ["a"] }, key);
  const handle = parseSealedQrels(serializeSealedQrels(artifact));
  assert.throws(() => handle.unseal(wrong));
});
