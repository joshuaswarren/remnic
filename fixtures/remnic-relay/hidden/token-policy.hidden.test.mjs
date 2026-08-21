import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspace = process.env.REMNIC_RELAY_WORKSPACE;
if (!workspace || !path.isAbsolute(workspace)) {
  throw new Error("REMNIC_RELAY_WORKSPACE must name an absolute fixture workspace");
}

const implementationUrl = pathToFileURL(path.join(workspace, "src", "token-policy.mjs"));
implementationUrl.searchParams.set("run", process.env.REMNIC_RELAY_TEST_RUN ?? "default");
const { selectCheckoutToken } = await import(implementationUrl.href);

test("ordinary retries reuse the checkout-session token", () => {
  let mintCount = 0;
  const mintToken = () => `checkout-${++mintCount}`;
  const first = selectCheckoutToken({ currentToken: null, tokenExpired: false, mintToken });
  const retry = selectCheckoutToken({ currentToken: first, tokenExpired: false, mintToken });

  assert.equal(retry, first, "retry minted a second token instead of reusing the session token");
  assert.equal(mintCount, 1, "ordinary retry must not mint again");
});

test("expiry mints one replacement that later retries reuse", () => {
  let mintCount = 0;
  const mintToken = () => `replacement-${++mintCount}`;
  const replacement = selectCheckoutToken({
    currentToken: "checkout-expired",
    tokenExpired: true,
    mintToken,
  });
  const retry = selectCheckoutToken({ currentToken: replacement, tokenExpired: false, mintToken });

  assert.equal(retry, replacement);
  assert.equal(mintCount, 1, "expiry should cause exactly one replacement mint");
});
