import assert from "node:assert/strict";
import { test } from "node:test";

import { describeErrorForOperator, WearablesInputError } from "./errors.js";

test("scrubs filesystem paths down to basenames", () => {
  const detail = describeErrorForOperator(
    new Error("ENOENT: no such file or directory, open '/home/someone/.openclaw/workspace/memory/local/state/wearables/sync.json'"),
  );
  assert.ok(!detail.includes("/home/someone"), detail);
  assert.ok(detail.includes("…/sync.json"), detail);
});

test("caps detail length", () => {
  const detail = describeErrorForOperator(new Error("x".repeat(500)));
  assert.ok(detail.length <= 201);
  assert.ok(detail.endsWith("…"));
});

test("non-Error throws yield a generic marker", () => {
  assert.equal(describeErrorForOperator("boom"), "unexpected non-Error failure");
  assert.equal(describeErrorForOperator(undefined), "unexpected non-Error failure");
});

test("plain messages pass through", () => {
  assert.equal(
    describeErrorForOperator(new WearablesInputError("invalid days '0'")),
    "invalid days '0'",
  );
});
