import assert from "node:assert/strict";
import test from "node:test";

import { shouldEnableLocalExtractionThinking } from "./extraction.js";
import type { PluginConfig } from "./types.js";

function config(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    localLlmDisableThinking: true,
    localLlmThinkingThresholdChars: 3_000,
    ...overrides,
  } as PluginConfig;
}

test("short local extraction enables thinking when configured (#1997)", () => {
  assert.equal(shouldEnableLocalExtractionThinking(config(), 2_999), true);
});

test("length-aware local thinking stays disabled at the threshold and above (#1997)", () => {
  assert.equal(shouldEnableLocalExtractionThinking(config(), 3_000), false);
  assert.equal(shouldEnableLocalExtractionThinking(config(), 3_001), false);
});

test("disabled threshold and explicit global opt-out preserve existing behavior (#1997)", () => {
  assert.equal(shouldEnableLocalExtractionThinking(config({ localLlmThinkingThresholdChars: 0 }), 1), false);
  assert.equal(shouldEnableLocalExtractionThinking(config({ localLlmDisableThinking: false }), 1), false);
});
