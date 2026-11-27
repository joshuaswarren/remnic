import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseConfig } from "./config.js";

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

test("parseConfig honors REMNIC_MEMORY_INJECTION_DEFENSE_MODE when the operator omits the field", () => {
  const previousMode = process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
  delete process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
  try {
    process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE = "layered";
    const resolved = parseConfig({});
    assert.equal(resolved.memoryInjectionDefenseMode, "layered");
    assert.equal(resolved.originAuthorityEnabled, true);
    assert.equal(resolved.injectionScreenEnabled, true);
    assert.equal(resolved.injectionScreenProfile, "hardened");
    const materialized = parseConfig({ memoryInjectionDefenseMode: "custom" }, {});
    assert.equal(materialized.memoryInjectionDefenseMode, "layered");
    const authored = parseConfig(
      { memoryInjectionDefenseMode: "fencing" },
      { memoryInjectionDefenseMode: "fencing" },
    );
    assert.equal(authored.memoryInjectionDefenseMode, "fencing");
  } finally {
    if (previousMode === undefined) delete process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE;
    else process.env.REMNIC_MEMORY_INJECTION_DEFENSE_MODE = previousMode;
  }
});

test("parseConfig emitLegacyTools sticky-legacy default (issue #1550)", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.equal(parseConfig({}).emitLegacyTools, false, "fresh install defaults false");
    assert.equal(parseConfig({ emitLegacyTools: null }).emitLegacyTools, false);
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(parseConfig({}).emitLegacyTools, true, "legacy connector entry keeps aliases");
    assert.equal(parseConfig({ emitLegacyTools: false }).emitLegacyTools, false);
    assert.equal(parseConfig({ emitLegacyTools: "false" }).emitLegacyTools, false);
  });
});

test("parseConfig emitLegacyTools raw-vs-effective: schema default does not block sticky legacy (#1550, PR #1593 review)", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "fresh install with schema-default false still resolves false",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: false }, { emitLegacyTools: false })
        .emitLegacyTools,
      false,
      "explicit operator opt-out via file is honored",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: "false" }, { emitLegacyTools: "true" })
        .emitLegacyTools,
      false,
      "merged value wins over raw value (runtime-over-file precedence)",
    );
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      true,
      "upgraded install with legacy connector JSON keeps aliases on",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: false }, { emitLegacyTools: false })
        .emitLegacyTools,
      false,
      "raw operator opt-out overrides sticky-legacy",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "raw merged true is operator-set even with empty raw",
    );
  });
});

test("parseConfig namespaceCatalogEnabled raw-vs-effective: schema-default hardening (#1550 class hardening)", () => {
  assert.equal(
    parseConfig({}, {}).namespaceCatalogEnabled,
    true,
    "absent from both raw and merged -> true (schema default)",
  );
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: true }, {}).namespaceCatalogEnabled,
    true,
    "merged true (schema default) with empty raw falls through to default",
  );
  assert.equal(
    parseConfig({ namespaceCatalogEnabled: false }, {}).namespaceCatalogEnabled,
    false,
    "merged false differs from schema default — runtime operator intent honored",
  );
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
  withIsolatedConnectorsDir(false, () => {
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
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "runtime true with empty raw treated as operator intent",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "merged false (schema default) with empty raw falls through to sticky-legacy",
    );
  });
});

test("parseConfig defensive null rawOperatorConfig (PR #1593 review round 3)", () => {
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, null as unknown as Record<string, unknown>).emitLegacyTools,
      false,
      "null raw with emitLegacyTools merged schema default falls through to sticky-legacy",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: true }, null as unknown as Record<string, unknown>).emitLegacyTools,
      true,
      "null raw with emitLegacyTools runtime true honored as operator intent",
    );
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: false }, null as unknown as Record<string, unknown>).namespaceCatalogEnabled,
      false,
      "null raw with namespaceCatalogEnabled runtime false honored as operator intent",
    );
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: true }, null as unknown as Record<string, unknown>).namespaceCatalogEnabled,
      true,
      "null raw with namespaceCatalogEnabled schema default true preserved",
    );
  });
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, null as unknown as Record<string, unknown>).emitLegacyTools,
      true,
      "null raw with legacy evidence keeps aliases on",
    );
  });
});

