import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";

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
