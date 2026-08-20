import assert from "node:assert/strict";
import test from "node:test";

import { buildAnalysisRunMetadata } from "./analysis-metadata.js";

const valid = {
  provider: "ollama",
  model: "llama",
  promptVersion: "1",
  observationCount: 40,
};

test("valid metadata round-trips exactly", () => {
  assert.deepEqual(buildAnalysisRunMetadata(valid), valid);
});

test("result has exactly the four documented keys", () => {
  assert.deepEqual(Object.keys(buildAnalysisRunMetadata(valid)).sort(), [
    "model",
    "observationCount",
    "promptVersion",
    "provider",
  ]);
});

test("blank or whitespace-padded provider/model/promptVersion throws", () => {
  for (const field of ["provider", "model", "promptVersion"] as const) {
    for (const bad of ["", "   ", " ollama ", "\tollama", "ollama\t"]) {
      assert.throws(
        () => buildAnalysisRunMetadata({ ...valid, [field]: bad }),
        (error: unknown) => error instanceof RangeError && error.message.includes(field),
        `${field}=${JSON.stringify(bad)} must throw`,
      );
    }
  }
});

test("non-string provider throws RangeError naming the field", () => {
  assert.throws(
    () => buildAnalysisRunMetadata({ ...valid, provider: 42 as unknown as string }),
    (error: unknown) => error instanceof RangeError && error.message.includes("provider"),
  );
});

test("embedded newline in provider/model/promptVersion throws /newline/", () => {
  for (const field of ["provider", "model", "promptVersion"] as const) {
    for (const bad of ["two\nlines", "cr\rreturn", "end\n", "\rstart"]) {
      assert.throws(
        () => buildAnalysisRunMetadata({ ...valid, [field]: bad }),
        /newline/,
        `${field}=${JSON.stringify(bad)} must match /newline/`,
      );
    }
  }
});

test("201-character value throws /too long/; 200 is accepted", () => {
  const twoHundred = "a".repeat(200);
  const twoHundredOne = "a".repeat(201);
  for (const field of ["provider", "model", "promptVersion"] as const) {
    assert.throws(
      () => buildAnalysisRunMetadata({ ...valid, [field]: twoHundredOne }),
      /too long/,
      `${field} of 201 chars must match /too long/`,
    );
  }
  assert.equal(buildAnalysisRunMetadata({ ...valid, provider: twoHundred }).provider, twoHundred);
  assert.equal(buildAnalysisRunMetadata({ ...valid, model: twoHundred }).model, twoHundred);
  assert.equal(
    buildAnalysisRunMetadata({ ...valid, promptVersion: twoHundred }).promptVersion,
    twoHundred,
  );
});

test("observationCount 0 is accepted; invalid counts throw /observationCount/", () => {
  assert.equal(buildAnalysisRunMetadata({ ...valid, observationCount: 0 }).observationCount, 0);
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(
      () => buildAnalysisRunMetadata({ ...valid, observationCount: bad }),
      /observationCount/,
      `observationCount=${bad} must throw`,
    );
  }
});

test("input object is not mutated", () => {
  const input = { ...valid };
  buildAnalysisRunMetadata(input);
  assert.deepEqual(input, valid);
});
