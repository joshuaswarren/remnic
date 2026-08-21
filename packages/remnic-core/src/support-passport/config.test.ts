import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../config.js";

test("support passport config defaults off and accepts an explicit opt-in", () => {
  assert.deepEqual(parseConfig({}).supportPassport, { enabled: false, trustedProxyAddresses: [] });
  assert.deepEqual(parseConfig({ supportPassport: { enabled: true } }).supportPassport, {
    enabled: true,
    trustedProxyAddresses: [],
  });
  assert.deepEqual(
    parseConfig({
      supportPassport: { enabled: "true", trustedProxyAddresses: ["127.0.0.1", "::1"] },
    }).supportPassport,
    { enabled: true, trustedProxyAddresses: ["127.0.0.1", "::1"] }
  );
  for (const enabled of ["false", "0", "no", "off"]) {
    assert.deepEqual(parseConfig({ supportPassport: { enabled } }).supportPassport, {
      enabled: false,
      trustedProxyAddresses: [],
    });
  }
});

test("support passport config rejects malformed and unknown fields", () => {
  assert.throws(() => parseConfig({ supportPassport: true }), /supportPassport/);
  assert.throws(() => parseConfig({ supportPassport: { enabled: "maybe" } }), /supportPassport/);
  assert.throws(
    () => parseConfig({ supportPassport: { trustedProxyAddresses: ["not-an-address"] } }),
    /supportPassport/
  );
  assert.throws(() => parseConfig({ supportPassport: { enabled: true, extra: true } }), /supportPassport/);
});
