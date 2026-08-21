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

test("four-transcript selection matrix keeps short sparse cases in thinking mode (#1997)", () => {
  const cases = [
    { name: "sparse commitment", transcript: "A".repeat(750), thinking: true },
    { name: "sparse correction", transcript: "B".repeat(1_600), thinking: true },
    { name: "dense technical discussion", transcript: "C".repeat(3_000), thinking: false },
    { name: "dense multi-turn discussion", transcript: "D".repeat(6_000), thinking: false },
  ];

  for (const scenario of cases) {
    assert.equal(
      shouldEnableLocalExtractionThinking(config(), scenario.transcript.length),
      scenario.thinking,
      scenario.name,
    );
  }
});
