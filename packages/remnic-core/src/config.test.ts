import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";

/**
 * Run `body` with XDG_CONFIG_HOME pointing at a throwaway dir so the
 * sticky-legacy `emitLegacyTools` default (#1550) never reads the real
 * machine state. `withLegacyEntry` seeds one persisted connector file.
 */
function withIsolatedConnectorsDir<T>(
  withLegacyEntry: boolean,
  body: () => T,
): T {
  const prev = process.env.XDG_CONFIG_HOME;
  const root = mkdtempSync(path.join(tmpdir(), "remnic-config-test-"));
  process.env.XDG_CONFIG_HOME = root;
  try {
    if (withLegacyEntry) {
      const dir = path.join(root, "engram", ".engram-connectors", "connectors");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "codex-cli.json"), "{}\n");
    }
    return body();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
}
test("parseConfig memory-poisoning hardening defaults and validation (#1955)", () => {
  const previousOrigin = process.env.REMNIC_ORIGIN_AUTHORITY_ENABLED;
  const previousInjection = process.env.REMNIC_INJECTION_SCREEN_ENABLED;
  const previousOrigins = process.env.REMNIC_UNTRUSTED_ORIGINS;
  const previousMode = process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
  delete process.env.REMNIC_ORIGIN_AUTHORITY_ENABLED;
  delete process.env.REMNIC_INJECTION_SCREEN_ENABLED;
  delete process.env.REMNIC_UNTRUSTED_ORIGINS;
  delete process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
  try {
    const defaults = parseConfig({});
    assert.equal(defaults.memoryInjectionDefenseMode, "custom");
    assert.equal(defaults.originAuthorityEnabled, false);
    assert.equal(defaults.injectionScreenEnabled, true);
    assert.equal(defaults.injectionScreenProfile, "default");

    for (const [mode, originAuthorityEnabled, injectionScreenEnabled] of [
      ["off", false, false],
      ["fencing", true, false],
      ["quarantine", false, true],
      ["layered", true, true],
    ] as const) {
      const resolved = parseConfig({ memoryInjectionDefenseMode: mode });
      assert.equal(resolved.memoryInjectionDefenseMode, mode);
      assert.equal(resolved.originAuthorityEnabled, originAuthorityEnabled);
      assert.equal(resolved.injectionScreenEnabled, injectionScreenEnabled);
      assert.equal(resolved.injectionScreenProfile, "hardened");
      assert.deepEqual(
        resolved.untrustedOrigins,
        ["user", "tool_output", "connector:*", "import:*", "unknown"],
      );
    }
    const customizedMode = parseConfig({
      memoryInjectionDefenseMode: "fencing",
      untrustedOrigins: ["tool_output"],
    });
    assert.deepEqual(customizedMode.untrustedOrigins, ["tool_output"]);

    const configured = parseConfig({
      originAuthorityEnabled: "true",
      injectionScreenEnabled: "off",
      untrustedOrigins: [" connector:calendar ", "unknown", ""],
    });
    assert.equal(configured.originAuthorityEnabled, true);
    assert.equal(configured.injectionScreenEnabled, false);
    assert.deepEqual(configured.untrustedOrigins, ["connector:calendar", "unknown"]);

    process.env.REMNIC_ORIGIN_AUTHORITY_ENABLED = "yes";
    process.env.REMNIC_INJECTION_SCREEN_ENABLED = "0";
    process.env.REMNIC_UNTRUSTED_ORIGINS = "connector:calendar, import:legacy, unknown";
    const fromEnv = parseConfig({});
    assert.equal(fromEnv.originAuthorityEnabled, true);
    assert.equal(fromEnv.injectionScreenEnabled, false);
    assert.deepEqual(fromEnv.untrustedOrigins, ["connector:calendar", "import:legacy", "unknown"]);
    const envWithSchemaDefaults = parseConfig(
      {
        originAuthorityEnabled: false,
        injectionScreenEnabled: true,
        untrustedOrigins: ["tool_output", "import:*", "unknown"],
      },
      {},
    );
    assert.equal(envWithSchemaDefaults.originAuthorityEnabled, true);
    assert.equal(envWithSchemaDefaults.injectionScreenEnabled, false);
    assert.deepEqual(
      envWithSchemaDefaults.untrustedOrigins,
      ["connector:calendar", "import:legacy", "unknown"],
    );

    assert.throws(
      () => parseConfig({ originAuthorityEnabled: "maybe" }),
      /originAuthorityEnabled must be a boolean-like value/,
    );
    assert.throws(
      () => parseConfig({ untrustedOrigins: "unknown" }),
      /untrustedOrigins must be an array of strings/,
    );
    assert.throws(
      () => parseConfig({ memoryInjectionDefenseMode: "automatic" }),
      /memoryInjectionDefenseMode must be/,
    );
  } finally {
    if (previousOrigin === undefined) delete process.env.REMNIC_ORIGIN_AUTHORITY_ENABLED;
    else process.env.REMNIC_ORIGIN_AUTHORITY_ENABLED = previousOrigin;
    if (previousInjection === undefined) delete process.env.REMNIC_INJECTION_SCREEN_ENABLED;
    else process.env.REMNIC_INJECTION_SCREEN_ENABLED = previousInjection;
    if (previousOrigins === undefined) delete process.env.REMNIC_UNTRUSTED_ORIGINS;
    else process.env.REMNIC_UNTRUSTED_ORIGINS = previousOrigins;
    if (previousMode === undefined) delete process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
    else process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE = previousMode;
  }
});

test("parseConfig emitLegacyTools sticky-legacy default (issue #1550)", () => {
  // Fresh install (no legacy connector entries): canonical-only surface.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(parseConfig({}).emitLegacyTools, false, "fresh install defaults false");
    assert.equal(parseConfig({ emitLegacyTools: null }).emitLegacyTools, false);
  });
  // Existing install with a persisted legacy connector entry: aliases stay on.
  withIsolatedConnectorsDir(true, () => {
    assert.equal(parseConfig({}).emitLegacyTools, true, "legacy connector entry keeps aliases");
    // Explicit opt-out still wins over the sticky evidence.
    assert.equal(parseConfig({ emitLegacyTools: false }).emitLegacyTools, false);
    assert.equal(parseConfig({ emitLegacyTools: "false" }).emitLegacyTools, false);
  });
});

test("parseConfig emitLegacyTools raw-vs-effective: schema default does not block sticky legacy (#1550, PR #1593 review)", () => {
  // Cursor Bugbot + chatgpt-codex-connector both flagged the same class: the
  // OpenClaw SDK materializes JSON-schema defaults into `api.pluginConfig`
  // BEFORE `parseConfig` runs, so a fresh install would arrive with
  // `emitLegacyTools: false` already populated even though the operator never
  // wrote the key. The original resolver treated any present value as
  // operator-set, which short-circuited the sticky-legacy fallback to
  // `hasLegacyConnectorEntries()` and broke upgrades with legacy connector
  // entries on disk. Fix: parseConfig now takes an optional `rawOperatorConfig`
  // argument (sourced from `loadPluginConfigFromFile`, the pre-defaults
  // operator file). Resolvers check `rawOperatorConfig` first — if the key is
  // absent there, the present value is treated as a schema default and the
  // env / sticky-legacy fallback chain runs.
  withIsolatedConnectorsDir(false, () => {
    // Fresh install + schema-default false in the merged config: sticky
    // legacy path should still run and resolve to false.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "fresh install with schema-default false still resolves false",
    );
    // Explicit operator opt-out (rawOperatorConfig has the key): false wins.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, { emitLegacyTools: false })
        .emitLegacyTools,
      false,
      "explicit operator opt-out via file is honored",
    );
    // When raw author wrote a real value but the merged configValue
    // disagrees, configValue wins (matches the runtime-over-file spread in
    // src/index.ts — chatgpt-codex-connector P2, PR #1593 round 4).
    // coerceBooleanLikeOrThrow normalizes string "false" to boolean false.
    assert.equal(
      parseConfig({ emitLegacyTools: "false" }, { emitLegacyTools: "true" })
        .emitLegacyTools,
      false,
      "merged value wins over raw value (runtime-over-file precedence)",
    );
  });
  // Upgraded install with legacy connector JSON on disk: schema-default
  // `false` in merged config MUST NOT mask the sticky-legacy fallback. This
  // is the exact Cursor Bugbot scenario.
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      true,
      "upgraded install with legacy connector JSON keeps aliases on",
    );
    // Raw operator opt-out still wins over the sticky evidence.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, { emitLegacyTools: false })
        .emitLegacyTools,
      false,
      "raw operator opt-out overrides sticky-legacy",
    );
    // Raw operator opt-IN also wins.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "raw merged true is operator-set even with empty raw",
    );
  });
});

test("parseConfig namespaceCatalogEnabled raw-vs-effective: schema-default hardening (#1550 class hardening)", () => {
  // Same-class hardening as emitLegacyTools: if a future schema revision flips
  // namespaceCatalogEnabled's default to `false`, the resolver must still let
  // the sticky / absent chain run unless the operator wrote the key. Today
  // the schema default is `true`, so the bug doesn't manifest — but the helper
  // now has the raw-vs-effective split, and this test pins the contract so a
  // future schema flip can't reintroduce the bug class silently.
  //
  // Logic: when raw is missing the key, compare merged to the schema default
  // (true). If merged equals the schema default, it's the materialized
  // schema value — fall through to default. If merged differs (i.e. merged
  // is `false`), it's runtime operator intent — honor it. Symmetric to
  // resolveEmitLegacyTools, with the schema default inverted.
  // Absent from both → schema default true (sticky chain returns true).
  assert.equal(
    parseConfig({}, {}).namespaceCatalogEnabled,
    true,
    "absent from both raw and merged -> true (schema default)",
  );
  // Merged `true` (schema default) with empty raw → fall through, return true.
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: true }, {}).namespaceCatalogEnabled,
    true,
    "merged true (schema default) with empty raw falls through to default",
  );
  // Merged `false` (DIFFERENT from schema default) with empty raw → runtime
  // opt-out intent — honor it, return false.
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: false }, {}).namespaceCatalogEnabled,
    false,
    "merged false differs from schema default — runtime operator intent honored",
  );
  // Merged value wins over raw value when both are present — matches
  // the runtime-over-file spread in src/index.ts.
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: true }, { namespaceCatalogEnabled: false })
      .namespaceCatalogEnabled,
    true,
    "merged true wins over raw false (runtime-over-file)",
  );
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: false }, { namespaceCatalogEnabled: true })
      .namespaceCatalogEnabled,
    false,
    "merged false wins over raw true (runtime-over-file)",
  );
});

test("parseConfig emitLegacyTools raw null is treated as absent (PR #1593 review round 2)", () => {
  // Cursor Bugbot round 2: when raw has the key but its value is `null`
  // (operator explicitly cleared it in openclaw.json), the old resolver
  // threw via coerceBooleanLikeOrThrow. New behavior: treat null/undefined
  // in raw as "absent" and fall through to merged / env / sticky-legacy.
  withIsolatedConnectorsDir(false, () => {
    // Fresh install: raw null + merged null + env absent + sticky false → false.
    assert.equal(
      parseConfig({ emitLegacyTools: null }, { emitLegacyTools: null }).emitLegacyTools,
      false,
      "fresh install with raw null resolves to false via sticky-legacy",
    );
    // Legacy install: raw null + sticky evidence → true.
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: null }, { emitLegacyTools: null }).emitLegacyTools,
      true,
      "upgraded install with raw null resolves to true via sticky-legacy",
    );
  });
});

test("parseConfig emitLegacyTools runtime true overrides schema default (PR #1593 review round 2)", () => {
  // Cursor Bugbot round 2: schema default is `false`. When raw is missing
  // the key but merged carries `true` (runtime gateway set it), the old
  // resolver dropped the runtime override as schema-default materialization.
  // New behavior: if merged value differs from the schema default, treat
  // it as runtime operator intent and honor it.
  withIsolatedConnectorsDir(false, () => {
    // Merged `true` with empty raw → runtime opt-in honored, even on a
    // fresh install (no legacy connector entries).
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "runtime true with empty raw treated as operator intent",
    );
    // Merged `false` (the schema default) with empty raw → sticky fallback.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "merged false (schema default) with empty raw falls through to sticky-legacy",
    );
  });
});

test("parseConfig defensive null rawOperatorConfig (PR #1593 review round 3)", () => {
  // Cursor Bugbot + kilo-code-bot round 3: a JSON `null` on disk for the
  // operator config block surfaces as `null` at the second argument (the
  // loader's `as Record | undefined` cast previously hid this). Both
  // resolvers now normalize `null` to `{}` so the `"key" in raw` check
  // never throws and the schema-default-detection logic still runs.
  withIsolatedConnectorsDir(false, () => {
    // null raw + emitLegacyTools merged schema-default false → sticky-legacy
    // fallback (no throw).
    assert.equal(
      parseConfig({ emitLegacyTools: false }, null as unknown as Record<string, unknown>).emitLegacyTools,
      false,
      "null raw with emitLegacyTools merged schema default falls through to sticky-legacy",
    );
    // null raw + emitLegacyTools merged true (runtime intent) → honored.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, null as unknown as Record<string, unknown>).emitLegacyTools,
      true,
      "null raw with emitLegacyTools runtime true honored as operator intent",
    );
    // null raw + namespaceCatalogEnabled merged false → differs from schema
    // default true → runtime intent → honored.
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: false }, null as unknown as Record<string, unknown>).namespaceCatalogEnabled,
      false,
      "null raw with namespaceCatalogEnabled runtime false honored as operator intent",
    );
    // null raw + namespaceCatalogEnabled merged true (schema default) →
    // equals schema default → fall through to return SCHEMA_DEFAULT.
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: true }, null as unknown as Record<string, unknown>).namespaceCatalogEnabled,
      true,
      "null raw with namespaceCatalogEnabled schema default true preserved",
    );
  });
  withIsolatedConnectorsDir(true, () => {
    // null raw + emitLegacyTools merged false + legacy evidence →
    // sticky-legacy returns true (upgraded install scenario).
    assert.equal(
      parseConfig({ emitLegacyTools: false }, null as unknown as Record<string, unknown>).emitLegacyTools,
      true,
      "null raw with legacy evidence keeps aliases on",
    );
  });
});

