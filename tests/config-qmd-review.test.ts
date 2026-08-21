import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig keeps QMD 2.0 review flags disabled by default", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.qmdIntentHintsEnabled, false);
  assert.equal(cfg.qmdExplainEnabled, false);
});

test("parseConfig enables QMD 2.0 review flags when configured", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    qmdIntentHintsEnabled: true,
    qmdExplainEnabled: true,
  });
  assert.equal(cfg.qmdIntentHintsEnabled, true);
  assert.equal(cfg.qmdExplainEnabled, true);
});
