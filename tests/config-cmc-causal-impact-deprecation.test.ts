import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "@remnic/core/config";
import { initLogger, type LoggerBackend } from "@remnic/core/logger";

function captureWarnings(): string[] {
  const warnings: string[] = [];
  const backend: LoggerBackend = {
    info() {},
    warn(msg: string) {
      warnings.push(msg);
    },
    error() {},
    debug() {},
  };
  initLogger(backend, false);
  return warnings;
}

test("setting cmcLifecycleCausalImpactWeight still loads and warns that it has no effect (#3667)", () => {
  const warnings = captureWarnings();
  const cfg = parseConfig({ cmcLifecycleCausalImpactWeight: 0.2 });
  assert.equal(cfg.cmcLifecycleCausalImpactWeight, 0.2, "an old config that sets the key keeps loading");
  const deprecations = warnings.filter((msg) => msg.includes("cmcLifecycleCausalImpactWeight"));
  assert.equal(deprecations.length, 1);
  assert.match(deprecations[0] ?? "", /deprecated/);
  assert.match(deprecations[0] ?? "", /no effect/);
});

test("leaving cmcLifecycleCausalImpactWeight unset logs no deprecation warning", () => {
  const warnings = captureWarnings();
  parseConfig({});
  assert.equal(warnings.filter((msg) => msg.includes("cmcLifecycleCausalImpactWeight")).length, 0);
});