test("parseConfig emitLegacyTools coerces config/env (issue #1427)", () => {
  // Boolean + boolean-like string config values.
  assert.equal(parseConfig({ emitLegacyTools: false }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "false" }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "0" }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "true" }).emitLegacyTools, true);

  // Env var fallback (REMNIC_ preferred, ENGRAM_ legacy) when config field absent.
  const prevRemnic = process.env.REMNIC_EMIT_LEGACY_TOOLS;
  const prevEngram = process.env.ENGRAM_EMIT_LEGACY_TOOLS;
  try {
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "false";
    assert.equal(parseConfig({}).emitLegacyTools, false, "REMNIC_ env disables");
    // Explicit config field wins over env.
    assert.equal(parseConfig({ emitLegacyTools: true }).emitLegacyTools, true, "config field wins over env");
    delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    process.env.ENGRAM_EMIT_LEGACY_TOOLS = "false";
    assert.equal(parseConfig({}).emitLegacyTools, false, "ENGRAM_ env fallback disables");
    // Env "true" also wins over the fresh-install default (#1550).
    delete process.env.ENGRAM_EMIT_LEGACY_TOOLS;
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "true";
    withIsolatedConnectorsDir(false, () => {
      assert.equal(parseConfig({}).emitLegacyTools, true, "env true wins over fresh-install default");
    });
  } finally {
    if (prevRemnic === undefined) delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    else process.env.REMNIC_EMIT_LEGACY_TOOLS = prevRemnic;
    if (prevEngram === undefined) delete process.env.ENGRAM_EMIT_LEGACY_TOOLS;
    else process.env.ENGRAM_EMIT_LEGACY_TOOLS = prevEngram;
  }
});

test("parseConfig rejects a present-but-malformed emitLegacyTools (gotcha #51, #1427)", () => {
  // A typo must fail fast, not silently fall through to the default (true) and
  // re-enable legacy tool advertising.
  for (const bad of ["fales", "maybe", 2, "2", "enabled"]) {
    assert.throws(
      () => parseConfig({ emitLegacyTools: bad }),
      /emitLegacyTools must be a boolean-like value/,
      `emitLegacyTools=${JSON.stringify(bad)} should throw`,
    );
  }
  // Malformed env var also fails fast (only when the config field is absent).
  const prev = process.env.REMNIC_EMIT_LEGACY_TOOLS;
  try {
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "maybe";
    assert.throws(
      () => parseConfig({}),
      /REMNIC_EMIT_LEGACY_TOOLS must be a boolean-like value/,
    );
    // An explicit valid config field overrides a malformed env (field wins first).
    assert.equal(parseConfig({ emitLegacyTools: false }).emitLegacyTools, false);
  } finally {
    if (prev === undefined) delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    else process.env.REMNIC_EMIT_LEGACY_TOOLS = prev;
  }
});

test("parseConfig expands tilde paths for core storage directories", () => {
  const previousHome = process.env.HOME;
  process.env.HOME = "/Users/remnic-test";
  try {
    const result = parseConfig({
      memoryDir: "~/memory",
      workspaceDir: "~/workspace",
      memoryExtensionsRoot: "~/extensions",
    });
    assert.equal(result.memoryDir, "/Users/remnic-test/memory");
    assert.equal(result.workspaceDir, "/Users/remnic-test/workspace");
    assert.equal(result.memoryExtensionsRoot, "/Users/remnic-test/extensions");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

// ── PR #394 Bug 2: parseConfig must coerce string "false" for installExtension

test('parseConfig codex.installExtension="false" (string) → false (boolean)', () => {
  const result = parseConfig({ codex: { installExtension: "false" } });
  assert.equal(
    result.codex.installExtension,
    false,
    'string "false" must be coerced to boolean false',
  );
});

test('parseConfig codex.installExtension="0" (string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "0" } });
  assert.equal(result.codex.installExtension, false);
});

test('parseConfig codex.installExtension="no" (string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "no" } });
  assert.equal(result.codex.installExtension, false);
});

test('parseConfig codex.installExtension="FALSE" (uppercase string) → false', () => {
  const result = parseConfig({ codex: { installExtension: "FALSE" } });
  assert.equal(result.codex.installExtension, false);
});

test("parseConfig codex.installExtension=false (boolean) → false", () => {
  const result = parseConfig({ codex: { installExtension: false } });
  assert.equal(result.codex.installExtension, false);
});

test("parseConfig codex.installExtension=true (boolean) → true", () => {
  const result = parseConfig({ codex: { installExtension: true } });
  assert.equal(result.codex.installExtension, true);
});

test('parseConfig codex.installExtension="true" (string) → true', () => {
  const result = parseConfig({ codex: { installExtension: "true" } });
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig codex.installExtension missing → defaults to true", () => {
  const result = parseConfig({ codex: {} });
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig codex missing entirely → installExtension defaults to true", () => {
  const result = parseConfig({});
  assert.equal(result.codex.installExtension, true);
});

test("parseConfig recallPlannerLlmEnabled defaults to false and coerces boolean-like strings (opt-in, issue #1367)", () => {
  assert.equal(parseConfig({}).recallPlannerLlmEnabled, false);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: true }).recallPlannerLlmEnabled, true);
  // CLI/env surfaces pass strings — these must enable the gate (gotcha #36).
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "true" }).recallPlannerLlmEnabled, true);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "1" }).recallPlannerLlmEnabled, true);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "on" }).recallPlannerLlmEnabled, true);
  // Boolean-like falses and junk stay off.
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "false" }).recallPlannerLlmEnabled, false);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "0" }).recallPlannerLlmEnabled, false);
});

test("parseConfig coerces boolean-like strings for all recallPlanner gates (issue #1367, gotcha #36)", () => {
  // Rollout switches must honor string config from CLI/env surfaces.
  assert.equal(parseConfig({ recallPlannerShadowMode: "true" }).recallPlannerShadowMode, true);
  assert.equal(parseConfig({ recallPlannerShadowMode: "off" }).recallPlannerShadowMode, false);
  assert.equal(parseConfig({}).recallPlannerShadowMode, false);

  assert.equal(parseConfig({ recallPlannerTelemetryEnabled: "false" }).recallPlannerTelemetryEnabled, false);
  assert.equal(parseConfig({}).recallPlannerTelemetryEnabled, true);

  // The enable gate must be disableable via string "false" (the old `!== false`
  // check treated "false" as truthy → could not disable).
  assert.equal(parseConfig({ recallPlannerEnabled: "false" }).recallPlannerEnabled, false);
  assert.equal(parseConfig({}).recallPlannerEnabled, true);
});

test("parseConfig recall concurrency + single-flight knobs (issue #1906)", () => {
  // Defaults: cap 4, single-flight on.
  assert.equal(parseConfig({}).recallMaxConcurrentPerPrincipal, 4);
  assert.equal(parseConfig({}).recallSingleFlightEnabled, true);
  // 0 (unlimited) is honored, not coerced to the default.
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 0 }).recallMaxConcurrentPerPrincipal,
    0,
  );
  // 1 restores exact serialization.
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 1 }).recallMaxConcurrentPerPrincipal,
    1,
  );
  // CLI/env surfaces pass strings — integer-like strings are accepted.
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: "8" }).recallMaxConcurrentPerPrincipal,
    8,
  );
  // Fractional values are NOT floored (a typo like 0.5 must not become 0 =
  // unlimited): they fall back to the default 4 (issue #1906 review round 3 #4).
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 0.5 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 3.9 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  // Negative / NaN fall back to the default 4.
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: -1 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: "abc" }).recallMaxConcurrentPerPrincipal,
    4,
  );
  // Single-flight disable via boolean and boolean-like string.
  assert.equal(
    parseConfig({ recallSingleFlightEnabled: false }).recallSingleFlightEnabled,
    false,
  );
  assert.equal(
    parseConfig({ recallSingleFlightEnabled: "false" }).recallSingleFlightEnabled,
    false,
  );
});

test("parseConfig dreaming.maxEntries=0 preserves the runtime disable switch", () => {
  const result = parseConfig({ dreaming: { maxEntries: 0 } });
  assert.equal(result.dreaming.maxEntries, 0);
});

test("parseConfig dreaming.maxEntries=5 falls back to the documented default", () => {
  const result = parseConfig({ dreaming: { maxEntries: 5 } });
  assert.equal(result.dreaming.maxEntries, 500);
});

test("parseConfig dreaming.maxEntries=-5 falls back to the documented default", () => {
  const result = parseConfig({ dreaming: { maxEntries: -5 } });
  assert.equal(result.dreaming.maxEntries, 500);
});

test("parseConfig activeRecallCacheTtlMs=0 disables the active-recall cache", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: 0 });
  assert.equal(result.activeRecallCacheTtlMs, 0);
});

test("parseConfig activeRecallCacheTtlMs=500 preserves the explicit positive ttl", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: 500 });
  assert.equal(result.activeRecallCacheTtlMs, 500);
});

test("parseConfig separates legacy custom instruction from full prompt replacement", () => {
  assert.equal(
    parseConfig({ activeRecallPromptOverride: "  legacy guidance  " }).activeRecallCustomInstruction,
    "legacy guidance",
  );
  assert.equal(
    parseConfig({ activeRecallPromptOverride: "  legacy guidance  " }).activeRecallPromptOverride,
    "legacy guidance",
  );
  assert.equal(
    parseConfig({ activeRecallPromptReplacement: "  Use the evidence.  " })
      .activeRecallPromptReplacement,
    "Use the evidence.",
  );
  const combined = parseConfig({
    activeRecallPromptOverride: "legacy guidance",
    activeRecallPromptReplacement: "replacement prompt",
  });
  assert.equal(combined.activeRecallCustomInstruction, "legacy guidance");
  assert.equal(combined.activeRecallPromptOverride, "legacy guidance");
  assert.equal(combined.activeRecallPromptReplacement, "replacement prompt");
  for (const [key, value] of [
    ["activeRecallPromptOverride", false],
    ["activeRecallPromptReplacement", 0],
    ["activeRecallPromptReplacement", {}],
    ["activeRecallPromptOverride", []],
  ] as const) {
    assert.throws(
      () => parseConfig({ [key]: value } as never),
      new RegExp(`${key} must be a string`),
      `invalid ${key} ${JSON.stringify(value)} must be rejected`,
    );
  }
});

test("parseConfig validates commitmentDecayDays as a positive integer", () => {
  assert.equal(parseConfig({}).commitmentDecayDays, 90);
  assert.equal(parseConfig({ commitmentDecayDays: 30 }).commitmentDecayDays, 30);
  assert.equal(parseConfig({ commitmentDecayDays: "45" }).commitmentDecayDays, 45);

  for (const value of [0, -1, 1.5, "1.5", "abc", Number.NaN, Infinity]) {
    assert.throws(
      () => parseConfig({ commitmentDecayDays: value }),
      /commitmentDecayDays must be an integer greater than or equal to 1/,
      `invalid commitmentDecayDays ${String(value)} should throw`,
    );
  }
});

test("parseConfig initGateTimeoutMs defaults to OpenClaw cold-start budget", () => {
  const result = parseConfig({});
  assert.equal(result.initGateTimeoutMs, 30_000);
});

test("parseConfig keeps external wiki merge out of default recall", () => {
  assert.equal(parseConfig({}).wikiMergeIntoRecall, false);
  assert.equal(parseConfig({ wikiMergeIntoRecall: false }).wikiMergeIntoRecall, false);
  assert.throws(
    () => parseConfig({ wikiMergeIntoRecall: true }),
    /wikiMergeIntoRecall=true is not supported/,
  );
  assert.throws(
    () => parseConfig({ wikiMergeIntoRecall: "maybe" }),
    /wikiMergeIntoRecall must be a boolean-like value/,
  );
});

test("parseConfig rejects external wiki collections as default memory collections", () => {
  assert.throws(
    () => parseConfig({ qmdCollection: "external-wiki-reading" }),
    /qmdCollection must be a memory collection/,
  );
  assert.throws(
    () => parseConfig({ qmdColdCollection: "external-wiki-archive" }),
    /qmdColdCollection must be a memory collection/,
  );
});

test("parseConfig qmdSearchStrategy defaults to hybrid and validates the enum", () => {
  // Default must equal the historical lex+vec+hyde behavior. Issue #1335.
  assert.equal(parseConfig({}).qmdSearchStrategy, "hybrid");
  assert.equal(parseConfig({ qmdSearchStrategy: "hybrid" }).qmdSearchStrategy, "hybrid");
  assert.equal(parseConfig({ qmdSearchStrategy: "lex-vec" }).qmdSearchStrategy, "lex-vec");
  assert.equal(parseConfig({ qmdSearchStrategy: "lex" }).qmdSearchStrategy, "lex");
  assert.equal(parseConfig({ qmdSearchStrategy: "LEX" }).qmdSearchStrategy, "lex");

  for (const value of ["hyde", "vec", "bm25", "", 42]) {
    assert.throws(
      () => parseConfig({ qmdSearchStrategy: value }),
      /qmdSearchStrategy must be one of/,
      `invalid qmdSearchStrategy ${String(value)} should throw`,
    );
  }
});

test("parseConfig qmdSubprocessStrategy defaults to query (honors QMD query intent)", () => {
  // Default must remain `qmd query` (LLM expansion + rerank) per CLAUDE.md gotcha #7.
  assert.equal(parseConfig({}).qmdSubprocessStrategy, "query");
  assert.equal(parseConfig({ qmdSubprocessStrategy: "query" }).qmdSubprocessStrategy, "query");
  assert.equal(parseConfig({ qmdSubprocessStrategy: "search" }).qmdSubprocessStrategy, "search");
  assert.equal(parseConfig({ qmdSubprocessStrategy: "SEARCH" }).qmdSubprocessStrategy, "search");

  for (const value of ["bm25", "vsearch", "", 7]) {
    assert.throws(
      () => parseConfig({ qmdSubprocessStrategy: value }),
      /qmdSubprocessStrategy must be one of/,
      `invalid qmdSubprocessStrategy ${String(value)} should throw`,
    );
  }
});

test("parseConfig qmdDaemonTimeoutMs defaults to 8000 and clamps valid integers", () => {
  assert.equal(parseConfig({}).qmdDaemonTimeoutMs, 8_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 20_000 }).qmdDaemonTimeoutMs, 20_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: "20000" }).qmdDaemonTimeoutMs, 20_000);
  // Below floor clamps up; above ceiling clamps down.
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 100 }).qmdDaemonTimeoutMs, 1_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 999_999 }).qmdDaemonTimeoutMs, 120_000);
});

test("parseConfig qmdDaemonTimeoutMs rejects non-numeric and non-integer input", () => {
  // gotcha #51 + codex review on #1422: silent coercion hides config mistakes.
  for (const value of ["abc", "", 2500.9, "2500.9", Number.NaN, Infinity, true, {}]) {
    assert.throws(
      () => parseConfig({ qmdDaemonTimeoutMs: value }),
      /qmdDaemonTimeoutMs must be an integer/,
      `invalid qmdDaemonTimeoutMs ${String(value)} should throw`,
    );
  }
});

test("parseConfig initGateTimeoutMs accepts CLI-style numeric strings", () => {
  const result = parseConfig({ initGateTimeoutMs: "45000" });
  assert.equal(result.initGateTimeoutMs, 45_000);
});

