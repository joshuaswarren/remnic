import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EXPECTED_STATUS_SEQUENCE,
  SupportPassportReceiptSchema,
  computeFixtureHash,
  computeResponseHashChain,
} from "./receipt-schema.mjs";
import { resolveReceiptPath, validateReceiptConsistency } from "./verify-receipt.mjs";

const fixturesDir = path.resolve(import.meta.dirname, "../../fixtures/support-passport");

async function fixtureHash() {
  const source = JSON.parse(await readFile(path.join(fixturesDir, "source-memories.json"), "utf8"));
  const expected = JSON.parse(await readFile(path.join(fixturesDir, "expected-public-cards.json"), "utf8"));
  return computeFixtureHash(source, expected);
}

function modelCall(route = "direct") {
  return {
    route,
    transport: route === "direct" ? "openai-responses" : "local-compatible",
    outputSchemaVersion: 1,
    occurredAt: "2026-08-11T12:00:00.000Z",
    latencyMs: 25,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}

async function validReceipt() {
  const responses = {
    draft: { status: 200, bodySha256: "1".repeat(64) },
    edit: { status: 200, bodySha256: "2".repeat(64) },
    approve: { status: 200, bodySha256: "3".repeat(64) },
    grant: { status: 200, bodySha256: "4".repeat(64) },
    helperRead: { status: 200, bodySha256: "5".repeat(64) },
    helperAsk: { status: 200, bodySha256: "6".repeat(64) },
    revoke: { status: 200, bodySha256: "7".repeat(64) },
    deniedRead: { status: 410, bodySha256: "8".repeat(64) },
  };
  return {
    schemaVersion: 1,
    validationScope: "self_consistency_only",
    fixtureHash: await fixtureHash(),
    commitSha: "a".repeat(40),
    generatedAt: "2026-08-11T12:01:00.000Z",
    cardRevisions: {
      drafted: ["b".repeat(64)],
      edited: { cardId: "card-one", revision: "c".repeat(64) },
      approved: [{ cardId: "card-one", revision: "d".repeat(64) }],
    },
    grant: { grantId: "grant-one", expiresAt: "2026-08-11T14:00:00.000Z" },
    modelCalls: { draft: modelCall(), answer: modelCall() },
    revokedAt: "2026-08-11T12:00:30.000Z",
    httpStatusSequence: EXPECTED_STATUS_SEQUENCE,
    responses,
    responseHashChain: computeResponseHashChain(responses),
    finalResult: "passed",
  };
}

test("the receipt validator accepts a strict self-consistency record", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "support-passport-receipt-test-"));
  try {
    const receiptPath = path.join(directory, "receipt.json");
    await writeFile(receiptPath, JSON.stringify(await validReceipt()), "utf8");
    const receipt = await validateReceiptConsistency({ receiptPath });
    assert.equal(receipt.finalResult, "passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the receipt validator expands a leading tilde", () => {
  assert.equal(resolveReceiptPath("~/receipt.json"), path.join(os.homedir(), "receipt.json"));
});

test("the receipt validator rejects response-hash and fixture drift", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "support-passport-receipt-test-"));
  try {
    const receiptPath = path.join(directory, "receipt.json");
    const receipt = await validReceipt();
    receipt.responses.deniedRead.bodySha256 = "9".repeat(64);
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await assert.rejects(() => validateReceiptConsistency({ receiptPath }), /response hash chain/);

    receipt.responseHashChain = computeResponseHashChain(receipt.responses);
    receipt.fixtureHash = "0".repeat(64);
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await assert.rejects(() => validateReceiptConsistency({ receiptPath }), /fixture hash/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the receipt schema rejects private or unplanned fields", async () => {
  const receipt = await validReceipt();
  assert.equal(SupportPassportReceiptSchema.safeParse({ ...receipt, prompt: "private" }).success, false);
  assert.equal(
    SupportPassportReceiptSchema.safeParse({
      ...receipt,
      modelCalls: { ...receipt.modelCalls, draft: { ...receipt.modelCalls.draft, model: "/private/model" } },
    }).success,
    false
  );
  assert.equal(
    SupportPassportReceiptSchema.safeParse({
      ...receipt,
      modelCalls: { ...receipt.modelCalls, draft: { ...receipt.modelCalls.draft, modelOutput: "private" } },
    }).success,
    false
  );
});
