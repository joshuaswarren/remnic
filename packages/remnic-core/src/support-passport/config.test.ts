import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../config.js";

test("support passport config defaults off and accepts an explicit opt-in", () => {
  assert.deepEqual(parseConfig({}).supportPassport, { enabled: false });
  assert.deepEqual(parseConfig({ supportPassport: { enabled: true } }).supportPassport, { enabled: true });
});

test("support passport config rejects malformed and unknown fields", () => {
  assert.throws(() => parseConfig({ supportPassport: true }), /supportPassport/);
  assert.throws(() => parseConfig({ supportPassport: { enabled: "true" } }), /supportPassport/);
  assert.throws(() => parseConfig({ supportPassport: { enabled: true, extra: true } }), /supportPassport/);
});
