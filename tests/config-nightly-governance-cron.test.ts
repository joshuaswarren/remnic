import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig defaults nightly governance cron auto-register to disabled", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.nightlyGovernanceCronAutoRegister, false);
});

test("parseConfig supports explicitly enabling nightly governance cron auto-register", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    nightlyGovernanceCronAutoRegister: true,
  });
  assert.equal(cfg.nightlyGovernanceCronAutoRegister, true);
});
