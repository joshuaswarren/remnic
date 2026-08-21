import assert from "node:assert/strict";
import test from "node:test";

import { parseLocalLabManifest } from "./manifest.ts";
import {
  resolveLocalLabProfile,
  resolveLocalLabRole,
} from "./resolve-local-lab-profile.ts";

function sampleManifest() {
  return parseLocalLabManifest({
    profile: "local-lab",
    responder: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "qwen3:14b",
      quantization: "Q4_K_M",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    judge: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "gemma3:27b",
      quantization: "Q4_K_M",
      ctx: 16384,
      temperature: 0,
      seed: 1573,
    },
    embedding: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:8081/v1",
      model: "bge-m3",
      ctx: 8192,
      temperature: 0,
      seed: 1573,
    },
    phases: "sequential",
  });
}

test("resolveLocalLabProfile forwards manifest temperature and seed into the resolved ProviderConfig (PR2 assertion)", () => {
  const profile = resolveLocalLabProfile(sampleManifest());

  // The ProviderConfig the runner ultimately hands to the provider factory.
  const responderConfig = profile.responder.providerConfig;
  assert.equal(
    responderConfig.temperature,
    0,
    "responder temperature must be forwarded verbatim from the manifest",
  );
  assert.equal(
    responderConfig.seed,
    1573,
    "responder seed must be forwarded verbatim from the manifest",
  );

  const judgeConfig = profile.judge.providerConfig;
  assert.equal(judgeConfig.temperature, 0);
  assert.equal(judgeConfig.seed, 1573);

  const embeddingConfig = profile.embedding?.providerConfig;
  assert.equal(embeddingConfig?.temperature, 0);
  assert.equal(embeddingConfig?.seed, 1573);
});

test("resolveLocalLabProfile maps openai-compatible → local-llm and ollama → ollama", () => {
  const profile = resolveLocalLabProfile(sampleManifest());
  assert.equal(profile.responder.providerConfig.provider, "local-llm");
  assert.equal(profile.responder.providerConfig.model, "qwen3:14b");
  assert.equal(
    profile.responder.providerConfig.baseUrl,
    "http://127.0.0.1:8080/v1",
  );

  assert.equal(profile.judge.providerConfig.provider, "ollama");
  assert.equal(profile.judge.providerConfig.model, "gemma3:27b");
  assert.equal(
    profile.judge.providerConfig.baseUrl,
    "http://127.0.0.1:11434/api",
  );
});

test("resolveLocalLabProfile does NOT persist quantization onto ProviderConfig (informational only)", () => {
  const profile = resolveLocalLabProfile(sampleManifest());
  // quantization is recorded on the resolved role (for artifacts/PR3), NOT on
  // ProviderConfig (which has no such field — adding one would be a breaking
  // change to the existing transport contract). Cast through a record to
  // verify the runtime property is absent without claiming the type has it.
  const responderCfg = profile.responder.providerConfig as unknown as Record<string, unknown>;
  assert.equal(responderCfg.quantization, undefined);
  assert.equal(profile.responder.quantization, "Q4_K_M");
});

test("resolveLocalLabProfile reflects manifest phases + hand-off notes verbatim", () => {
  const manifest = sampleManifest();
  manifest.notes = {
    responderToJudgeHandoff: "stop responder, then `ollama serve`",
  };
  const profile = resolveLocalLabProfile(manifest);
  assert.equal(profile.phases, "sequential");
  assert.equal(
    profile.notes?.responderToJudgeHandoff,
    "stop responder, then `ollama serve`",
  );
});

test("resolveLocalLabProfile is symmetric: every role resolves to itself via resolveLocalLabRole", () => {
  const manifest = sampleManifest();
  for (const role of [manifest.responder, manifest.judge, manifest.embedding!]) {
    const resolved = resolveLocalLabRole(role);
    assert.equal(resolved.temperature, role.temperature);
    assert.equal(resolved.seed, role.seed);
    assert.equal(resolved.provider, role.provider);
    assert.equal(resolved.providerConfig.model, role.model);
    // Ollama baseUrls are normalized to include /api; verify the resolved
    // baseUrl starts with the manifest-declared host.
    const baseUrl = resolved.providerConfig.baseUrl ?? "";
    assert.ok(
      baseUrl.startsWith("http://127.0.0.1:"),
      `baseUrl ${baseUrl} should start with the manifest host`,
    );
  }
});

test("resolveLocalLabRole normalizes Ollama baseUrl to include /api (codex review: #1573 PR2)", () => {
  // Regression: an Ollama role with the documented sample baseUrl
  // (http://127.0.0.1:11434, no /api) caused the provider to POST to
  // /generate instead of /api/generate (404) while preflight succeeded
  // because discoveryEndpointFor already appended /api/tags.
  const withoutApi = resolveLocalLabRole({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "gemma3:27b",
    ctx: 8192,
    temperature: 0,
    seed: 1,
  });
  assert.equal(withoutApi.providerConfig.baseUrl, "http://127.0.0.1:11434/api");
  assert.equal(withoutApi.baseUrl, "http://127.0.0.1:11434/api");

  // Already-normalized URLs are left unchanged.
  const withApi = resolveLocalLabRole({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/api",
    model: "gemma3:27b",
    ctx: 8192,
    temperature: 0,
    seed: 1,
  });
  assert.equal(withApi.providerConfig.baseUrl, "http://127.0.0.1:11434/api");

  // Trailing slash is stripped before the /api check.
  const trailingSlash = resolveLocalLabRole({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/",
    model: "gemma3:27b",
    ctx: 8192,
    temperature: 0,
    seed: 1,
  });
  assert.equal(trailingSlash.providerConfig.baseUrl, "http://127.0.0.1:11434/api");

  // openai-compatible URLs are normalized to include /v1.
  const openaiCompat = resolveLocalLabRole({
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen3:14b",
    ctx: 16384,
    temperature: 0,
    seed: 1,
  });
  assert.equal(openaiCompat.providerConfig.baseUrl, "http://127.0.0.1:8080/v1");

  // Bare-host openai-compatible URLs get /v1 appended.
  const openaiBare = resolveLocalLabRole({
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:8080",
    model: "qwen3:14b",
    ctx: 16384,
    temperature: 0,
    seed: 1,
  });
  assert.equal(openaiBare.providerConfig.baseUrl, "http://127.0.0.1:8080/v1");
});

test("resolved ProviderConfig can be passed to the real provider factory contract (rule 33: shape parity)", () => {
  // The ProviderConfig we resolve MUST be shape-compatible with what the
  // existing provider factory expects — no extra required fields, no missing
  // fields. This is the rule-33 production-signature contract.
  const profile = resolveLocalLabProfile(sampleManifest());

  // Required fields.
  assert.equal(typeof profile.responder.providerConfig.provider, "string");
  assert.equal(typeof profile.responder.providerConfig.model, "string");
  // baseUrl is set for local-lab (always required by the manifest).
  assert.equal(typeof profile.responder.providerConfig.baseUrl, "string");
  // The shape matches: provider + model + baseUrl + temperature + seed are all
  // present, and there are no API keys (manifests deliberately never carry
  // them — operator auth is out-of-band).
  assert.equal(profile.responder.providerConfig.apiKey, undefined);
});
