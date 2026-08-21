import assert from "node:assert/strict";
import test from "node:test";

import { injectStateViewLines } from "./recall-state-view-inject.js";

const TEXT = "Was a baker";
const DATE = "2026-03-01";
const SUCCESSOR = "new-job";

const historical = {
  id: "old-job",
  text: TEXT,
  stateLabel: "historical" as const,
  supersededAt: DATE,
  supersededBy: SUCCESSOR,
};

test("enabled false keeps original text per item", () => {
  assert.deepEqual(injectStateViewLines([historical]), [TEXT]);
  assert.deepEqual(injectStateViewLines([historical], { enabled: false }), [TEXT]);
});

test("empty list stays empty", () => {
  assert.deepEqual(injectStateViewLines([]), []);
  assert.deepEqual(injectStateViewLines([], { enabled: true }), []);
});

test("enabled prefix maps historical text", () => {
  assert.deepEqual(injectStateViewLines([historical], { enabled: true }), [
    `[superseded ${DATE} by ${SUCCESSOR}] ${TEXT}`,
  ]);
});
