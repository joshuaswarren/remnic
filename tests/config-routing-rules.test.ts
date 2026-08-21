import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets routing rules defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.routingRulesEnabled, false);
  assert.equal(cfg.routingRulesStateFile, "state/routing-rules.json");
});

test("parseConfig supports explicit routing rules settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    routingRulesEnabled: true,
    routingRulesStateFile: "state/custom-routes.json",
  });

  assert.equal(cfg.routingRulesEnabled, true);
  assert.equal(cfg.routingRulesStateFile, "state/custom-routes.json");
});

test("parseConfig falls back when routing state file is blank", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    routingRulesEnabled: true,
    routingRulesStateFile: "   ",
  });

  assert.equal(cfg.routingRulesEnabled, true);
  assert.equal(cfg.routingRulesStateFile, "state/routing-rules.json");
});