test("parseConfig emitLegacyTools coerces config/env (issue #1427)", () => {
  assert.equal(parseConfig({ emitLegacyTools: false }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "false" }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "0" }).emitLegacyTools, false);
  assert.equal(parseConfig({ emitLegacyTools: "true" }).emitLegacyTools, true);

  const prevRemnic = process.env.REMNIC_EMIT_LEGACY_TOOLS;
  const prevEngram = process.env.ENGRAM_EMIT_LEGACY_TOOLS;
  try {
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "false";
    assert.equal(parseConfig({}).emitLegacyTools, false, "REMNIC_ env disables");
    assert.equal(parseConfig({ emitLegacyTools: true }).emitLegacyTools, true, "config field wins over env");
    delete process.env.REMNIC_EMIT_LEGACY_TOOLS;
    process.env.ENGRAM_EMIT_LEGACY_TOOLS = "false";
    assert.equal(parseConfig({}).emitLegacyTools, false, "ENGRAM_ env fallback disables");
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
  for (const bad of ["fales", "maybe", 2, "2", "enabled"]) {
    assert.throws(
      () => parseConfig({ emitLegacyTools: bad }),
      /emitLegacyTools must be a boolean-like value/,
      `emitLegacyTools=${JSON.stringify(bad)} should throw`,
    );
  }
  const prev = process.env.REMNIC_EMIT_LEGACY_TOOLS;
  try {
    process.env.REMNIC_EMIT_LEGACY_TOOLS = "maybe";
    assert.throws(
      () => parseConfig({}),
      /REMNIC_EMIT_LEGACY_TOOLS must be a boolean-like value/,
    );
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
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "true" }).recallPlannerLlmEnabled, true);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "1" }).recallPlannerLlmEnabled, true);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "on" }).recallPlannerLlmEnabled, true);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "false" }).recallPlannerLlmEnabled, false);
  assert.equal(parseConfig({ recallPlannerLlmEnabled: "0" }).recallPlannerLlmEnabled, false);
});

test("parseConfig coerces boolean-like strings for all recallPlanner gates (issue #1367, gotcha #36)", () => {
  assert.equal(parseConfig({ recallPlannerShadowMode: "true" }).recallPlannerShadowMode, true);
  assert.equal(parseConfig({ recallPlannerShadowMode: "off" }).recallPlannerShadowMode, false);
  assert.equal(parseConfig({}).recallPlannerShadowMode, false);

  assert.equal(parseConfig({ recallPlannerTelemetryEnabled: "false" }).recallPlannerTelemetryEnabled, false);
  assert.equal(parseConfig({}).recallPlannerTelemetryEnabled, true);

  assert.equal(parseConfig({ recallPlannerEnabled: "false" }).recallPlannerEnabled, false);
  assert.equal(parseConfig({}).recallPlannerEnabled, true);
});

test("parseConfig recall concurrency + single-flight knobs (issue #1906)", () => {
  assert.equal(parseConfig({}).recallMaxConcurrentPerPrincipal, 4);
  assert.equal(parseConfig({}).recallSingleFlightEnabled, true);
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 0 }).recallMaxConcurrentPerPrincipal,
    0,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 1 }).recallMaxConcurrentPerPrincipal,
    1,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: "8" }).recallMaxConcurrentPerPrincipal,
    8,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 0.5 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: 3.9 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: -1 }).recallMaxConcurrentPerPrincipal,
    4,
  );
  assert.equal(
    parseConfig({ recallMaxConcurrentPerPrincipal: "abc" }).recallMaxConcurrentPerPrincipal,
    4,
  );
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

test("parseConfig qmdDaemonTimeoutMs defaults to 60000 and clamps valid integers", () => {
  assert.equal(parseConfig({}).qmdDaemonTimeoutMs, 60_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 20_000 }).qmdDaemonTimeoutMs, 20_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: "20000" }).qmdDaemonTimeoutMs, 20_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 100 }).qmdDaemonTimeoutMs, 1_000);
  assert.equal(parseConfig({ qmdDaemonTimeoutMs: 999_999 }).qmdDaemonTimeoutMs, 120_000);
});

test("parseConfig qmdDaemonTimeoutMs rejects non-numeric and non-integer input", () => {
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
  assert.deepEqual(
    parseConfig({
      taskModelChain: { primary: "fireworks/accounts/fireworks/models/glm-5p1" },
    }).taskModelChain,
    { primary: "fireworks/accounts/fireworks/models/glm-5p1" },
  );
});

