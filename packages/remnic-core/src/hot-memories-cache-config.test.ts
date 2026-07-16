import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

test("hotMemoriesCacheEnabled defaults on and preserves boolean-like opt-outs", () => {
  assert.equal(parseConfig({}).hotMemoriesCacheEnabled, true);
  for (const value of [false, 0, "false", "0", "no", "off"] as const) {
    assert.equal(
      parseConfig({ hotMemoriesCacheEnabled: value }).hotMemoriesCacheEnabled,
      false,
      `expected ${JSON.stringify(value)} to disable the cache`,
    );
  }
});
