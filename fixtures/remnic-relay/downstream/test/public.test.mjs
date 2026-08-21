import assert from "node:assert/strict";
import test from "node:test";

import { selectCheckoutToken } from "../src/token-policy.mjs";

test("the first checkout request obtains a token", () => {
  let mintCount = 0;
  const token = selectCheckoutToken({
    currentToken: null,
    tokenExpired: false,
    mintToken: () => `checkout-${++mintCount}`,
  });

  assert.equal(token, "checkout-1");
  assert.equal(mintCount, 1);
});