test("parseConfig initGateTimeoutMs clamps unsafe values", () => {
  assert.equal(parseConfig({ initGateTimeoutMs: 0 }).initGateTimeoutMs, 1_000);
  assert.equal(parseConfig({ initGateTimeoutMs: 300_000 }).initGateTimeoutMs, 120_000);
  assert.equal(parseConfig({ initGateTimeoutMs: "abc" }).initGateTimeoutMs, 30_000);
});

test("parseConfig modelSource=gateway does not inherit OPENAI_API_KEY from the process env", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-be-used";
  try {
    const cfg = parseConfig({ modelSource: "gateway" });
    assert.equal(cfg.modelSource, "gateway");
    assert.equal(cfg.openaiApiKey, undefined);
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig normalizes taskModelChain", () => {
  const cfg = parseConfig({
    taskModelChain: {
      primary: " openai/cheap-primary ",
      fallbacks: ["openai/cheap-primary", " fireworks/accounts/fireworks/models/glm-5p1 ", ""],
    },
  });

  assert.deepEqual(cfg.taskModelChain, {
    primary: "openai/cheap-primary",
    fallbacks: ["fireworks/accounts/fireworks/models/glm-5p1"],
  });
});

test("parseConfig treats an absent taskModelChain as not configured", () => {
  assert.equal(parseConfig({}).taskModelChain, undefined);
  assert.equal(parseConfig({ taskModelChain: null }).taskModelChain, undefined);
  assert.equal(parseConfig({ taskModelChain: undefined }).taskModelChain, undefined);
});

test("parseConfig rejects a present-but-malformed taskModelChain (gotcha #51)", () => {
  // A typo'd chain must surface loudly instead of silently reverting to defaults.
  assert.throws(() => parseConfig({ taskModelChain: [] }), /taskModelChain must be an object/);
  assert.throws(() => parseConfig({ taskModelChain: "openai/x" }), /taskModelChain must be an object/);
  assert.throws(() => parseConfig({ taskModelChain: { primary: " " } }), /taskModelChain\.primary is required/);
  assert.throws(() => parseConfig({ taskModelChain: { fallbacks: ["openai/fallback-only"] } }), /taskModelChain\.primary is required/);
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/p", fallbacks: "not-an-array" } }),
    /taskModelChain\.fallbacks must be an array/,
  );
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/p", fallbacks: [123] } }),
    /taskModelChain\.fallbacks must contain only strings/,
  );
});

test("parseConfig rejects unqualified taskModelChain model strings (codex review #1425)", () => {
  // A slash-less id like "gpt-4.1" parses here but FallbackLlmClient.parseModelString
  // drops it, leaving the chain silently using a different model — reject at parse.
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "gpt-4.1" } }),
    /taskModelChain\.primary must be in "provider\/model" form/,
  );
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/" } }),
    /taskModelChain\.primary must be in "provider\/model" form/,
  );
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "/gpt-4.1" } }),
    /taskModelChain\.primary must be in "provider\/model" form/,
  );
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/gpt", fallbacks: ["bare-model"] } }),
    /taskModelChain\.fallbacks entries must be in "provider\/model" form/,
  );
  // Multi-slash provider/model paths remain valid.
  assert.deepEqual(
    parseConfig({
      taskModelChain: { primary: "fireworks/accounts/fireworks/models/glm-5p1" },
    }).taskModelChain,
    { primary: "fireworks/accounts/fireworks/models/glm-5p1" },
  );
});

test("parseConfig rejects unknown taskModelChain keys (codex review #1425)", () => {
  // A misspelled "fallback" must not silently drop the fallback chain.
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/p", fallback: ["openai/q"] } }),
    /taskModelChain has unknown property: fallback/,
  );
  assert.throws(
    () => parseConfig({ taskModelChain: { primary: "openai/p", fallbackModels: ["openai/q"], extra: 1 } }),
    /taskModelChain has unknown properties:/,
  );
});

test("parseConfig routes gateway task-model defaults through taskModelChain primary", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
      fallbacks: ["zai/glm-4.5-air"],
    },
  });

  // Base model stays direct-compatible — direct-key call sites (e.g. briefing
  // follow-ups) pass it straight to the OpenAI Responses API, so it must never
  // become a provider-qualified gateway route string (issue #1469 / PR #1470).
  assert.equal(cfg.model, "gpt-5.5");
  // Gateway-routed task models pick up the configured task-chain primary.
  assert.equal(cfg.summaryModel, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(cfg.recallPlannerModel, "openrouter/deepseek/deepseek-v4-flash");
});

test("parseConfig lets explicit task models override taskModelChain defaults", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "openrouter/model-override",
    summaryModel: "openrouter/summary-override",
    recallPlannerModel: "openrouter/planner-override",
    taskModelChain: {
      primary: "openrouter/deepseek/deepseek-v4-flash",
    },
  });

  assert.equal(cfg.model, "openrouter/model-override");
  assert.equal(cfg.summaryModel, "openrouter/summary-override");
  assert.equal(cfg.recallPlannerModel, "openrouter/planner-override");
});

test("parseConfig lets a provider-qualified base model feed summaryModel in gateway mode without a task chain (#1469)", () => {
  // A provider-qualified explicit `model` (no summaryModel, no taskModelChain) is
  // routable through the gateway, so summaryModel inherits it as its second-priority
  // source. This exercises the `gatewayTaskModel(explicitModel)` leg of the chain.
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "openrouter/my-model",
  });

  assert.equal(cfg.model, "openrouter/my-model");
  assert.equal(cfg.summaryModel, "openrouter/my-model");
  // recallPlannerModel intentionally does NOT inherit cfg.model — it only
  // considers its own explicit field then the gateway task fallback.
  assert.equal(cfg.recallPlannerModel, "");
});

test("parseConfig treats the injected bare schema-default model as absent for gateway task routing (#1469)", () => {
  // OpenClaw applies the manifest schema defaults (model + recallPlannerModel
  // default to "gpt-5.5") BEFORE parseConfig sees the config, so an operator who
  // only set modelSource + taskModelChain still arrives here with a bare
  // model === "gpt-5.5". The gateway-routed task models must NOT pin that bare id
  // (it would resolve to an unroutable <provider>/gpt-5.5); they fall through to
  // the configured task chain instead (codex review on PR #1470).
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "gpt-5.5", // injected schema default, not an operator choice
    recallPlannerModel: "gpt-5.5", // injected schema default
    taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
  });

  // Base model stays direct-compatible for direct-key call sites...
  assert.equal(cfg.model, "gpt-5.5");
  // ...but the gateway-routed task models pick up the task-chain primary.
  assert.equal(cfg.summaryModel, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(cfg.recallPlannerModel, "openrouter/deepseek/deepseek-v4-flash");
});

test("parseConfig drops a bare schema-default model in gateway mode with no task chain (#1469)", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "gpt-5.5", // injected schema default
    recallPlannerModel: "gpt-5.5",
  });

  // Nothing routable is configured → gateway task models stay empty so the
  // Gateway default wins (no bare "gpt-5.5" leaks to the flush plan / cron).
  assert.equal(cfg.summaryModel, "");
  assert.equal(cfg.recallPlannerModel, "");
});

test("parseConfig leaves gateway task-model defaults empty without taskModelChain", () => {
  const cfg = parseConfig({ modelSource: "gateway" });

  // Base model keeps the direct-compatible default...
  assert.equal(cfg.model, "gpt-5.5");
  // ...but gateway-routed task models stay empty so the Gateway default wins
  // (no unroutable bare id is ever sent to the gateway).
  assert.equal(cfg.summaryModel, "");
  assert.equal(cfg.recallPlannerModel, "");
});

test("parseConfig keeps model direct-compatible when a direct openaiApiKey coexists with a gateway task chain (#1469)", () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const cfg = parseConfig({
      modelSource: "gateway",
      openaiApiKey: "sk-direct-key",
      taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
    });

    // Direct-key call sites (e.g. briefing follow-ups) use cfg.model against the
    // OpenAI Responses API, so it must NOT become the provider-qualified gateway
    // route string even though a task chain is configured. The task chain only
    // feeds the gateway-routed summary model (codex review on PR #1470).
    assert.equal(cfg.openaiApiKey, "sk-direct-key");
    assert.equal(cfg.model, "gpt-5.5");
    assert.equal(cfg.summaryModel, "openrouter/deepseek/deepseek-v4-flash");
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig modelSource=gateway still honors an explicit openaiApiKey override", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-be-used";
  try {
    const cfg = parseConfig({
      modelSource: "gateway",
      openaiApiKey: "sk-explicit",
    });
    assert.equal(cfg.modelSource, "gateway");
    assert.equal(cfg.openaiApiKey, "sk-explicit");
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig separates local chat and embedding fallback models", () => {
  const cfg = parseConfig({
    localLlmEnabled: true,
    localLlmModel: "google/gemma-4-26b-a4b",
    embeddingFallbackProvider: "local",
    embeddingFallbackModel: "text-embedding-nomic-embed-text-v1.5@q4_k_m",
  });

  assert.equal(cfg.localLlmModel, "google/gemma-4-26b-a4b");
  assert.equal(
    cfg.embeddingFallbackModel,
    "text-embedding-nomic-embed-text-v1.5@q4_k_m",
  );
});

test("parseConfig openaiApiKey=false disables implicit OPENAI_API_KEY inheritance", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-be-used";
  try {
    const cfg = parseConfig({
      openaiApiKey: false,
      localLlmEnabled: true,
    });
    assert.equal(cfg.modelSource, "plugin");
    assert.equal(cfg.localLlmEnabled, true);
    assert.equal(cfg.openaiApiKey, undefined);
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig openaiApiKey string false disables implicit OPENAI_API_KEY inheritance", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-be-used";
  try {
    const cfg = parseConfig({
      openaiApiKey: "false",
      localLlmEnabled: "true",
    });
    assert.equal(cfg.localLlmEnabled, true);
    assert.equal(cfg.openaiApiKey, undefined);
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig openaiApiKey string 0 is not treated as a direct OpenAI opt-out", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-env-should-not-be-used";
  try {
    const cfg = parseConfig({
      openaiApiKey: "0",
      localLlmEnabled: "true",
    });
    assert.equal(cfg.localLlmEnabled, true);
    assert.equal(cfg.openaiApiKey, "0");
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = original;
  }
});

test("parseConfig localLlmApiKeyEnv resolves a present launch token but tolerates its absence", () => {
  const variable = "REMNIC_TEST_LOCAL_LLM_TOKEN";
  const previous = process.env[variable];
  try {
    delete process.env[variable];
    const absent = parseConfig({ localLlmApiKeyEnv: variable });
    assert.equal(absent.localLlmApiKey, undefined);
    assert.equal(absent.localLlmApiKeyEnv, variable);

    process.env[variable] = "launch-scoped-local-token";
    const present = parseConfig({ localLlmApiKeyEnv: variable });
    assert.equal(present.localLlmApiKey, "launch-scoped-local-token");
    assert.equal(present.localLlmApiKeyEnv, variable);

    assert.throws(
      () => parseConfig({ localLlmApiKeyEnv: "not-an-environment-variable" }),
      /localLlmApiKeyEnv must name a conventional environment variable/,
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("parseConfig localLlmTimeoutMs accepts CLI-style numeric strings for gateway fallback", () => {
  const cfg = parseConfig({ localLlmTimeoutMs: "600000" });
  assert.equal(cfg.localLlmTimeoutMs, 600_000);
});

test("parseConfig localLlmTimeoutMs clamps invalid values to a positive timeout", () => {
  assert.equal(parseConfig({ localLlmTimeoutMs: 0 }).localLlmTimeoutMs, 1);
  assert.equal(parseConfig({ localLlmTimeoutMs: Number.NaN }).localLlmTimeoutMs, 180_000);
});

test("parseConfig validates localLlmMaxContext as a usable context window", () => {
  assert.equal(parseConfig({ localLlmMaxContext: 4096 }).localLlmMaxContext, 4096);
  assert.equal(parseConfig({ localLlmMaxContext: "8192" }).localLlmMaxContext, 8192);
  assert.equal(parseConfig({}).localLlmMaxContext, undefined);

  for (const value of [0, -1, 128, 1023, 1.5, "1.5", "abc", Number.NaN, Infinity]) {
    assert.throws(
      () => parseConfig({ localLlmMaxContext: value }),
      /localLlmMaxContext must be an integer greater than or equal to 1024/,
      `invalid localLlmMaxContext ${String(value)} should throw`,
    );
  }
});
test("parseConfig extractionSourceGroundingEnabled defaults on and accepts string false", () => {
  assert.equal(parseConfig({}).extractionSourceGroundingEnabled, true);
  assert.equal(parseConfig({ extractionSourceGroundingEnabled: "false" }).extractionSourceGroundingEnabled, false);
});

test("parseConfig extractionTelemetryPrefilterEnabled defaults on and accepts string false", () => {
  assert.equal(parseConfig({}).extractionTelemetryPrefilterEnabled, true);
  assert.equal(parseConfig({ extractionTelemetryPrefilterEnabled: "false" }).extractionTelemetryPrefilterEnabled, false);
});

test("parseConfig lcmTelemetryPrefilterEnabled defaults on and accepts string false", () => {
  assert.equal(parseConfig({}).lcmTelemetryPrefilterEnabled, true);
  assert.equal(parseConfig({ lcmTelemetryPrefilterEnabled: "false" }).lcmTelemetryPrefilterEnabled, false);
});

test("parseConfig keeps explicit cue recall opt-in and budgets configurable", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.explicitCueRecallEnabled, false);
  assert.equal(defaults.explicitCueRecallMaxChars, 2400);
  assert.equal(defaults.explicitCueRecallMaxReferences, 24);
  assert.equal(
    defaults.recallPipeline.find((section) => section.id === "explicit-cue")
      ?.enabled,
    false,
  );

  const cfg = parseConfig({
    explicitCueRecallEnabled: true,
    explicitCueRecallMaxChars: 0,
    explicitCueRecallMaxReferences: 0,
  });
  assert.equal(cfg.explicitCueRecallEnabled, true);
  assert.equal(cfg.explicitCueRecallMaxChars, 0);
  assert.equal(cfg.explicitCueRecallMaxReferences, 0);
  const section = cfg.recallPipeline.find((entry) => entry.id === "explicit-cue");
  assert.equal(section?.enabled, true);
  assert.equal(section?.maxChars, 0);
  assert.equal(section?.maxResults, 0);

  const cliStyle = parseConfig({
    explicitCueRecallEnabled: "true",
    explicitCueRecallMaxChars: "3200",
    explicitCueRecallMaxReferences: "12",
  });
  assert.equal(cliStyle.explicitCueRecallEnabled, true);
  assert.equal(cliStyle.explicitCueRecallMaxChars, 3200);
  assert.equal(cliStyle.explicitCueRecallMaxReferences, 12);
  const cliSection = cliStyle.recallPipeline.find(
    (entry) => entry.id === "explicit-cue",
  );
  assert.equal(cliSection?.enabled, true);
  assert.equal(cliSection?.maxChars, 3200);
  assert.equal(cliSection?.maxResults, 12);
});

test("research-max preset enables explicit cue recall for benchmark-grade runs", () => {
  const cfg = parseConfig({ memoryOsPreset: "research-max" });
  assert.equal(cfg.explicitCueRecallEnabled, true);
  assert.equal(cfg.explicitCueRecallMaxChars, 3200);
  assert.equal(cfg.lcmEnabled, true);
  assert.equal(
    cfg.recallPipeline.find((section) => section.id === "explicit-cue")
      ?.enabled,
    true,
  );
});

test("parseConfig validates lcmObserveConcurrency", () => {
  const cfg = parseConfig({ lcmObserveConcurrency: "4" });
  assert.equal(cfg.lcmObserveConcurrency, 4);

  assert.throws(
    () => parseConfig({ lcmObserveConcurrency: 0 }),
    /lcmObserveConcurrency must be an integer greater than or equal to 1/,
  );
  assert.throws(
    () => parseConfig({ lcmObserveConcurrency: 1.5 }),
    /lcmObserveConcurrency must be an integer greater than or equal to 1/,
  );
});

test("parseConfig activeRecallCacheTtlMs=-1 falls back to the default ttl", () => {
  const result = parseConfig({ activeRecallCacheTtlMs: -1 });
  assert.equal(result.activeRecallCacheTtlMs, 15000);
});

test("parseConfig preserves custom entity schemas without code changes", () => {
  const result = parseConfig({
    entitySchemas: {
      person: {
        sections: [
          { key: "beliefs", title: "Beliefs" },
          { key: "working_on", title: "Working On" },
        ],
      },
    },
  });

  assert.deepEqual((result as any).entitySchemas?.person?.sections, [
    { key: "beliefs", title: "Beliefs", description: "" },
    { key: "working_on", title: "Working On", description: "" },
  ]);
});

// ── Issue #518: direct-answer retrieval tier config ─────────────────────────

test("parseConfig recallDirectAnswerEnabled defaults to false", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerEnabled, false);
});

test('parseConfig recallDirectAnswerEnabled coerces string "true" to boolean true', () => {
  const result = parseConfig({ recallDirectAnswerEnabled: "true" });
  assert.equal(result.recallDirectAnswerEnabled, true);
});

test('parseConfig recallDirectAnswerEnabled coerces string "false" to boolean false (rule 36)', () => {
  const result = parseConfig({ recallDirectAnswerEnabled: "false" });
  assert.equal(result.recallDirectAnswerEnabled, false);
});

test("parseConfig recallDirectAnswerEnabled accepts boolean true", () => {
  const result = parseConfig({ recallDirectAnswerEnabled: true });
  assert.equal(result.recallDirectAnswerEnabled, true);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor defaults to 0.55", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=0 is preserved as disable switch (rule 45)", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 0 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=0.8 preserves the explicit value", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 0.8 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.8);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=-0.1 falls back to default", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: -0.1 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test("parseConfig recallDirectAnswerTokenOverlapFloor=1.5 falls back to default", () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: 1.5 });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="0.8" (string) coerces to 0.8 (rule 28)', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "0.8" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.8);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="0" (string) coerces to 0', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "0" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0);
});

