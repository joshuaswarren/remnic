import assert from "node:assert/strict";
import test from "node:test";
import * as freeze from "./freeze.js";
import { prepareInjectionSuiteFreeze } from "./freeze.js";
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENAI_COMPAT_BASE_URL } from "./llm-executor.js";
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

test("model profile freezes the resolved endpoint, and an explicit default hashes identically", () => {
  const implicit = prepareInjectionSuiteFreeze(input({ executor: "openai-compat" }), []);
  assert.equal(implicit.profile.baseUrl, DEFAULT_OPENAI_COMPAT_BASE_URL);
  const explicit = prepareInjectionSuiteFreeze(
    input({ executor: "openai-compat", baseUrl: DEFAULT_OPENAI_COMPAT_BASE_URL }),
    [],
  );
  assert.equal(explicit.profile.modelProfileHash, implicit.profile.modelProfileHash);
  const ollama = prepareInjectionSuiteFreeze(input({ executor: "ollama" }), []);
  assert.equal(ollama.profile.baseUrl, DEFAULT_OLLAMA_BASE_URL);
});

test("the identity gate holds main and pilot evidence to a digest, a context window, and no cuts", () => {
  const { enforceRunIdentityGate } = freeze;
  assert.doesNotThrow(() => enforceRunIdentityGate(input({ runKind: "dev", limit: 3 }), false));
  assert.throws(() => enforceRunIdentityGate(input({ runKind: "main" }), true), /--model-digest/);
  assert.throws(
    () => enforceRunIdentityGate(input({ runKind: "main", modelDigest: "sha256:x" }), true),
    /--model-context-tokens/,
  );
  assert.throws(
    () => enforceRunIdentityGate(input({ runKind: "main", modelDigest: "sha256:x", modelContextTokens: 32_000 }), false),
    /clean git tree/,
  );
  assert.throws(
    () => enforceRunIdentityGate(input({ runKind: "main", modelDigest: "sha256:x", modelContextTokens: 32_000, limit: 5 }), true),
    /forbids --limit/,
  );
  assert.doesNotThrow(() =>
    enforceRunIdentityGate(input({ runKind: "main", modelDigest: "sha256:x", modelContextTokens: 32_000 }), true),
  );
});