test("parseConfig rejects unknown taskModelChain keys (codex review #1425)", () => {
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

  assert.equal(cfg.model, "gpt-5.5");
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
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "openrouter/my-model",
  });

  assert.equal(cfg.model, "openrouter/my-model");
  assert.equal(cfg.summaryModel, "openrouter/my-model");
  assert.equal(cfg.recallPlannerModel, "");
});

test("parseConfig treats the injected bare schema-default model as absent for gateway task routing (#1469)", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "gpt-5.5", // injected schema default, not an operator choice
    recallPlannerModel: "gpt-5.5", // injected schema default
    taskModelChain: { primary: "openrouter/deepseek/deepseek-v4-flash" },
  });

  assert.equal(cfg.model, "gpt-5.5");
  assert.equal(cfg.summaryModel, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(cfg.recallPlannerModel, "openrouter/deepseek/deepseek-v4-flash");
});

test("parseConfig drops a bare schema-default model in gateway mode with no task chain (#1469)", () => {
  const cfg = parseConfig({
    modelSource: "gateway",
    model: "gpt-5.5", // injected schema default
    recallPlannerModel: "gpt-5.5",
  });

  assert.equal(cfg.summaryModel, "");
  assert.equal(cfg.recallPlannerModel, "");
});

test("parseConfig leaves gateway task-model defaults empty without taskModelChain", () => {
  const cfg = parseConfig({ modelSource: "gateway" });

  assert.equal(cfg.model, "gpt-5.5");
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

test("parseConfig extractionJudgeTimeoutMs defaults to 20000 — compact verdict measures 2.1-2.5 s on a small fast judge model", () => {
  assert.equal(parseConfig({}).extractionJudgeTimeoutMs, 20_000);
});

test("parseConfig extractionJudgeTimeoutMs accepts numbers and CLI-style numeric strings", () => {
  assert.equal(parseConfig({ extractionJudgeTimeoutMs: 45_000 }).extractionJudgeTimeoutMs, 45_000);
  assert.equal(parseConfig({ extractionJudgeTimeoutMs: "90000" }).extractionJudgeTimeoutMs, 90_000);
});

test("parseConfig extractionJudgeTimeoutMs falls back to the default on unusable values and caps the top", () => {
  for (const value of [0, -1, Number.NaN, "abc"]) {
    assert.equal(parseConfig({ extractionJudgeTimeoutMs: value }).extractionJudgeTimeoutMs, 20_000);
  }
  assert.equal(parseConfig({ extractionJudgeTimeoutMs: 10_000_000 }).extractionJudgeTimeoutMs, 3_600_000);
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


test("parseConfig localLlmDisableThinking defaults to true (issue #548)", () => {
  const result = parseConfig({});
  assert.equal(result.localLlmDisableThinking, true);
});

test("parseConfig localLlmDisableThinking=false preserves operator opt-out", () => {
  const result = parseConfig({ localLlmDisableThinking: false });
  assert.equal(result.localLlmDisableThinking, false);
});

test('parseConfig localLlmDisableThinking="false" (CLI string) coerces to boolean false (rule 36)', () => {
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
  const result = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(result.procedural.minOccurrences, 3);
  assert.equal(result.procedural.successFloor, 0.75);
  assert.equal(result.procedural.autoPromoteOccurrences, 8);
  assert.equal(result.procedural.lookbackDays, 14);
  assert.equal(result.procedural.recallMaxProcedures, 2);
});

test("buildDefaultRecallPipeline enables procedure-recall when procedural default-on (issue #567 PR 4/5)", () => {
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
  const blank = parseConfig({ openaiApiKey: "sk-test", procedural: {} });
  assert.equal(blank.procedural.enabled, true);
});

test("conservative memoryOsPreset keeps procedural.enabled off after default flip (issue #567 PR 4/5)", () => {
  const cfg = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
  });
  assert.equal(cfg.procedural.enabled, false);

  const optedIn = parseConfig({
    openaiApiKey: "sk-test",
    memoryOsPreset: "conservative",
    procedural: { enabled: true },
  });
  assert.equal(optedIn.procedural.enabled, true);

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
  const omitted = parseConfig({ openaiApiKey: "sk-test" });
  assert.equal(omitted.procedural.enabled, true);

  const bareConfig = parseConfig({
    openaiApiKey: "sk-test",
    procedural: {},
  });
  assert.equal(bareConfig.procedural.enabled, true);

  const optOutBool = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: false },
  });
  assert.equal(optOutBool.procedural.enabled, false);

  const optOutFalseStr = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: "false" },
  });
  assert.equal(optOutFalseStr.procedural.enabled, false);

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

  const explicitOn = parseConfig({
    openaiApiKey: "sk-test",
    procedural: { enabled: true },
  });
  assert.equal(explicitOn.procedural.enabled, true);

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