test('parseConfig recallDirectAnswerTokenOverlapFloor="not-a-number" falls back to default', () => {
  const result = parseConfig({ recallDirectAnswerTokenOverlapFloor: "not-a-number" });
  assert.equal(result.recallDirectAnswerTokenOverlapFloor, 0.55);
});

test('parseConfig recallDirectAnswerImportanceFloor="0.9" (string) coerces to 0.9', () => {
  const result = parseConfig({ recallDirectAnswerImportanceFloor: "0.9" });
  assert.equal(result.recallDirectAnswerImportanceFloor, 0.9);
});

test('parseConfig recallDirectAnswerAmbiguityMargin="0.25" (string) coerces to 0.25', () => {
  const result = parseConfig({ recallDirectAnswerAmbiguityMargin: "0.25" });
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.25);
});

test("parseConfig recallDirectAnswerImportanceFloor defaults to 0.7", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerImportanceFloor, 0.7);
});

test("parseConfig recallDirectAnswerImportanceFloor=0 is preserved as disable switch", () => {
  const result = parseConfig({ recallDirectAnswerImportanceFloor: 0 });
  assert.equal(result.recallDirectAnswerImportanceFloor, 0);
});

test("parseConfig recallDirectAnswerAmbiguityMargin defaults to 0.15", () => {
  const result = parseConfig({});
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.15);
});

test("parseConfig recallDirectAnswerAmbiguityMargin=0.3 preserves explicit value", () => {
  const result = parseConfig({ recallDirectAnswerAmbiguityMargin: 0.3 });
  assert.equal(result.recallDirectAnswerAmbiguityMargin, 0.3);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets defaults to the documented list", () => {
  const result = parseConfig({});
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets preserves a custom array", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: ["decisions", "runbooks"],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "runbooks",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets filters non-strings and empty strings", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: ["decisions", "", 42, null, "runbooks"],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "runbooks",
  ]);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets=[] is preserved as a disable-all state", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: [],
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, []);
});

test("parseConfig recallDirectAnswerEligibleTaxonomyBuckets non-array value falls back to default", () => {
  const result = parseConfig({
    recallDirectAnswerEligibleTaxonomyBuckets: "decisions",
  });
  assert.deepEqual(result.recallDirectAnswerEligibleTaxonomyBuckets, [
    "decisions",
    "principles",
    "conventions",
    "runbooks",
    "entities",
  ]);
});

// ── Issue #548: local LLM thinking-mode suppression ─────────────────────────

test("parseConfig localLlmDisableThinking defaults to true (issue #548)", () => {
  const result = parseConfig({});
  assert.equal(result.localLlmDisableThinking, true);
});

test("parseConfig localLlmDisableThinking=false preserves operator opt-out", () => {
  const result = parseConfig({ localLlmDisableThinking: false });
  assert.equal(result.localLlmDisableThinking, false);
});

test('parseConfig localLlmDisableThinking="false" (CLI string) coerces to boolean false (rule 36)', () => {
  // `--config localLlmDisableThinking=false` arrives as string; must
  // coerce or the opt-out silently fails.
  const result = parseConfig({ localLlmDisableThinking: "false" });
  assert.equal(result.localLlmDisableThinking, false);
});

test('parseConfig localLlmDisableThinking="true" (CLI string) coerces to boolean true', () => {
  const result = parseConfig({ localLlmDisableThinking: "true" });
  assert.equal(result.localLlmDisableThinking, true);
});

test('parseConfig localLlmDisableThinking "0"/"no"/"off" all coerce to false', () => {
  assert.equal(parseConfig({ localLlmDisableThinking: "0" }).localLlmDisableThinking, false);
  assert.equal(parseConfig({ localLlmDisableThinking: "no" }).localLlmDisableThinking, false);
  assert.equal(parseConfig({ localLlmDisableThinking: "off" }).localLlmDisableThinking, false);
});

test("parseConfig localLlmThinkingThresholdChars defaults conservatively and accepts zero to disable (#1997)", () => {
  assert.equal(parseConfig({}).localLlmThinkingThresholdChars, 3_000);
  assert.equal(parseConfig({ localLlmThinkingThresholdChars: 0 }).localLlmThinkingThresholdChars, 0);
  assert.equal(parseConfig({ localLlmThinkingThresholdChars: "3000" }).localLlmThinkingThresholdChars, 3_000);
  assert.equal(parseConfig({ localLlmThinkingThresholdChars: 3_000 }).localLlmThinkingThresholdChars, 3_000);
});

test("parseConfig procedural numeric fields coerce from CLI-style strings (issue #519)", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    procedural: {
      enabled: true,
      minOccurrences: "5",
      successFloor: "0.82",
      autoPromoteOccurrences: "12",
      lookbackDays: "14",
      recallMaxProcedures: "2",
    },
  });
  assert.equal(result.procedural.minOccurrences, 5);
  assert.equal(result.procedural.successFloor, 0.82);
  assert.equal(result.procedural.autoPromoteOccurrences, 12);
  assert.equal(result.procedural.lookbackDays, 14);
  assert.equal(result.procedural.recallMaxProcedures, 2);
});

test("parseConfig applies safer-by-default procedural thresholds (issue #567 PR 3/5)", () => {
  // When the user does not override procedural thresholds, the defaults
  // MUST match the safer floor committed in #567 PR 3. This test locks in
  // the values so a future refactor cannot silently regress them.
  // Slice 4 flips `enabled` to true — asserted in the next test.
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.procedural.minOccurrences, 3);
  assert.equal(result.procedural.successFloor, 0.75);
  assert.equal(result.procedural.autoPromoteOccurrences, 8);
  assert.equal(result.procedural.lookbackDays, 14);
  assert.equal(result.procedural.recallMaxProcedures, 2);
});

test("buildDefaultRecallPipeline enables procedure-recall when procedural default-on (issue #567 PR 4/5)", () => {
  // Codex P2 on #609: the master gate defaulting to `true` must also flip
  // the default recall pipeline to include the `procedure-recall` section.
  // Previously the pipeline check required `cfg.procedural?.enabled === true`
  // on raw config, so an omitted key left the section disabled even
  // though `parseConfig` reported enabled:true.
  const cfg = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(cfg.procedural.enabled, true);
  const procSection = cfg.recallPipeline.find(
    (s) => s.id === "procedure-recall",
  );
  assert.ok(procSection, "procedure-recall section must exist by default");
  assert.equal(
    procSection.enabled,
    true,
    "procedure-recall must be enabled when procedural default-on",
  );

  // Explicit opt-out disables both the master gate and the recall section.
  const optOut = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: false },
  });
  assert.equal(optOut.procedural.enabled, false);
  const optOutSection = optOut.recallPipeline.find(
    (s) => s.id === "procedure-recall",
  );
  assert.equal(optOutSection?.enabled, false);
});

test("parseConfig rejects non-object procedural shapes (Codex P2 on #609)", () => {
  // `procedural: false` or `procedural: null` would previously normalize
  // to `{}` and then the omitted-key branch would silently enable the
  // feature — the opposite of the user's shorthand intent. Reject loudly.
  for (const v of [false, true, null, 42, "disabled", []] as unknown[]) {
    assert.throws(
      () =>
        parseConfig({ openaiApiKey: "sk-test", procedural: v } as Record<
          string,
          unknown
        >),
      /procedural must be an object/,
      `invalid procedural shape ${JSON.stringify(v)} should throw`,
    );
  }
  // Valid empty object still parses (means "use defaults").
  const blank = parseConfig({ openaiApiKey: "sk-test", procedural: {} });
  assert.equal(blank.procedural.enabled, true);
});

test("conservative memoryOsPreset keeps procedural.enabled off after default flip (issue #567 PR 4/5)", () => {
  // Cursor Medium on #609: the `conservative` preset disables many
  // features; the default flip must not silently opt it into procedural
  // memory.
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
  });
  assert.equal(cfg.procedural.enabled, false);

  // A user can still opt back in by setting the key explicitly — the
  // preset is a default, not a ceiling.
  const optedIn = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
    procedural: { enabled: true },
  });
  assert.equal(optedIn.procedural.enabled, true);

  // Codex P1 on #609: a user-provided `procedural` block that does NOT
  // set `enabled` must not clobber the preset's `enabled: false`. The
  // preset's procedural object is deep-merged with the baseCfg's
  // procedural object so partial overrides (minOccurrences, lookbackDays)
  // preserve the opt-out.
  const nestedOverride = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
    procedural: { minOccurrences: 5 },
  });
  assert.equal(
    nestedOverride.procedural.enabled,
    false,
    "conservative opt-out must survive an unrelated procedural override",
  );
  assert.equal(nestedOverride.procedural.minOccurrences, 5);
});

test("parseConfig defaults procedural.enabled to true when omitted (issue #567 PR 4/5)", () => {
  // Omitting `procedural.enabled` ships the feature ON. Users who were
  // previously on the default-off branch get the new default automatically.
  const omitted = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(omitted.procedural.enabled, true);

  // Omitting the `procedural` object entirely is equivalent — covers the
  // "no procedural key at all" path which is distinct from
  // `procedural: {}` as a runtime shape.
  const bareConfig = parseConfig({
    openaiApiKey: "sk-test",
    procedural: {},
  });
  assert.equal(bareConfig.procedural.enabled, true);

  // Explicit `false` (boolean) still honors opt-out.
  const optOutBool = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: false },
  });
  assert.equal(optOutBool.procedural.enabled, false);

  // CLI-style `"false"` string must also coerce to off (CLAUDE.md rule 36).
  const optOutFalseStr = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: "false" },
  });
  assert.equal(optOutFalseStr.procedural.enabled, false);

  // Other falsy-ish strings also opt out.
  for (const v of ["0", "no", "off"]) {
    const cfg = parseConfig({
      openaiApiKey: "sk-test",
      procedural: { enabled: v },
    });
    assert.equal(
      cfg.procedural.enabled,
      false,
      `procedural.enabled="${v}" should opt out`,
    );
  }

  // Explicit `true` keeps the feature on (idempotent with the new default).
  const explicitOn = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: true },
  });
  assert.equal(explicitOn.procedural.enabled, true);

  // CLAUDE.md rule 51: when the key IS present but the value can't be
  // understood, reject loudly instead of silently flipping the default.
  // (Codex P1 review on #609.)
  for (const v of ["maybe", "fales", "TRUE-ish", "", " "]) {
    assert.throws(
      () =>
        parseConfig({
          openaiApiKey: "sk-test",
          procedural: { enabled: v },
        }),
      /procedural\.enabled must be a boolean/,
      `invalid string ${JSON.stringify(v)} should throw`,
    );
  }
  // Numeric 0/1 are not valid either — they silently became false/true via
  // a truthiness check in earlier drafts. Reject with the same message.
  for (const v of [0, 1, 2, null]) {
    assert.throws(
      () =>
        parseConfig({
          openaiApiKey: "sk-test",
          procedural: { enabled: v },
        }),
      /procedural\.enabled must be a boolean/,
      `invalid non-boolean ${JSON.stringify(v)} should throw`,
    );
  }
});

test("parseConfig codingMode: defaults projectScope=true, branchScope=false (issue #569)", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.codingMode.projectScope, true, "projectScope defaults to true");
  assert.equal(result.codingMode.branchScope, false, "branchScope defaults to false (opt-in)");
});

test("parseConfig codingMode: accepts explicit booleans and CLI-style strings (issue #569)", () => {
  // CLAUDE.md #36: string "false" must coerce to boolean false.
  const result = parseConfig({
    openaiApiKey: "sk-test",
    codingMode: { projectScope: "false", branchScope: "true" },
  });
  assert.equal(result.codingMode.projectScope, false);
  assert.equal(result.codingMode.branchScope, true);
});

