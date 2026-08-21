import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets qmdUpdateMinIntervalMs default", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.qmdUpdateMinIntervalMs, 15 * 60_000);
});

test("parseConfig preserves explicit qmdUpdateMinIntervalMs including zero", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    qmdUpdateMinIntervalMs: 0,
  });
  assert.equal(cfg.qmdUpdateMinIntervalMs, 0);
});
