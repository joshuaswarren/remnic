import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";

test("parseConfig sets identity continuity defaults", () => {
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.identityContinuityEnabled, false);
  assert.equal(cfg.identityInjectionMode, "recovery_only");
  assert.equal(cfg.identityMaxInjectChars, 1200);
  assert.equal(cfg.continuityIncidentLoggingEnabled, false);
  assert.equal(cfg.continuityAuditEnabled, false);
});

test("parseConfig enables incident logging by default when identity continuity is enabled", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    identityContinuityEnabled: true,
  });
  assert.equal(cfg.identityContinuityEnabled, true);
  assert.equal(cfg.continuityIncidentLoggingEnabled, true);
});

test("parseConfig supports explicit identity continuity settings and preserves zero limit", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    identityContinuityEnabled: true,
    identityInjectionMode: "full",
    identityMaxInjectChars: 0,
    continuityIncidentLoggingEnabled: false,
    continuityAuditEnabled: true,
  });
  assert.equal(cfg.identityContinuityEnabled, true);
  assert.equal(cfg.identityInjectionMode, "full");
  assert.equal(cfg.identityMaxInjectChars, 0);
  assert.equal(cfg.continuityIncidentLoggingEnabled, false);
  assert.equal(cfg.continuityAuditEnabled, true);
});

test("parseConfig clamps invalid identity continuity settings", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    identityInjectionMode: "invalid",
    identityMaxInjectChars: -77.5,
  });
  assert.equal(cfg.identityInjectionMode, "recovery_only");
  assert.equal(cfg.identityMaxInjectChars, 0);
});