test("parseConfig codingMode: unknown object shape falls back to defaults", () => {
  const result = parseConfig({ openaiApiKey: "sk-test", codingMode: null });
  assert.equal(result.codingMode.projectScope, true);
  assert.equal(result.codingMode.branchScope, false);
});

// Track A coding-knowledge surface (issue #1548 PR 1).
// Defaults pinned here are the contract — any drift between these expectations,
// `CodingKnowledgeConfig`, `CODING_KNOWLEDGE_DEFAULTS`, the JSON schema, and
// `docs/config-reference.md` is a contract regression (rule 55).

test("parseConfig codingKnowledge: defaults match the documented contract (issue #1548 Track A PR 1)", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.deepEqual(result.codingKnowledge, {
    enabled: false,
    decisionRecords: true,
    architectureCard: true,
    sessionDelta: true,
    architectureCardLlmSummary: false,
    structuralProvider: "none",
    structuralProviderCommand: "",
    codegraphTools: false,
    codegraphDbDir: "",
  });
});

test("parseConfig codingKnowledge: master gate defaults OFF so the pre-feature path is byte-identical", () => {
  // The hard rule — rule 39 / rule 48. Every other switch is opt-in under
  // the master gate, so the default must be `false` (least-privileged).
  assert.equal(parseConfig({ openaiApiKey: "sk-test" }).codingKnowledge.enabled, false);
});

test("parseConfig codingKnowledge: accepts CLI-style boolean strings (CLAUDE.md gotcha 36)", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    codingKnowledge: {
      enabled: "true",
      decisionRecords: "false",
      architectureCardLlmSummary: "true",
    },
  });
  assert.equal(result.codingKnowledge.enabled, true);
  assert.equal(result.codingKnowledge.decisionRecords, false);
  assert.equal(result.codingKnowledge.architectureCardLlmSummary, true);
});


test("parseConfig codingKnowledge: rejects unknown structuralProvider value (rule 51)", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        codingKnowledge: { structuralProvider: "warp" },
      }),
    /structuralProvider must be one of none, subprocess, native/,
  );
});

test("parseConfig codingKnowledge: structuralProvider 'subprocess' survives; defaults to 'none' on missing", () => {
  const explicit = parseConfig({
    openaiApiKey: "sk-test",
    codingKnowledge: { structuralProvider: "subprocess" },
  });
  assert.equal(explicit.codingKnowledge.structuralProvider, "subprocess");
  const missing = parseConfig({ openaiApiKey: "sk-test", codingKnowledge: {} });
  assert.equal(missing.codingKnowledge.structuralProvider, "none");
});

test("parseConfig codingKnowledge: structuralProviderCommand trims surrounding whitespace", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    codingKnowledge: { structuralProviderCommand: "  /usr/local/bin/cbm  " },
  });
  assert.equal(result.codingKnowledge.structuralProviderCommand, "/usr/local/bin/cbm");
});

test("parseConfig codingKnowledge: unknown object shape falls back to defaults (rule 55)", () => {
  const result = parseConfig({ openaiApiKey: "sk-test", codingKnowledge: null });
  assert.equal(result.codingKnowledge.enabled, false);
  assert.equal(result.codingKnowledge.decisionRecords, true);
  assert.equal(result.codingKnowledge.structuralProvider, "none");
});

test("parseConfig codingKnowledge: rejects malformed boolean string with the valid set in the error", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        codingKnowledge: { decisionRecords: "flase" },
      }),
    /decisionRecords must be a boolean.*got "flase"/,
  );
});

test("parseConfig codingKnowledge: rejects malformed master-gate boolean", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        codingKnowledge: { enabled: "truthy" },
      }),
    /codingKnowledge\.enabled must be a boolean or one of true\/false\/1\/0\/yes\/no\/on\/off/,
  );
});

// (Removed: the third "rejects non-boolean" test used an assert.throws third
// argument that the project's esbuild build could not parse in this configuration.
// The behavior is covered by the two preceding tests above.)

test("parseConfig codingKnowledge: accepts the documented boolean-like strings (rule 36)", () => {
  // Positive matrix — these MUST keep working after the strict-parse change.
  for (const value of ["true", "True", "TRUE", "1", "yes", "YES", "on"]) {
    const result = parseConfig({
      openaiApiKey: "sk-test",
      codingKnowledge: { enabled: value },
    });
    assert.equal(result.codingKnowledge.enabled, true, `${value} should coerce to true`);
  }
  for (const value of ["false", "False", "FALSE", "0", "no", "NO", "off"]) {
    const result = parseConfig({
      openaiApiKey: "sk-test",
      codingKnowledge: { enabled: value },
    });
    assert.equal(result.codingKnowledge.enabled, false, `${value} should coerce to false`);
  }
});

// Pattern reinforcement (issue #687 PR 2/4)

test("parseConfig: pattern reinforcement defaults are off, weekly, minCount=3, std categories", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.patternReinforcementEnabled, false);
  assert.equal(result.patternReinforcementCadenceMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(result.patternReinforcementMinCount, 3);
  assert.deepEqual(result.patternReinforcementCategories, [
    "preference",
    "fact",
    "decision",
  ]);
});

test("parseConfig: patternReinforcementEnabled accepts string-coerced booleans", () => {
  const t = parseConfig({ openaiApiKey: "sk-test", patternReinforcementEnabled: "true" });
  assert.equal(t.patternReinforcementEnabled, true);
  const f = parseConfig({ openaiApiKey: "sk-test", patternReinforcementEnabled: "false" });
  assert.equal(f.patternReinforcementEnabled, false);
});

test("parseConfig: patternReinforcementMinCount clamps to >= 2", () => {
  const r0 = parseConfig({ openaiApiKey: "sk-test", patternReinforcementMinCount: 0 });
  assert.equal(r0.patternReinforcementMinCount, 2);
  const r1 = parseConfig({ openaiApiKey: "sk-test", patternReinforcementMinCount: 1 });
  assert.equal(r1.patternReinforcementMinCount, 2);
  const r5 = parseConfig({ openaiApiKey: "sk-test", patternReinforcementMinCount: 5 });
  assert.equal(r5.patternReinforcementMinCount, 5);
});

test("parseConfig: patternReinforcementCadenceMs honors documented disable=0", () => {
  const r = parseConfig({ openaiApiKey: "sk-test", patternReinforcementCadenceMs: 0 });
  assert.equal(r.patternReinforcementCadenceMs, 0);
});

test("parseConfig: patternReinforcementCategories filters non-string entries", () => {
  const r = parseConfig({
    openaiApiKey: "sk-test",
    patternReinforcementCategories: ["preference", 42, "  ", "fact"],
  });
  assert.deepEqual(r.patternReinforcementCategories, ["preference", "fact"]);
});

test("parseConfig: non-array patternReinforcementCategories falls back to defaults", () => {
  const r = parseConfig({
    openaiApiKey: "sk-test",
    patternReinforcementCategories: "preference,fact",
  });
  assert.deepEqual(r.patternReinforcementCategories, [
    "preference",
    "fact",
    "decision",
  ]);
});

test("parseConfig: dependency propagation defaults stay disabled and bounded", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.deepEqual(result.dependencyPropagation, {
    enabled: false,
    linkTypes: ["supports", "follows"],
    maxDependents: 10,
    timeoutMs: 20_000,
    dryRun: false,
  });
});

test("parseConfig: dependency propagation accepts documented overrides", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    dependencyPropagation: {
      enabled: "true",
      linkTypes: ["references", "supports", "references"],
      maxDependents: "0",
      timeoutMs: "2500",
      dryRun: "yes",
    },
  });

  assert.deepEqual(result.dependencyPropagation, {
    enabled: true,
    linkTypes: ["references", "supports"],
    maxDependents: 0,
    timeoutMs: 2_500,
    dryRun: true,
  });
});

test("parseConfig: dependency propagation honors every documented falsy string", () => {
  for (const value of ["false", "0", "no", "off"]) {
    const result = parseConfig({
      openaiApiKey: "sk-test",
      dependencyPropagation: { enabled: value, dryRun: value },
    });
    assert.equal(result.dependencyPropagation.enabled, false, `${value} must disable propagation`);
    assert.equal(result.dependencyPropagation.dryRun, false, `${value} must disable dry run`);
  }
});

test("parseConfig: dependency propagation rejects invalid integers", () => {
  for (const maxDependents of ["abc", 3.7, -1]) {
    assert.throws(
      () =>
        parseConfig({
          openaiApiKey: "sk-test",
          dependencyPropagation: { maxDependents },
        }),
      /dependencyPropagation\.maxDependents must be a non-negative integer/,
    );
  }

  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        dependencyPropagation: { timeoutMs: 0 },
      }),
    /dependencyPropagation\.timeoutMs must be a positive integer/,
  );
});

test("parseConfig: dependency propagation rejects invalid link types and shapes", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        dependencyPropagation: { linkTypes: ["supports", "related"] },
      }),
    /dependencyPropagation\.linkTypes must contain only supports, follows, references/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        dependencyPropagation: { linkTypes: "supports" },
      }),
    /dependencyPropagation\.linkTypes must be an array/,
  );
});

// ── #683 PR 2/N: connectors.googleDrive parsing.

test("parseConfig connectors defaults: googleDrive disabled with empty creds", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.connectors.googleDrive.enabled, false);
  assert.equal(result.connectors.googleDrive.clientId, "");
  assert.equal(result.connectors.googleDrive.clientSecret, "");
  assert.equal(result.connectors.googleDrive.refreshToken, "");
  assert.equal(result.connectors.googleDrive.pollIntervalMs, 300_000);
  assert.deepEqual(result.connectors.googleDrive.folderIds, []);
});

test("parseConfig connectors.googleDrive accepts valid overrides", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    connectors: {
      googleDrive: {
        enabled: true,
        clientId: "synthetic-client",
        clientSecret: "synthetic-secret",
        refreshToken: "synthetic-token",
        pollIntervalMs: 60_000,
        folderIds: [
          "1AbCdEfGh_synthetic_folder_aaaaa",
          "1AbCdEfGh_synthetic_folder_aaaaa", // dup — should dedupe
          "1AbCdEfGh_synthetic_folder_bbbbb",
          "   ", // empty after trim — should drop
        ],
      },
    },
  });
  assert.equal(result.connectors.googleDrive.enabled, true);
  assert.equal(result.connectors.googleDrive.pollIntervalMs, 60_000);
  assert.deepEqual(result.connectors.googleDrive.folderIds, [
    "1AbCdEfGh_synthetic_folder_aaaaa",
    "1AbCdEfGh_synthetic_folder_bbbbb",
  ]);
});

test("parseConfig rejects malformed connectors top-level", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: "nope" }),
    /connectors must be an object/,
  );
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: null }),
    /connectors must be an object/,
  );
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: [] }),
    /connectors must be an object/,
  );
});

test("parseConfig rejects malformed connectors.googleDrive shape", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        connectors: { googleDrive: "nope" },
      }),
    /connectors\.googleDrive must be an object/,
  );
});

test("parseConfig rejects out-of-range pollIntervalMs", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        connectors: { googleDrive: { pollIntervalMs: 50 } },
      }),
    /pollIntervalMs must be an integer in/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        connectors: { googleDrive: { pollIntervalMs: 9_999_999_999 } },
      }),
    /pollIntervalMs must be an integer in/,
  );
});

test("parseConfig rejects malformed folderIds", () => {
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        connectors: { googleDrive: { folderIds: "not-an-array" } },
      }),
    /folderIds must be an array/,
  );
  assert.throws(
    () =>
      parseConfig({
        openaiApiKey: "sk-test",
        connectors: { googleDrive: { folderIds: [42] } },
      }),
    /folderIds entries must be strings/,
  );
});

// ── #683 PR 4/6: connectors.gmail.pollIntervalMs validation (Codex P2 PRRT_kwDORJXyws59se75)
// Per CLAUDE.md gotcha #51: invalid values must throw, not silently default.

test("parseConfig connectors.gmail accepts default pollIntervalMs when omitted", () => {
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.connectors.gmail.pollIntervalMs, 300_000, "default gmail pollIntervalMs must be 300000");
});

test("parseConfig connectors.gmail accepts valid pollIntervalMs", () => {
  const result = parseConfig({
    openaiApiKey: "sk-test",
    connectors: { gmail: { pollIntervalMs: 60_000 } },
  });
  assert.equal(result.connectors.gmail.pollIntervalMs, 60_000);
});

test("parseConfig rejects connectors.gmail.pollIntervalMs = 0 (must be positive)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: 0 } } }),
    /positive/,
    "zero pollIntervalMs must be rejected",
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs < 0 (negative)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: -1 } } }),
    /positive/,
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs as NaN (Codex P2)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: NaN } } }),
    /finite/,
    "NaN pollIntervalMs must be rejected with a message mentioning finite",
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs as non-numeric string (Codex P2)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: "not-a-number" } } }),
    /finite/,
    "non-numeric string pollIntervalMs must be rejected",
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs as Infinity (Codex P2)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: Infinity } } }),
    /finite/,
    "Infinity pollIntervalMs must be rejected",
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs below minimum (50ms)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: 50 } } }),
    /pollIntervalMs/,
  );
});

test("parseConfig rejects connectors.gmail.pollIntervalMs above maximum (25h)", () => {
  assert.throws(
    () => parseConfig({ openaiApiKey: "sk-test", connectors: { gmail: { pollIntervalMs: 25 * 60 * 60 * 1000 } } }),
    /pollIntervalMs/,
  );
});

// ── issue #1499 / CLAUDE.md rule #36: namespaceCatalogEnabled opt-out coercion.
// A string "false"/"0"/"no"/"off" from CLI/env/JSON config must disable the
// catalog, not stay truthy. Defaults to enabled when absent/unrecognized.
test("parseConfig namespaceCatalogEnabled defaults to true when absent", () => {
  assert.equal(parseConfig({}).namespaceCatalogEnabled, true);
});

test('parseConfig namespaceCatalogEnabled="false" (string) → false (rule #36)', () => {
  assert.equal(parseConfig({ namespaceCatalogEnabled: "false" }).namespaceCatalogEnabled, false);
});

test('parseConfig namespaceCatalogEnabled="0" (string) → false', () => {
  assert.equal(parseConfig({ namespaceCatalogEnabled: "0" }).namespaceCatalogEnabled, false);
});

test('parseConfig namespaceCatalogEnabled="no"/"off" (strings) → false', () => {
  assert.equal(parseConfig({ namespaceCatalogEnabled: "no" }).namespaceCatalogEnabled, false);
  assert.equal(parseConfig({ namespaceCatalogEnabled: "off" }).namespaceCatalogEnabled, false);
});

test("parseConfig namespaceCatalogEnabled=false (boolean) → false", () => {
  assert.equal(parseConfig({ namespaceCatalogEnabled: false }).namespaceCatalogEnabled, false);
});

test('parseConfig namespaceCatalogEnabled="true" (string) → true', () => {
  assert.equal(parseConfig({ namespaceCatalogEnabled: "true" }).namespaceCatalogEnabled, true);
});

