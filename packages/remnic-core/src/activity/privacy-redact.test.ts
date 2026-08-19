import assert from "node:assert/strict";
import test from "node:test";

import { redactActivityFields } from "./privacy-redact.js";

test("drops listed keys and ignores unknown keys", () => {
  const item = { id: "a", title: "kept", secret: "drop-me" };
  const redacted = redactActivityFields(item, {
    dropKeys: ["secret", "missing"],
  });
  assert.deepEqual(redacted, { id: "a", title: "kept" });
});

test("does not mutate the input item", () => {
  const item = { id: "a", secret: "drop-me" };
  redactActivityFields(item, { dropKeys: ["secret"] });
  assert.deepEqual(item, { id: "a", secret: "drop-me" });
});

test("empty dropKeys returns a shallow copy", () => {
  const item = { id: "a", title: "kept" };
  const redacted = redactActivityFields(item, { dropKeys: [] });
  assert.deepEqual(redacted, item);
  assert.notEqual(redacted, item);
});
