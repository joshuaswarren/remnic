import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

test("parseConfig: recallStateViews defaults false and honors exact disable values", () => {
  const base = { memoryDir: "/tmp/remnic-sv-config-test" };
  assert.equal(parseConfig(base).recallStateViews, false, "absent → false");
  assert.equal(parseConfig({ ...base, recallStateViews: false }).recallStateViews, false);
  assert.equal(parseConfig({ ...base, recallStateViews: 0 }).recallStateViews, false, "0 disables");
  assert.equal(parseConfig({ ...base, recallStateViews: "false" }).recallStateViews, false, '"false" disables');
  assert.equal(parseConfig({ ...base, recallStateViews: "0" }).recallStateViews, false, '"0" disables');
  assert.equal(parseConfig({ ...base, recallStateViews: true }).recallStateViews, true);
  assert.equal(parseConfig({ ...base, recallStateViews: 1 }).recallStateViews, true);
  assert.equal(parseConfig({ ...base, recallStateViews: "true" }).recallStateViews, true, "CLI string 'true' enables");
});
