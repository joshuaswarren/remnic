import assert from "node:assert/strict";
import test from "node:test";
import { prepareInjectionSuiteFreeze } from "./freeze.js";
import { DEFAULT_OLLAMA_MODEL } from "./llm-executor.js";
import type { InjectionSuiteCliInput } from "./types.js";

function input(overrides: Partial<InjectionSuiteCliInput> = {}): InjectionSuiteCliInput {
  return {
    seeds: 1,
    variantsPerFamily: 1,
    modelProfileId: "profile-a",
    outputDir: "unused-by-freeze",
    ...overrides,
  };
}

test("model profile freezes the resolved executor model, not local-dry", () => {
  const ollama = prepareInjectionSuiteFreeze(input({ executor: "ollama" }), []);
  assert.equal(ollama.profile.model, DEFAULT_OLLAMA_MODEL);
  assert.equal(ollama.profile.behaviorModel, DEFAULT_OLLAMA_MODEL);
  const compat = prepareInjectionSuiteFreeze(input({ executor: "openai-compat" }), []);
  assert.equal(compat.profile.model, DEFAULT_OLLAMA_MODEL);
  assert.equal(compat.profile.behaviorModel, DEFAULT_OLLAMA_MODEL);
});

test("local executor keeps the local-dry placeholder", () => {
  const local = prepareInjectionSuiteFreeze(input(), []);
  assert.equal(local.profile.model, "local-dry");
  assert.equal(local.profile.behaviorModel, "local-dry");
});