test("parseConfig connectors.googleDrive keeps a SecretRef credential verbatim", () => {
  const secretRef = { source: "keychain", id: "projects/drive-secret" };
  const result = parseConfig({
    openaiApiKey: "sk-test",
    connectors: {
      googleDrive: {
        enabled: true,
        clientId: "synthetic-client",
        clientSecret: secretRef,
        refreshToken: "synthetic-token",
      },
    },
  });
  assert.deepEqual(result.connectors.googleDrive.clientSecret, secretRef);
  assert.equal(result.connectors.googleDrive.clientId, "synthetic-client");
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
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig(
        { emitLegacyTools: true }, // merged: runtime over file
        { emitLegacyTools: false }, // file wrote false
      ).emitLegacyTools,
      true,
      "runtime true overrides file false (rawOperatorConfig has the key)",
    );
    assert.equal(
      parseConfig(
        { emitLegacyTools: false },
        { emitLegacyTools: true },
      ).emitLegacyTools,
      false,
      "runtime false overrides file true",
    );
    assert.equal(
      parseConfig(
        { namespaceCatalogEnabled: false }, // runtime override to false
        { namespaceCatalogEnabled: true }, // file set true (schema default)
      ).namespaceCatalogEnabled,
      false,
      "runtime false overrides file true for namespaceCatalogEnabled",
    );
  });
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
  //
  withIsolatedConnectorsDir(false, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: true }, { emitLegacyTools: null }).emitLegacyTools,
      true,
      "null raw with runtime true overrides schema default false",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: true }, { emitLegacyTools: undefined }).emitLegacyTools,
      true,
      "undefined raw with runtime true overrides schema default false",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}).emitLegacyTools,
      true,
      "absent raw with runtime true overrides schema default false",
    );
    assert.equal(
      parseConfig({ namespaceCatalogEnabled: false }, { namespaceCatalogEnabled: null }).namespaceCatalogEnabled,
      false,
      "null raw with runtime false overrides schema default true",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}).emitLegacyTools,
      false,
      "schema-default false with empty raw falls through to sticky-legacy",
    );
  });
});


test("parseConfig schema-default-detection round-4 contract (round 8: runtimeSet gate reverted)", () => {
  //
  withIsolatedConnectorsDir(true, () => {
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}, new Set()).emitLegacyTools,
      true,
      "schema-default false with empty raw falls through to sticky-legacy (round-4 contract)",
    );
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
    assert.equal(
      parseConfig({ emitLegacyTools: false }, {}, new Set()).emitLegacyTools,
      false,
      "fresh install, schema-default false with empty raw returns false",
    );
    assert.equal(
      parseConfig({ emitLegacyTools: true }, {}, new Set()).emitLegacyTools,
      true,
      "runtime true (≠ schema default false) honored",
    );
  });
});

// ---------------------------------------------------------------------------
//
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
  assert.equal(parseConfig({ provenance: { maxQuoteChars: "150" } }).provenance.maxQuoteChars, 150);
  assert.equal(parseConfig({}).provenance.maxQuoteChars, 300);
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
  assert.throws(() => parseConfig({ extractionFaithfulnessGate: "on" }), /extractionFaithfulnessGate must be one of/);
});

test("parseConfig extractionFaithfulnessContextChars rejects non-numeric and non-integer input (#1634)", () => {
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
  assert.equal(parseConfig({ correction: { enabled: false } }).correctionEnabled, false);
  assert.equal(parseConfig({ correctionEnabled: "0" }).correctionEnabled, false);
  assert.equal(parseConfig({}).correctionEnabled, true);
});