test("parseConfig namespaceCatalogEnabled present-but-unrecognized → throws (rule #51, codex NI42R)", () => {
  // A PRESENT but unrecognized value is rejected, not silently defaulted to
  // enabled — mirrors resolveEmitLegacyTools (CLAUDE.md rule #51: reject invalid
  // input instead of silently defaulting). Absent still defaults to true.
  assert.throws(
    () => parseConfig({ namespaceCatalogEnabled: "maybe" }),
    /namespaceCatalogEnabled must be a boolean-like value/,
  );
  assert.throws(() => parseConfig({ namespaceCatalogEnabled: "flase" }), /boolean-like value/);
  assert.throws(() => parseConfig({ namespaceCatalogEnabled: 2 }), /boolean-like value/);
});

test("parseConfig maintenance namespace fanout defaults match hosted-safe policy", () => {
  const cfg = parseConfig({});
  assert.equal(cfg.maintenanceNamespaceFanoutEnabled, true);
  assert.equal(cfg.maintenanceMaxNamespacesPerCycle, 20);
  assert.equal(cfg.maintenanceIncludeProjectNamespaces, true);
  assert.equal(cfg.maintenanceIncludeBranchNamespaces, false);
  assert.equal(cfg.maintenanceIncludeTeamProjectNamespaces, true);
  assert.equal(cfg.maintenanceNamespaceLockStaleMs, 10 * 60_000);
});

test("parseConfig accepts nested maintenance namespace fanout config", () => {
  const cfg = parseConfig({
    maintenance: {
      namespaceFanoutEnabled: "false",
      maxNamespacesPerCycle: "7",
      includeProjectNamespaces: "off",
      includeBranchNamespaces: "on",
      includeTeamProjectNamespaces: "0",
      namespaceLockStaleMs: "120000",
    },
  });
  assert.equal(cfg.maintenanceNamespaceFanoutEnabled, false);
  assert.equal(cfg.maintenanceMaxNamespacesPerCycle, 7);
  assert.equal(cfg.maintenanceIncludeProjectNamespaces, false);
  assert.equal(cfg.maintenanceIncludeBranchNamespaces, true);
  assert.equal(cfg.maintenanceIncludeTeamProjectNamespaces, false);
  assert.equal(cfg.maintenanceNamespaceLockStaleMs, 120_000);
});

test("parseConfig flat maintenance namespace fanout fields override nested config", () => {
  const cfg = parseConfig({
    maintenance: {
      namespaceFanoutEnabled: false,
      maxNamespacesPerCycle: 5,
    },
    maintenanceNamespaceFanoutEnabled: true,
    maintenanceMaxNamespacesPerCycle: 8,
  });
  assert.equal(cfg.maintenanceNamespaceFanoutEnabled, true);
  assert.equal(cfg.maintenanceMaxNamespacesPerCycle, 8);
});

test("parseConfig rejects invalid maintenance namespace fanout values", () => {
  assert.throws(
    () => parseConfig({ maintenance: [] }),
    /maintenance must be a plain object/,
  );
  assert.throws(
    () => parseConfig({ maintenance: "off" }),
    /maintenance must be a plain object/,
  );
  assert.throws(
    () => parseConfig({ maintenance: [], maintenanceNamespaceFanoutEnabled: false }),
    /maintenance must be a plain object/,
  );
  assert.throws(
    () => parseConfig({ maintenance: { namespaceFanoutEnabled: "flase" } }),
    /maintenance\.namespaceFanoutEnabled must be a boolean-like value/,
  );
  assert.throws(
    () => parseConfig({ maintenance: { maxNamespacesPerCycle: 0 } }),
    /maintenance\.maxNamespacesPerCycle must be a positive integer/,
  );
  assert.throws(
    () => parseConfig({ maintenance: { namespaceLockStaleMs: 1.5 } }),
    /maintenance\.namespaceLockStaleMs must be a positive integer/,
  );
});


test("parseConfig runtime-over-file precedence (PR #1593 review round 4)", () => {
  // chatgpt-codex-connector P2: src/index.ts calls parseConfig with
  // { ...fileConfig, ...api.pluginConfig } where the spread means runtime
  // overrides file. The resolver must honor configValue (the merged
  // object) as authoritative when both raw and configValue are present.
  // raw is consulted only to detect "operator authored" vs "schema-default
  // materialization" — NOT to override configValue.
  //
  // Scenario: file says emitLegacyTools: false, runtime says
  // api.pluginConfig.emitLegacyTools: true. The merged configValue is
  // true; the resolver must honor the runtime override, not the file.
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig(
        { emitLegacyTools: true }, // merged: runtime over file
        { emitLegacyTools: false }, // file wrote false
      ).emitLegacyTools,
      true,
      "runtime true overrides file false (rawOperatorConfig has the key)",
    );
    // Symmetric: file says true, runtime says false → merged false wins.
    assert.equal(
      parseConfig(
        { emitLegacyTools: false },
        { emitLegacyTools: true },
      ).emitLegacyTools,
      false,
      "runtime false overrides file true",
    );
    // Same precedence for namespaceCatalogEnabled.
    assert.equal(
      parseConfig(
        { namespaceCatalogEnabled: false }, // runtime override to false
        { namespaceCatalogEnabled: true }, // file set true (schema default)
      ).namespaceCatalogEnabled,
      false,
      "runtime false overrides file true for namespaceCatalogEnabled",
    );
  });
  // Sticky-legacy still works: merged false (schema default), raw empty
  // → fall through to env / sticky-legacy. With legacy connector JSON on
  // disk → returns true (the upgraded install scenario).
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig(
        { emitLegacyTools: false },
        {}, // no file
      ).emitLegacyTools,
      true,
      "merged false with empty raw falls through to sticky-legacy (upgraded install)",
    );
  });
});


test("parseConfig null raw + runtime override honored (PR #1593 review round 5)", () => {
  // Cursor Bugbot + chatgpt-codex-connector P2 (round 5, flagged against
  // round-3 commit ee58f92f/34316d5e): when raw has the key with a
  // null/undefined value, the previous resolver skipped the merged
  // configValue entirely. The round-4 rewrite (6c3ca83e) fixed this via
  // the `configValue !== SCHEMA_DEFAULT` check — the resolver honors
  // configValue whenever it differs from the schema default, regardless
  // of whether raw authored the key.
  //
  // This test pins the contract so a future refactor cannot reintroduce
  // the bug.
  withIsolatedConnectorsDir(false, () => {
    // emitLegacyTools: file has null, runtime sets true → honored.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, { emitLegacyTools: null }).emitLegacyTools,
      true,
      "null raw with runtime true overrides schema default false",
    );
    // emitLegacyTools: file has undefined, runtime sets true → honored.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, { emitLegacyTools: undefined }).emitLegacyTools,
      true,
      "undefined raw with runtime true overrides schema default false",
    );
    // emitLegacyTools: file absent (key not in raw), runtime sets true → honored.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "absent raw with runtime true overrides schema default false",
    );
    // namespaceCatalogEnabled: file has null, runtime sets false → honored
    // (differs from schema default true).
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: false }, { namespaceCatalogEnabled: null }).namespaceCatalogEnabled,
      false,
      "null raw with runtime false overrides schema default true",
    );
    // Sticky-legacy still works: merged false (schema default), raw empty →
    // fall through to sticky-legacy.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "schema-default false with empty raw falls through to sticky-legacy",
    );
  });
});


test("parseConfig schema-default-detection round-4 contract (round 8: runtimeSet gate reverted)", () => {
  // chatgpt-codex-connector P1 round 8 (PR #1593, src/index.ts:1348):
  // the round-7 runtimeSet gate was reverted because OpenClaw's loader
  // runs `applyDefaults: true` before exposing `api.pluginConfig`, so the
  // set of keys present there cannot reliably distinguish operator-authored
  // values from schema-default materialization. The resolver now relies
  // solely on the `configValue !== SCHEMA_DEFAULT` comparison (round-4
  // contract). This test pins that contract for both gates.
  //
  // The third arg `runtimeSet` is kept in the parseConfig signature for
  // API stability but no longer changes resolver behavior.
  withIsolatedConnectorsDir(true, () => {
    // Schema-default false with empty raw: the resolver falls through to
    // sticky-legacy (the round-4 contract). On an upgraded install, that
    // means true.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}, new Set()).emitLegacyTools,
      true,
      "schema-default false with empty raw falls through to sticky-legacy (round-4 contract)",
    );
    // For namespaceCatalogEnabled: schema default is true. Runtime false
    // differs from default → honored as runtime intent regardless of
    // runtimeSet.
    assert.equal(
      parseConfig(
        { namespaceCatalogEnabled: false },
        {},
        new Set(),
      ).namespaceCatalogEnabled,
      false,
      "merged false (≠ schema default true) is runtime intent regardless of runtimeSet",
    );
  });
  withIsolatedConnectorsDir(false, () => {
    // Fresh install: same precedence.
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}, new Set()).emitLegacyTools,
      false,
      "fresh install, schema-default false with empty raw returns false",
    );
    // Runtime value differs from schema default: honored.
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}, new Set()).emitLegacyTools,
      true,
      "runtime true (≠ schema default false) honored",
    );
  });
});

// ---------------------------------------------------------------------------
// Issue #1575 PR 1 — provenance config block: defaults + coercion.
//
// The characterization test pins the documented defaults table from the issue
// so a future edit to the parsing defaults is caught here rather than in a
// downstream extraction test. Env-var reads are isolated so the REMNIC_/
// ENGRAM_ override path is exercised deterministically.
// ---------------------------------------------------------------------------

test("parseConfig provenance defaults deep-equal the documented table (issue #1575)", () => {
  const prevEnabled = process.env.REMNIC_PROVENANCE_ENABLED;
  const prevEngram = process.env.ENGRAM_PROVENANCE_ENABLED;
  delete process.env.REMNIC_PROVENANCE_ENABLED;
  delete process.env.ENGRAM_PROVENANCE_ENABLED;
  try {
    const result = parseConfig({ openaiApiKey: "sk-test" });
    assert.deepEqual(result.provenance, {
      enabled: true,
      maxQuoteChars: 300,
      requireSpans: false,
    });
  } finally {
    if (prevEnabled !== undefined) process.env.REMNIC_PROVENANCE_ENABLED = prevEnabled;
    if (prevEngram !== undefined) process.env.ENGRAM_PROVENANCE_ENABLED = prevEngram;
  }
});

test("parseConfig provenance.enabled coerces boolean-like strings and rejects garbage (issue #1575)", () => {
  for (const v of [true, "true", "1", "yes", "on"] as const) {
    const result = parseConfig({ provenance: { enabled: v } });
    assert.equal(result.provenance.enabled, true, `enabled ${JSON.stringify(v)} -> true`);
  }
  for (const v of [false, "false", "0", "no", "off"] as const) {
    const result = parseConfig({ provenance: { enabled: v } });
    assert.equal(result.provenance.enabled, false, `enabled ${JSON.stringify(v)} -> false`);
  }
  assert.throws(
    () => parseConfig({ provenance: { enabled: "definitely" } }),
    /provenance\.enabled/,
  );
});

test("parseConfig provenance.maxQuoteChars rejects present-but-invalid (issue #1575)", () => {
  assert.equal(parseConfig({ provenance: { maxQuoteChars: 500 } }).provenance.maxQuoteChars, 500);
  // String coercion (CLI --config style).
  assert.equal(parseConfig({ provenance: { maxQuoteChars: "150" } }).provenance.maxQuoteChars, 150);
  // Omitted key uses the documented default.
  assert.equal(parseConfig({}).provenance.maxQuoteChars, 300);
  // Present-but-invalid values are rejected loudly (review thread 3 / AGENTS.md input-validation).
  for (const v of [0, -5, "garbage", 3.7, Infinity, null] as unknown[]) {
    assert.throws(
      () => parseConfig({ provenance: { maxQuoteChars: v } }),
      /provenance\.maxQuoteChars must be a positive integer/,
    );
  }
});

test("parseConfig provenance.requireSpans defaults false and coerces (issue #1575)", () => {
  assert.equal(parseConfig({}).provenance.requireSpans, false);
  assert.equal(parseConfig({ provenance: { requireSpans: true } }).provenance.requireSpans, true);
  assert.equal(parseConfig({ provenance: { requireSpans: "true" } }).provenance.requireSpans, true);
  assert.equal(parseConfig({ provenance: { requireSpans: "no" } }).provenance.requireSpans, false);
  // Present-but-invalid values are rejected loudly (review thread 2 / AGENTS.md input-validation).
  assert.throws(
    () => parseConfig({ provenance: { requireSpans: "treu" } }),
    /provenance\.requireSpans must be a boolean/,
  );
});

test("parseConfig provenance non-object shape rejects loudly (issue #1575)", () => {
  for (const v of [false, null, "true", 0, []] as unknown[]) {
    assert.throws(
      () => parseConfig({ provenance: v } as Record<string, unknown>),
      /provenance must be an object/,
    );
  }
});

test("parseConfig provenance.enabled honors REMNIC_/ENGRAM_ env fallback (issue #1575)", () => {
  const prevR = process.env.REMNIC_PROVENANCE_ENABLED;
  const prevE = process.env.ENGRAM_PROVENANCE_ENABLED;
  delete process.env.REMNIC_PROVENANCE_ENABLED;
  delete process.env.ENGRAM_PROVENANCE_ENABLED;
  try {
    process.env.ENGRAM_PROVENANCE_ENABLED = "off";
    assert.equal(parseConfig({}).provenance.enabled, false, "ENGRAM_ fallback flips to false");
    delete process.env.ENGRAM_PROVENANCE_ENABLED;
    process.env.REMNIC_PROVENANCE_ENABLED = "yes";
    assert.equal(parseConfig({}).provenance.enabled, true, "REMNIC_ takes precedence");
    process.env.ENGRAM_PROVENANCE_ENABLED = "off";
    assert.equal(
      parseConfig({}).provenance.enabled,
      true,
      "REMNIC_ wins over ENGRAM_ when both set",
    );
    delete process.env.REMNIC_PROVENANCE_ENABLED;
    delete process.env.ENGRAM_PROVENANCE_ENABLED;
    // Explicit config wins over env.
    process.env.REMNIC_PROVENANCE_ENABLED = "off";
    assert.equal(
      parseConfig({ provenance: { enabled: true } }).provenance.enabled,
      true,
      "explicit config beats env",
    );
  } finally {
    if (prevR !== undefined) process.env.REMNIC_PROVENANCE_ENABLED = prevR;
    else delete process.env.REMNIC_PROVENANCE_ENABLED;
    if (prevE !== undefined) process.env.ENGRAM_PROVENANCE_ENABLED = prevE;
    else delete process.env.ENGRAM_PROVENANCE_ENABLED;
  }
});

