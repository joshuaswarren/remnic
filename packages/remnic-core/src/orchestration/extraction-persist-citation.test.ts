import assert from "node:assert/strict";
import test from "node:test";

import { applyInlineCitation, normalizeStoredHashSource } from "./extraction-persist-citation.js";

test("#3091 citation helpers no-op when inline attribution is off", () => {
  assert.equal(applyInlineCitation("hello", false, "[{ts}]", {}), "hello");
  assert.equal(normalizeStoredHashSource("hello", false, "[{ts}]"), "hello");
});