test("parseConfig rejects invalid correction.planTtlHours instead of silently defaulting (#1678)", () => {
  for (const value of [0, -1, 0.5, "0", "-5", "abc", true, null]) {
    assert.throws(
      () => parseConfig({ correction: { planTtlHours: value } } as Record<string, unknown>),
      /Invalid correction\.planTtlHours/,
      `nested planTtlHours=${JSON.stringify(value)} should throw`,
    );
  }
  for (const value of [0, -3, "abc", true]) {
    assert.throws(
      () => parseConfig({ correctionPlanTtlHours: value } as Record<string, unknown>),
      /Invalid correction\.planTtlHours/,
      `flat correctionPlanTtlHours=${JSON.stringify(value)} should throw`,
    );
  }
  assert.equal(parseConfig({ correction: { planTtlHours: 48 } }).correctionPlanTtlHours, 48);
  assert.equal(parseConfig({ correctionPlanTtlHours: 12 }).correctionPlanTtlHours, 12);
  assert.equal(parseConfig({}).correctionPlanTtlHours, 24, "absent → documented default");
});

test("parseConfig correction.classifyTimeoutMs defaults to 45000 and rejects invalid values", () => {
  assert.equal(parseConfig({}).correctionClassifyTimeoutMs, 45_000);
  assert.equal(parseConfig({ correction: { classifyTimeoutMs: 12000 } }).correctionClassifyTimeoutMs, 12_000);
  assert.equal(
    parseConfig({
      correction: { classifyTimeoutMs: 8000 },
      correctionClassifyTimeoutMs: 1000,
    }).correctionClassifyTimeoutMs,
    8000,
    "nested correction.classifyTimeoutMs wins",
  );
  assert.equal(parseConfig({ correctionClassifyTimeoutMs: 15000 }).correctionClassifyTimeoutMs, 15_000);
  for (const value of [0, -1, 3.7, "abc", 300_001, true]) {
    assert.throws(
      () => parseConfig({ correctionClassifyTimeoutMs: value } as Record<string, unknown>),
      /Invalid correction\.classifyTimeoutMs/,
      `correctionClassifyTimeoutMs=${JSON.stringify(value)} should throw`,
    );
    assert.throws(
      () => parseConfig({ correction: { classifyTimeoutMs: value } } as Record<string, unknown>),
      /Invalid correction\.classifyTimeoutMs/,
      `nested classifyTimeoutMs=${JSON.stringify(value)} should throw`,
    );
  }
});

test("parseConfig correction.maxAffected rejects non-integers (Number.isInteger, #1678)", () => {
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
  assert.throws(
    () => parseConfig({ correctionMaxAffected: 4.2 } as Record<string, unknown>),
    /Invalid correction\.maxAffected/,
  );
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
  const d = parseConfig({});
  assert.equal(d.namespacesCatalogCompactBytes, 16 * 1024 * 1024, "compactBytes default 16 MB");
  assert.equal(d.namespacesCatalogReadTouchCoalesceMs, 60_000, "read coalesce default 60000ms");
  assert.equal(d.namespacesCatalogWriteTouchCoalesceMs, 1_000, "write coalesce default 1000ms");
  assert.equal(d.namespacesCatalogTouchStateWrites, false, "state-write touch default false");

  assert.equal(parseConfig({ namespacesCatalogCompactBytes: 0 }).namespacesCatalogCompactBytes, 0);
  assert.equal(parseConfig({ namespacesCatalogReadTouchCoalesceMs: 0 }).namespacesCatalogReadTouchCoalesceMs, 0);
  assert.equal(parseConfig({ namespacesCatalogWriteTouchCoalesceMs: 0 }).namespacesCatalogWriteTouchCoalesceMs, 0);

  assert.equal(parseConfig({ namespacesCatalogCompactBytes: 4096 }).namespacesCatalogCompactBytes, 4096);
  assert.equal(parseConfig({ namespacesCatalogReadTouchCoalesceMs: "30000" }).namespacesCatalogReadTouchCoalesceMs, 30_000);

  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: true }).namespacesCatalogTouchStateWrites, true);
  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: "true" }).namespacesCatalogTouchStateWrites, true);
  assert.equal(parseConfig({ namespacesCatalogTouchStateWrites: "off" }).namespacesCatalogTouchStateWrites, false);

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

  assert.throws(
    () => parseConfig({ namespacesCatalogTouchStateWrites: "maybe" }),
    /namespacesCatalogTouchStateWrites must be a boolean-like value/,
  );
});

