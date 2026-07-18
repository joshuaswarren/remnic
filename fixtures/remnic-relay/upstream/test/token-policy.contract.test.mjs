import assert from "node:assert/strict";
import test from "node:test";

import { selectCheckoutToken } from "../src/reference-token-policy.mjs";

test("a valid checkout-session token survives an ordinary retry", () => {
  let mintCount = 0;
  const mintToken = () => `checkout-${++mintCount}`;
  const first = selectCheckoutToken({ currentToken: null, tokenExpired: false, mintToken });
  const retry = selectCheckoutToken({ currentToken: first, tokenExpired: false, mintToken });

  assert.equal(retry, first);
  assert.equal(mintCount, 1);
});

test("expiry causes exactly one replacement mint", () => {
  let mintCount = 0;
  const mintToken = () => `checkout-${++mintCount}`;
  const replacement = selectCheckoutToken({
    currentToken: "checkout-expired",
    tokenExpired: true,
    mintToken,
  });
  const retry = selectCheckoutToken({ currentToken: replacement, tokenExpired: false, mintToken });

  assert.equal(retry, replacement);
  assert.equal(mintCount, 1);
});