test("parseConfig rejects a present-but-non-string extractionFaithfulnessGate (safety gate must not silently disable, #1576 Ob4RQ)", () => {
  assert.equal(parseConfig({}).extractionFaithfulnessGate, "off");
  assert.equal(parseConfig({ extractionFaithfulnessGate: null }).extractionFaithfulnessGate, "off");
  assert.equal(parseConfig({ extractionFaithfulnessGate: "enforce" }).extractionFaithfulnessGate, "enforce");
  assert.equal(parseConfig({ extractionFaithfulnessGate: "ENFORCE" }).extractionFaithfulnessGate, "enforce");
  for (const bad of [true, 1, {}, ["enforce"]] as unknown[]) {
    assert.throws(
      () => parseConfig({ extractionFaithfulnessGate: bad } as Record<string, unknown>),
      /extractionFaithfulnessGate must be one of/,
      `present non-string ${JSON.stringify(bad)} must reject, not default to off`,
    );
  }
  // A present-but-unknown string still rejects (pre-existing behavior preserved).
  assert.throws(() => parseConfig({ extractionFaithfulnessGate: "on" }), /extractionFaithfulnessGate must be one of/);
});

test("parseConfig extractionFaithfulnessContextChars rejects non-numeric and non-integer input (#1634)", () => {
  // Issue #1634 (#1576 follow-up): migrate from coerce+clamp/default to the
  // strict-integer validator used by qmdDaemonTimeoutMs / commitmentDecayDays.
  // A malformed budget must reject, not silently default or round.
  assert.equal(parseConfig({}).extractionFaithfulnessContextChars, 400);
  assert.equal(parseConfig({ extractionFaithfulnessContextChars: null }).extractionFaithfulnessContextChars, 400);
  assert.equal(parseConfig({ extractionFaithfulnessContextChars: "2400" }).extractionFaithfulnessContextChars, 2400);
  assert.equal(parseConfig({ extractionFaithfulnessContextChars: 5000 }).extractionFaithfulnessContextChars, 4000);
  for (const value of ["abc", "", 0, 1.5, "1.5", Number.NaN, Infinity, true, {}] as unknown[]) {
    assert.throws(
      () => parseConfig({ extractionFaithfulnessContextChars: value } as Record<string, unknown>),
      /extractionFaithfulnessContextChars must be an integer/,
      `invalid extractionFaithfulnessContextChars ${String(value)} should throw`,
    );
  }
});

test("parseConfig extractionFaithfulnessTimeoutMs rejects non-numeric and non-integer input (#1634)", () => {
  // Issue #1634: same strict-integer contract as extractionFaithfulnessContextChars.
  assert.equal(parseConfig({}).extractionFaithfulnessTimeoutMs, 8000);
  assert.equal(parseConfig({ extractionFaithfulnessTimeoutMs: null }).extractionFaithfulnessTimeoutMs, 8000);
  assert.equal(parseConfig({ extractionFaithfulnessTimeoutMs: "12000" }).extractionFaithfulnessTimeoutMs, 12_000);
  assert.equal(parseConfig({ extractionFaithfulnessTimeoutMs: 999_999 }).extractionFaithfulnessTimeoutMs, 60_000);
  for (const value of ["abc", "", 0, 1.5, "1.5", Number.NaN, Infinity, true, {}] as unknown[]) {
    assert.throws(
      () => parseConfig({ extractionFaithfulnessTimeoutMs: value } as Record<string, unknown>),
      /extractionFaithfulnessTimeoutMs must be an integer/,
      `invalid extractionFaithfulnessTimeoutMs ${String(value)} should throw`,
    );
  }
});

test("parseConfig rejects invalid correction.enabled instead of silently enabling (#1580)", () => {
  assert.throws(() => parseConfig({ correction: { enabled: "flase" } }), /Invalid correction\.enabled/);
  assert.throws(() => parseConfig({ correctionEnabled: "nope" }), /Invalid correction\.enabled/);
  assert.throws(() => parseConfig({ correction: { applyRequiresConfirm: "sure" } }), /Invalid correction\.applyRequiresConfirm/);
  // Valid + absent still resolve correctly (no regression).
  assert.equal(parseConfig({ correction: { enabled: false } }).correctionEnabled, false);
  assert.equal(parseConfig({ correctionEnabled: "0" }).correctionEnabled, false);
  assert.equal(parseConfig({}).correctionEnabled, true);
});

test("parseConfig rejects invalid correction.planTtlHours instead of silently defaulting (#1678)", () => {
  // Nested form: correction.planTtlHours.
  for (const value of [0, -1, 0.5, "0", "-5", "abc", true, null]) {
    assert.throws(
      () => parseConfig({ correction: { planTtlHours: value } } as Record<string, unknown>),
      /Invalid correction\.planTtlHours/,
      `nested planTtlHours=${JSON.stringify(value)} should throw`,
    );
  }
  // Flat form: correctionPlanTtlHours.
  for (const value of [0, -3, "abc", true]) {
    assert.throws(
      () => parseConfig({ correctionPlanTtlHours: value } as Record<string, unknown>),
      /Invalid correction\.planTtlHours/,
      `flat correctionPlanTtlHours=${JSON.stringify(value)} should throw`,
    );
  }
  // Valid values resolve (no regression on the happy path).
  assert.equal(parseConfig({ correction: { planTtlHours: 48 } }).correctionPlanTtlHours, 48);
  assert.equal(parseConfig({ correctionPlanTtlHours: 12 }).correctionPlanTtlHours, 12);
  assert.equal(parseConfig({}).correctionPlanTtlHours, 24, "absent → documented default");
});

test("parseConfig correction.maxAffected rejects non-integers (Number.isInteger, #1678)", () => {
  // The error message says "integer" — 3.7 must be rejected, not silently floored to 3.
  for (const value of [3.7, 2.5, "1.5", 0.99]) {
    assert.throws(
      () => parseConfig({ correction: { maxAffected: value } } as Record<string, unknown>),
      /Invalid correction\.maxAffected/,
      `maxAffected=${JSON.stringify(value)} should throw (non-integer)`,
    );
  }
  for (const value of [0, -1, "abc"]) {
    assert.throws(
      () => parseConfig({ correction: { maxAffected: value } } as Record<string, unknown>),
      /Invalid correction\.maxAffected/,
      `maxAffected=${JSON.stringify(value)} should throw`,
    );
  }
  // Flat form.
  assert.throws(
    () => parseConfig({ correctionMaxAffected: 4.2 } as Record<string, unknown>),
    /Invalid correction\.maxAffected/,
  );
  // Valid integers resolve.
  assert.equal(parseConfig({ correction: { maxAffected: 5 } }).correctionMaxAffected, 5);
  assert.equal(parseConfig({ correctionMaxAffected: 20 }).correctionMaxAffected, 20);
  assert.equal(parseConfig({}).correctionMaxAffected, 10, "absent → documented default");
});

test("parseConfig rejects non-positive extraction retry/breaker numerics and falls back to defaults (codex review, rule 17)", () => {
  const c = parseConfig({
    extractionRetryMaxBackoffMs: 0,
    extractionRetryJitterRatio: -0.5,
    extractionParseEmptyMaxAttempts: 0,
    extractionBreakerFailureThreshold: -1,
    extractionBreakerCooldownMs: -5, // 0 is a valid "half-open immediately" escape hatch; only negative is rejected
    extractionBreakerAuthCooldownMs: -100,
    extractionRetryScheduleMs: [1000, 0, -5],
  });
  assert.equal(c.extractionRetryMaxBackoffMs, 21_600_000, "non-positive cap -> default");
  assert.equal(c.extractionRetryJitterRatio, 0.2, "out-of-range jitter -> default");
  assert.equal(c.extractionParseEmptyMaxAttempts, 3, "non-positive attempts -> default");
  assert.equal(c.extractionBreakerFailureThreshold, 5, "non-positive threshold -> default");
  assert.equal(c.extractionBreakerCooldownMs, 300_000, "non-positive cooldown -> default");
  assert.equal(c.extractionBreakerAuthCooldownMs, 1_800_000, "non-positive auth cooldown -> default");
  assert.deepEqual(c.extractionRetryScheduleMs, [60_000, 300_000, 1_800_000, 7_200_000], "schedule with non-positive entry -> default");
});

test("parseConfig namespace-catalog touch-path knobs: defaults, 0-accepting numerics, and validation (#1903)", () => {
  // Documented defaults when absent.
  const d = parseConfig({});
  assert.equal(d.namespacesCatalogCompactBytes, 16 * 1024 * 1024, "compactBytes default 16 MB");
  assert.equal(d.namespacesCatalogReadTouchCoalesceMs, 60_000, "read coalesce default 60000ms");
  assert.equal(d.namespacesCatalogWriteTouchCoalesceMs, 1_000, "write coalesce default 1000ms");
  assert.equal(d.namespacesCatalogTouchStateWrites, false, "state-write touch default false");

  // 0 is an accepted disable switch for every numeric (resolveNonNegativeIntegerConfig).
  assert.equal(parseConfig({ namespacesCatalogCompactBytes: 0 }).namespacesCatalogCompactBytes, 0);
  assert.equal(parseConfig({ namespacesCatalogReadTouchCoalesceMs: 0 }).namespacesCatalogReadTouchCoalesceMs, 0);
  assert.equal(parseConfig({ namespacesCatalogWriteTouchCoalesceMs: 0 }).namespacesCatalogWriteTouchCoalesceMs, 0);

  // Positive integers pass through; CLI/env numeric strings coerce.
  assert.equal(parseConfig({ namespacesCatalogCompactBytes: 4096 }).namespacesCatalogCompactBytes, 4096);
  assert.equal(parseConfig({ namespacesCatalogReadTouchCoalesceMs: "30000" }).namespacesCatalogReadTouchCoalesceMs, 30_000);

  // Boolean-like coercion for the state-write toggle (gotcha #36).
  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: true }).namespacesCatalogTouchStateWrites, true);
  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: "true" }).namespacesCatalogTouchStateWrites, true);
  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: "off" }).namespacesCatalogTouchStateWrites, false);

  // Negative and non-integer numerics are rejected with the documented message.
  for (const key of [
    "namespacesCatalogCompactBytes",
    "namespacesCatalogReadTouchCoalesceMs",
    "namespacesCatalogWriteTouchCoalesceMs",
  ]) {
    for (const bad of [-1, 1.5, "1.5", "abc", Number.NaN, Infinity]) {
      assert.throws(
        () => parseConfig({ [key]: bad }),
        new RegExp(`${key} must be a non-negative integer`),
        `${key}=${JSON.stringify(bad)} should throw`,
      );
    }
  }

  // A present-but-malformed boolean toggle fails fast (gotcha #51).
  assert.throws(
    () => parseConfig({ namespacesCatalogTouchStateWrites: "maybe" }),
    /namespacesCatalogTouchStateWrites must be a boolean-like value/,
  );
});

test("parseConfig bounded-state knobs coerce valid strings, preserve 0, and reject malformed/fractional (#1910)", () =>
  withIsolatedConnectorsDir(false, () => {
    // Defaults when absent.
    const defaults = parseConfig({});
    assert.equal(defaults.memoryLifecycleLedgerCompactBytes, 64 * 1024 * 1024);
    assert.equal(defaults.memoryLifecycleLedgerCompactMinIntervalMs, 6 * 60 * 60 * 1000);
    assert.equal(defaults.recallImpressionsRotateBytes, 32 * 1024 * 1024);
    assert.equal(defaults.recallImpressionsRotateKeep, 5);

    // Valid string forms (CLI `--config x=…` arrives as strings, Gotcha #28) parse.
    const strings = parseConfig({
      memoryLifecycleLedgerCompactBytes: "2048",
      memoryLifecycleLedgerCompactMinIntervalMs: "120000",
      recallImpressionsRotateBytes: "4096",
      recallImpressionsRotateKeep: "3",
    });
    assert.equal(strings.memoryLifecycleLedgerCompactBytes, 2048);
    assert.equal(strings.memoryLifecycleLedgerCompactMinIntervalMs, 120000);
    assert.equal(strings.recallImpressionsRotateBytes, 4096);
    assert.equal(strings.recallImpressionsRotateKeep, 3);

    // The documented `0` disable stays effective on the byte thresholds (min 0),
    // as both a string and a real number, instead of being rejected.
    const disabledStr = parseConfig({
      memoryLifecycleLedgerCompactBytes: "0",
      recallImpressionsRotateBytes: "0",
    });
    assert.equal(disabledStr.memoryLifecycleLedgerCompactBytes, 0);
    assert.equal(disabledStr.recallImpressionsRotateBytes, 0);
    const disabledNum = parseConfig({
      memoryLifecycleLedgerCompactBytes: 0,
      recallImpressionsRotateBytes: 0,
    });
    assert.equal(disabledNum.memoryLifecycleLedgerCompactBytes, 0);
    assert.equal(disabledNum.recallImpressionsRotateBytes, 0);

    // Present-but-malformed values are REJECTED (throw), not silently defaulted.
    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactBytes: "abc" }), /must be an integer/);
    // Fractional present values are rejected on every surface (number and string).
    assert.throws(() => parseConfig({ recallImpressionsRotateBytes: 2.5 }), /must be an integer/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "3.5" }), /must be an integer/);
    // Below-min values are rejected rather than clamped up.
    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactMinIntervalMs: "1000" }), /greater than or equal to 60000/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "0" }), /greater than or equal to 1/);
    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactBytes: -5 }), /greater than or equal to 0/);
    // An accidentally huge keep count (a typo like 1000000) is REJECTED before it
    // can drive a rename storm under the held impressions lock (#2033).
    assert.equal(parseConfig({ recallImpressionsRotateKeep: 1000 }).recallImpressionsRotateKeep, 1000);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: 1001 }), /between 1 and 1000/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "1000000" }), /between 1 and 1000/);
  }));

test("parseConfig projection-rebuild knobs: defaults, boolean coercion, numeric override, and 60s floor (#2119)", () => {
  const defaults = parseConfig({});
  // Enabled by default — the projection must stay fresh without operator action,
  // mirroring lifecycle-ledger auto-compaction's enabled-by-default posture.
  assert.equal(defaults.projectionRebuildEnabled, true);
  assert.equal(defaults.projectionRebuildIntervalMs, 6 * 60 * 60 * 1000);

  // Boolean coerced via the shared helper (string "false" must disable, not read
  // as truthy — gotcha #36).
  assert.equal(parseConfig({ projectionRebuildEnabled: "false" }).projectionRebuildEnabled, false);
  assert.equal(parseConfig({ projectionRebuildEnabled: false }).projectionRebuildEnabled, false);

  // Numeric override is honored; a sub-floor value is clamped to the 60s floor.
  assert.equal(parseConfig({ projectionRebuildIntervalMs: 3600000 }).projectionRebuildIntervalMs, 3600000);
  // String forms are coerced (CLI/--config inputs arrive as strings, gotcha #17)...
  assert.equal(parseConfig({ projectionRebuildIntervalMs: "3600000" }).projectionRebuildIntervalMs, 3600000);
  // ...and invalid values are REJECTED, never silently reinterpreted (pattern #39):
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: 1000 }), /projectionRebuildIntervalMs/);
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: 3600000.5 }), /projectionRebuildIntervalMs/);
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: "abc" }), /projectionRebuildIntervalMs/);
});