test("parseConfig bounded-state knobs coerce valid strings, preserve 0, and reject malformed/fractional (#1910)", () =>
  withIsolatedConnectorsDir(false, () => {
    const defaults = parseConfig({});
    assert.equal(defaults.memoryLifecycleLedgerCompactBytes, 64 * 1024 * 1024);
    assert.equal(defaults.memoryLifecycleLedgerCompactMinIntervalMs, 6 * 60 * 60 * 1000);
    assert.equal(defaults.recallImpressionsRotateBytes, 32 * 1024 * 1024);
    assert.equal(defaults.recallImpressionsRotateKeep, 5);

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

    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactBytes: "abc" }), /must be an integer/);
    assert.throws(() => parseConfig({ recallImpressionsRotateBytes: 2.5 }), /must be an integer/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "3.5" }), /must be an integer/);
    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactMinIntervalMs: "1000" }), /greater than or equal to 60000/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "0" }), /greater than or equal to 1/);
    assert.throws(() => parseConfig({ memoryLifecycleLedgerCompactBytes: -5 }), /greater than or equal to 0/);
    assert.equal(parseConfig({ recallImpressionsRotateKeep: 1000 }).recallImpressionsRotateKeep, 1000);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: 1001 }), /between 1 and 1000/);
    assert.throws(() => parseConfig({ recallImpressionsRotateKeep: "1000000" }), /between 1 and 1000/);
  }));

test("parseConfig projection-rebuild knobs: defaults, boolean coercion, numeric override, and 60s floor (#2119)", () => {
  const defaults = parseConfig({});
  assert.equal(defaults.projectionRebuildEnabled, true);
  assert.equal(defaults.projectionRebuildIntervalMs, 6 * 60 * 60 * 1000);

  assert.equal(parseConfig({ projectionRebuildEnabled: "false" }).projectionRebuildEnabled, false);
  assert.equal(parseConfig({ projectionRebuildEnabled: false }).projectionRebuildEnabled, false);

  assert.equal(parseConfig({ projectionRebuildIntervalMs: 3600000 }).projectionRebuildIntervalMs, 3600000);
  assert.equal(parseConfig({ projectionRebuildIntervalMs: "3600000" }).projectionRebuildIntervalMs, 3600000);
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: 1000 }), /projectionRebuildIntervalMs/);
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: 3600000.5 }), /projectionRebuildIntervalMs/);
  assert.throws(() => parseConfig({ projectionRebuildIntervalMs: "abc" }), /projectionRebuildIntervalMs/);

  assert.equal(defaults.projectionRebuildHeapUsageLimit, 0.6);
  assert.equal(parseConfig({ projectionRebuildHeapUsageLimit: 0.5 }).projectionRebuildHeapUsageLimit, 0.5);
  assert.equal(parseConfig({ projectionRebuildHeapUsageLimit: "0.5" }).projectionRebuildHeapUsageLimit, 0.5);
  assert.equal(parseConfig({ projectionRebuildHeapUsageLimit: 1 }).projectionRebuildHeapUsageLimit, 1);
  assert.throws(() => parseConfig({ projectionRebuildHeapUsageLimit: 0 }), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseConfig({ projectionRebuildHeapUsageLimit: -0.2 }), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseConfig({ projectionRebuildHeapUsageLimit: 1.1 }), /projectionRebuildHeapUsageLimit/);
  assert.throws(() => parseConfig({ projectionRebuildHeapUsageLimit: "abc" }), /projectionRebuildHeapUsageLimit/);
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
  assert.equal(parseConfig({ bridgeMode: "daemon" }).bridgeMode, "daemon");
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

test("parseConfig: extractionQueueConcurrency defaults to bounded-parallel 2 and validates as a positive integer", () => {
  assert.equal(parseConfig({}).extractionQueueConcurrency, 2);
  assert.equal(parseConfig({ extractionQueueConcurrency: 1 }).extractionQueueConcurrency, 1);
  assert.equal(parseConfig({ extractionQueueConcurrency: 2 }).extractionQueueConcurrency, 2);
  for (const invalid of [0, -1, 1.5, "two"]) {
    assert.throws(
      () => parseConfig({ extractionQueueConcurrency: invalid }),
      /extractionQueueConcurrency must be a positive integer/,
      `expected rejection for ${JSON.stringify(invalid)}`,
    );
  }
});
