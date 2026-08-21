import assert from "node:assert/strict";
import { test } from "node:test";

import { describeErrorForOperator, WearablesInputError } from "./errors.js";

test("foreign errors expose only the error class and errno code", () => {
  const pathy = new Error(
    "ENOENT: no such file or directory, open '/home/someone/.openclaw/workspace/memory/local/state/wearables/sync.json'",
  );
  (pathy as NodeJS.ErrnoException).code = "ENOENT";
  assert.equal(describeErrorForOperator(pathy), "Error (ENOENT)");

  class ProviderError extends Error {
    constructor() {
      super("secret-bearing message with /paths/and/such");
      this.name = "ProviderError";
    }
  }
  assert.equal(describeErrorForOperator(new ProviderError()), "ProviderError");
});

test("non-Error throws yield a generic marker", () => {
  assert.equal(describeErrorForOperator("boom"), "unexpected non-Error failure");
  assert.equal(describeErrorForOperator(undefined), "unexpected non-Error failure");
});

test("wearables' own input errors pass through verbatim", () => {
  assert.equal(
    describeErrorForOperator(new WearablesInputError("invalid days '0'")),
    "invalid days '0'",
  );
});
