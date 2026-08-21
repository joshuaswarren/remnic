import test from "node:test";
import assert from "node:assert/strict";
import {
  assertIntegrityMetaPresent,
  integrityMetaIsComplete,
} from "./types.ts";
import { hashString } from "./hash-verification.ts";

test("integrityMetaIsComplete accepts fully-populated meta blocks", () => {
  assert.ok(
    integrityMetaIsComplete({
      splitType: "holdout",
      qrelsSealedHash: hashString("q"),
      judgePromptHash: hashString("j"),
      datasetHash: hashString("d"),
    }),
  );
  assert.ok(
    integrityMetaIsComplete({
      splitType: "public",
      qrelsSealedHash: hashString("q"),
      judgePromptHash: hashString("j"),
      datasetHash: hashString("d"),
      canaryScore: 0.03,
    }),
  );
});

test("integrityMetaIsComplete rejects malformed blocks", () => {
  assert.ok(!integrityMetaIsComplete(null));
  assert.ok(!integrityMetaIsComplete({ splitType: "other" }));
  assert.ok(
    !integrityMetaIsComplete({
      splitType: "holdout",
      qrelsSealedHash: "too-short",
      judgePromptHash: hashString("j"),
      datasetHash: hashString("d"),
    }),
  );
});

test("assertIntegrityMetaPresent lists every missing field", () => {
  try {
    assertIntegrityMetaPresent({ splitType: "nope" });
    assert.fail("expected throw");
  } catch (err) {
    assert.match((err as Error).message, /splitType/);
    assert.match((err as Error).message, /qrelsSealedHash/);
    assert.match((err as Error).message, /judgePromptHash/);
    assert.match((err as Error).message, /datasetHash/);
  }
});

test("assertIntegrityMetaPresent rejects non-finite canary scores", () => {
  assert.throws(() =>
    assertIntegrityMetaPresent({
      splitType: "public",
      qrelsSealedHash: hashString("q"),
      judgePromptHash: hashString("j"),
      datasetHash: hashString("d"),
      canaryScore: Number.POSITIVE_INFINITY,
    }),
  );
});