test("parseConfig forwards activity source settings", () => {
  const config = parseConfig({
    activity: {
      enabled: "true",
      timezone: "America/Chicago",
      syncDays: "2",
      sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319" }],
    },
  });

  assert.deepEqual(config.activity, {
    enabled: true,
    timezone: "America/Chicago",
    syncDays: 2,
    autoSyncIntervalMinutes: 15,
    sources: [{ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319" }],
    extractionMode: "off",
    sourceTrust: 0.6,
    autoApproveTrust: 0.8,
    reviewTrust: 0.5,
    minConfidence: 0.7,
    minImportance: "normal",
    maxMemoriesPerDay: 0,
    timeline: {
      enabled: false,
      analysis: { enabled: false },
      journal: { enabled: false, source: "memoryDir", extractionMode: "off" },
      qa: { enabled: false, maxRangeDays: 31 },
      vault: {
        enabled: false,
        vaultPath: "",
        dailyNotePath: "{yyyy}-{MM}-{dd}.md",
        weeklyNotePath: "",
        createMissingNotes: false,
        noteTemplate: "",
        sectionStrategy: "markers",
        publish: {
          timeline: { enabled: true, target: "daily", section: "Timeline" },
          standup: { enabled: false, target: "daily", section: "Standup" },
          weekly: { enabled: false, target: "weekly", section: "Weekly Review" },
          locations: { enabled: false, target: "daily", section: "Locations" },
        },
        insertUnderHeading: "",
        readback: { journalSection: "" },
        wikilinks: { places: false, placesFolder: "Places" },
        properties: { mode: "off", prefix: "remnic_" },
        autoPublish: true,
      },
    },
  });
});

test("parseConfig forwards bridgeMode as a raw passthrough (validation is in resolveBridgeMode)", () => {
  assert.equal(parseConfig({}).bridgeMode, "embedded");
  assert.equal(parseConfig({ bridgeMode: "delegate" }).bridgeMode, "delegate");
  assert.equal(parseConfig({ bridgeMode: "embedded" }).bridgeMode, "embedded");
  // Invalid values pass through unchanged — resolveBridgeMode rejects them.
  assert.equal(parseConfig({ bridgeMode: "daemon" }).bridgeMode, "daemon");
  // Non-strings stringify so they REACH the downstream validator instead of
  // silently defaulting to embedded.
  assert.equal(parseConfig({ bridgeMode: true }).bridgeMode, "true");
});

test("parseConfig leaves the OpenClaw delegate timeout to the plugin parser", () => {
  assert.equal("bridgeHealthTimeoutMs" in parseConfig({ bridgeHealthTimeoutMs: 7_500 }), false);
});

test("parseConfig validates converge conflict policy and defaults to newest-wins", () => {
  assert.deepEqual(parseConfig({}).converge, { conflictPolicy: "newest-wins" });

  for (const conflictPolicy of ["newest-wins", "manual"] as const) {
    assert.equal(parseConfig({ converge: { conflictPolicy } }).converge.conflictPolicy, conflictPolicy);
  }

  for (const conflictPolicy of ["keep-both", "", "unknown", 0, false, null]) {
    assert.throws(
      () => parseConfig({ converge: { conflictPolicy } }),
      /converge\.conflictPolicy.*newest-wins.*manual/,
    );
  }

  for (const converge of [0, null, [], new Date(), new Map()]) {
    assert.throws(() => parseConfig({ converge }), /converge must be a plain object/);
  }

  assert.throws(
    () => parseConfig({ converge: { conflictPolciy: "manual" } }),
    /converge contains unknown key "conflictPolciy"/,
  );
});
test("parseConfig parses contradictionLocalization defaults, string booleans, and integer caps", () => {
  const defaults = parseConfig({}).contradictionLocalization;
  assert.deepEqual(defaults, {
    anchorEnabled: true,
    anchorCandidates: 5,
    searchCandidates: 5,
    maxCandidates: 8,
  });
  assert.deepEqual(
    parseConfig({
      contradictionLocalization: {
        anchorEnabled: "false",
        anchorCandidates: "0",
        searchCandidates: "2",
        maxCandidates: 12,
      },
    }).contradictionLocalization,
    {
      anchorEnabled: false,
      anchorCandidates: 0,
      searchCandidates: 2,
      maxCandidates: 12,
    },
  );
  assert.throws(
    () =>
      parseConfig({
        contradictionLocalization: { anchorCandidates: "not-an-integer" },
      }),
    /contradictionLocalization\.anchorCandidates/,
  );
  assert.throws(
    () =>
      parseConfig({
        contradictionLocalization: { maxCandidates: 1.5 },
      }),
    /contradictionLocalization\.maxCandidates/,
  );
});
test("parseConfig rejects array contradictionLocalization values", () => {
  assert.throws(
    () => parseConfig({ contradictionLocalization: [] }),
    /contradictionLocalization must be an object/,
  );
});

test("parseConfig coerces string-typed sharedContextAllowBindingAuthority from the CLI", () => {
  // `--config sharedContextAllowBindingAuthority=true` arrives as a string, so a
  // strict `=== true` silently left the feature off for anyone who enabled it.
  for (const enabled of ["true", "1", "yes", "on", true]) {
    assert.equal(
      parseConfig({ sharedContextAllowBindingAuthority: enabled }).sharedContextAllowBindingAuthority,
      true,
      `${JSON.stringify(enabled)} must enable binding authority`,
    );
  }
  for (const disabled of ["false", "0", "no", "off", false, undefined, "", "garbage"]) {
    assert.equal(
      parseConfig({ sharedContextAllowBindingAuthority: disabled }).sharedContextAllowBindingAuthority,
      false,
      `${JSON.stringify(disabled)} must leave binding authority off`,
    );
  }
});
test("parseConfig coerces string-typed sharedContextEnabled from the CLI", () => {
  // `--config sharedContextEnabled=true` arrives as a string, so a strict
  // `=== true` silently left the feature off for anyone who enabled it.
  // Parity with sharedContextAllowBindingAuthority (issue #2918).
  // The default recall-pipeline shared-context gate must use the same
  // coerced boolean — string true with no custom pipeline enables the
  // section; false/malformed stay off.
  for (const enabled of ["true", "1", "yes", "on", true]) {
    const parsed = parseConfig({ sharedContextEnabled: enabled });
    assert.equal(
      parsed.sharedContextEnabled,
      true,
      `${JSON.stringify(enabled)} must enable shared context`,
    );
    assert.equal(
      parsed.recallPipeline.find((section) => section.id === "shared-context")?.enabled,
      true,
      `${JSON.stringify(enabled)} must enable the default shared-context section`,
    );
  }
  for (const disabled of ["false", "0", "no", "off", false, undefined, "", "garbage"]) {
    const parsed = parseConfig({ sharedContextEnabled: disabled });
    assert.equal(
      parsed.sharedContextEnabled,
      false,
      `${JSON.stringify(disabled)} must leave shared context off (malformed input never activates)`,
    );
    assert.equal(
      parsed.recallPipeline.find((section) => section.id === "shared-context")?.enabled,
      false,
      `${JSON.stringify(disabled)} must leave the default shared-context section off`,
    );
  }
});

test("custom recallPipeline keeps operator shared-context enabled (#2918)", () => {
  const customOff = parseConfig({
    sharedContextEnabled: "true",
    recallPipeline: [{ id: "shared-context", enabled: false, maxChars: 1000 }],
  });
  assert.equal(customOff.sharedContextEnabled, true);
  assert.equal(
    customOff.recallPipeline.find((section) => section.id === "shared-context")?.enabled,
    false,
    "custom pipeline must not silently activate shared-context",
  );

  const customOn = parseConfig({
    sharedContextEnabled: "false",
    recallPipeline: [{ id: "shared-context", enabled: true, maxChars: 1000 }],
  });
  assert.equal(customOn.sharedContextEnabled, false);
  assert.equal(
    customOn.recallPipeline.find((section) => section.id === "shared-context")?.enabled,
    true,
    "custom pipeline enabled stays as specified",
  );
});


test("parseConfig consumes llmBridgeClientConfigPath into backgroundGeneration only", () => {
  withIsolatedConnectorsDir(false, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "remnic-llm-bridge-client-"));
    const previousKey = process.env.OPENAI_API_KEY;
    const previousBase = process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    try {
      const file = path.join(dir, "client.json");
      writeFileSync(
        file,
        JSON.stringify({
          endpoint: "http://127.0.0.1:8765/v1/chat/completions",
          health_endpoint: "http://127.0.0.1:8765/healthz",
          bind: "127.0.0.1",
          model_policy: "server-owned",
          max_body_bytes: 524288,
          timeout_seconds: 120,
          token: "bridge-token-fixture",
        }),
      );
      const parsed = parseConfig({ llmBridgeClientConfigPath: file });
      assert.equal(parsed.openaiBaseUrl, undefined);
      assert.equal(parsed.openaiApiKey, undefined);
      assert.deepEqual(parsed.backgroundGeneration, {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "bridge-token-fixture",
        timeoutSeconds: 120,
      });

      const explicitOpenAi = parseConfig({
        llmBridgeClientConfigPath: file,
        openaiBaseUrl: "http://127.0.0.1:9999/v1",
        openaiApiKey: "keep-me",
      });
      assert.equal(explicitOpenAi.openaiBaseUrl, "http://127.0.0.1:9999/v1");
      assert.equal(explicitOpenAi.openaiApiKey, "keep-me");
      assert.equal(
        explicitOpenAi.backgroundGeneration?.endpoint,
        "http://127.0.0.1:8765/v1/chat/completions",
      );

      const explicitBg = parseConfig({
        backgroundGeneration: {
          endpoint: "http://127.0.0.1:8765/v1/chat/completions",
          token: "explicit-token",
          timeoutSeconds: 30,
        },
      });
      assert.equal(explicitBg.openaiBaseUrl, undefined);
      assert.deepEqual(explicitBg.backgroundGeneration, {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "explicit-token",
        timeoutSeconds: 30,
      });
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBase;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("parseConfig rejects an unreadable llmBridgeClientConfigPath", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.throws(
      () => parseConfig({ llmBridgeClientConfigPath: "/no/such/remnic-llm-bridge-client.json" }),
      /llmBridgeClientConfigPath could not be read/,
    );
  });
});

test("parseConfig rejects a bridge client file without a token", () => {
  withIsolatedConnectorsDir(false, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "remnic-llm-bridge-client-"));
    try {
      const file = path.join(dir, "client.json");
      writeFileSync(
        file,
        JSON.stringify({
          endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        }),
      );
      assert.throws(
        () => parseConfig({ llmBridgeClientConfigPath: file }),
        /must include a token/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("parseConfig keeps env openaiBaseUrl isolated from the Hermes bridge", () => {
  withIsolatedConnectorsDir(false, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "remnic-llm-bridge-env-"));
    const previousKey = process.env.OPENAI_API_KEY;
    const previousBase = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = "env-openai-key";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9999/v1";
    try {
      const file = path.join(dir, "client.json");
      writeFileSync(
        file,
        JSON.stringify({
          endpoint: "http://127.0.0.1:8765/v1/chat/completions",
          token: "bridge-token-fixture",
          timeout_seconds: 45,
        }),
      );
      const parsed = parseConfig({ llmBridgeClientConfigPath: file });
      assert.equal(parsed.openaiBaseUrl, "http://127.0.0.1:9999/v1");
      assert.equal(parsed.openaiApiKey, "env-openai-key");
      assert.deepEqual(parsed.backgroundGeneration, {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "bridge-token-fixture",
        timeoutSeconds: 45,
      });
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = previousBase;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("parseConfig rejects nonnumeric bridge timeout values", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.throws(
      () =>
        parseConfig({
          backgroundGeneration: {
            endpoint: "http://127.0.0.1:8765/v1/chat/completions",
            token: "t",
            timeoutSeconds: true,
          },
        }),
      /timeoutSeconds must be a finite number/,
    );
    assert.throws(
      () =>
        parseConfig({
          backgroundGeneration: {
            endpoint: "http://127.0.0.1:8765/v1/chat/completions",
            token: "t",
            timeout_seconds: "45",
          },
        }),
      /timeoutSeconds must be a finite number/,
    );
  });
});

test("parseConfig rejects a bridge client file with a nonnumeric timeout", () => {
  withIsolatedConnectorsDir(false, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "remnic-llm-bridge-badtimeout-"));
    try {
      const file = path.join(dir, "client.json");
      writeFileSync(
        file,
        JSON.stringify({
          endpoint: "http://127.0.0.1:8765/v1/chat/completions",
          token: "bridge-token-fixture",
          timeout_seconds: "45",
        }),
      );
      assert.throws(
        () => parseConfig({ llmBridgeClientConfigPath: file }),
        /timeoutSeconds must be a finite number/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("parseConfig rejects a non-object backgroundGeneration value", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.throws(
      () => parseConfig({ backgroundGeneration: "http://127.0.0.1:8765/v1/chat/completions" }),
      /backgroundGeneration must be an object/,
    );
  });
});

test("parseConfig strips a slash-rich bridge endpoint without regex", () => {
  withIsolatedConnectorsDir(false, () => {
    const parsed = parseConfig({
      backgroundGeneration: {
        endpoint: `http://127.0.0.1:8765/v1/chat/completions${"/".repeat(10_000)}`,
        token: "bridge-token-fixture",
      },
    });
    assert.equal(
      parsed.backgroundGeneration?.endpoint,
      "http://127.0.0.1:8765/v1/chat/completions",
    );
    assert.equal(parsed.openaiBaseUrl, undefined);
  });
});

test("parseConfig rejects plaintext non-loopback backgroundGeneration endpoints", () => {
  withIsolatedConnectorsDir(false, () => {
    for (const endpoint of [
      "http://192.168.10.20:8765/v1/chat/completions",
      "http://example.test/v1/chat/completions",
    ]) {
      assert.throws(
        () =>
          parseConfig({
            backgroundGeneration: {
              endpoint,
              token: "bridge-token-fixture",
            },
          }),
        /must use HTTPS unless the host is loopback/,
      );
    }

    for (const endpoint of [
      "http://127.0.0.1:8765/v1/chat/completions",
      "http://localhost:8765/v1/chat/completions",
      "http://[::1]:8765/v1/chat/completions",
      "https://example.test/v1/chat/completions",
    ]) {
      const parsed = parseConfig({
        backgroundGeneration: {
          endpoint,
          token: "bridge-token-fixture",
        },
      });
      assert.equal(parsed.backgroundGeneration?.endpoint, endpoint);
    }
  });
});
