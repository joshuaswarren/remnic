import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InjectionSuiteCliInput } from "./types.js";
import type {
  InjectionSuiteChatMessage,
  InjectionSuiteChatResult,
  InjectionSuiteLlmOptions,
} from "./llm-executor.js";
import { buildInjectionSuiteBehaviorMessages } from "./product-lifecycle.js";
import {
  INJECTION_SUITE_PUBLICATION_ARMS,
  injectionSuiteArmUsesFence,
} from "./types.js";
import {
  UtilityCheckpointStore,
  createInjectionSuiteBehaviorResponder,
  UTILITY_CONTRACT_FILE,
  assertUtilityContract,
  isRetryableUtilityFailure,
  providerConfig,
} from "./utility-runner.js";
import { existsSync, mkdirSync } from "node:fs";
import { DEFAULT_OLLAMA_MODEL } from "./llm-executor.js";

test("only transport execution failures are retried", () => {
  assert.equal(
    isRetryableUtilityFailure({
      details: { benchmarkFailure: { kind: "trial_execution_failure" } },
    }),
    true,
  );
  assert.equal(
    isRetryableUtilityFailure({
      details: { benchmarkFailure: { kind: "scoring_failure" } },
    }),
    false,
  );
  assert.equal(isRetryableUtilityFailure({}), false);
});

const RECALL_SENTINEL = "NOTE-e2e-deadbeef1234 projector code 7391";
const RECALLED = `Trusted notes: ${RECALL_SENTINEL}. Alice prefers email.`;
const QUESTION = "What is the projector code Alice shared?";
const FIXTURE_INPUT: InjectionSuiteCliInput = {
  seeds: 1,
  variantsPerFamily: 1,
  modelProfileId: "utility-fixture",
  outputDir: "/dev/null",
  executor: "openai-compat",
  baseUrl: "https://utility-fixture.test/v1",
  model: "utility-fixture-model",
  requestTimeoutMs: 1000,
};

interface CapturedChat {
  options: InjectionSuiteLlmOptions;
  messages: readonly InjectionSuiteChatMessage[];
}

function fakeCompleteDep(): {
  complete: (
    options: InjectionSuiteLlmOptions,
    messages: readonly InjectionSuiteChatMessage[],
  ) => Promise<InjectionSuiteChatResult>;
  chats: CapturedChat[];
} {
  const chats: CapturedChat[] = [];
  return {
    chats,
    complete: async (options, messages) => {
      chats.push({ options, messages });
      return {
        text: "fake answer",
        toolCalls: [],
        inputTokens: 1,
        outputTokens: 1,
        model: "utility-fixture-model",
      };
    },
  };
}

for (const arm of INJECTION_SUITE_PUBLICATION_ARMS) {
  test(`utility responder sends builder messages for arm ${arm}`, async () => {
    const dep = fakeCompleteDep();
    const responder = createInjectionSuiteBehaviorResponder(
      FIXTURE_INPUT,
      arm,
      { complete: dep.complete },
    );
    const response = await responder.respond(QUESTION, RECALLED);

    assert.equal(dep.chats.length, 1);
    const expected = buildInjectionSuiteBehaviorMessages(
      arm,
      RECALLED,
      QUESTION,
      injectionSuiteArmUsesFence(arm),
    );
    const captured = dep.chats[0]!;
    assert.deepEqual(captured.messages, expected);
    // Same executor contract the security rows derive; no tools for utility.
    assert.deepEqual(captured.options, {
      kind: "openai-compat",
      baseUrl: "https://utility-fixture.test/v1",
      model: "utility-fixture-model",
      requestTimeoutMs: 1000,
    });
    assert.equal(response.text, "fake answer");
  });
}

test("control-data-isolation arm answers without recalled memory", async () => {
  const dep = fakeCompleteDep();
  const responder = createInjectionSuiteBehaviorResponder(
    FIXTURE_INPUT,
    "control-data-isolation",
    { complete: dep.complete },
  );
  await responder.respond(QUESTION, RECALLED);

  assert.equal(
    JSON.stringify(dep.chats[0]!.messages).includes(RECALL_SENTINEL),
    false,
  );
});

test("none arm still answers with recalled text present", async () => {
  const dep = fakeCompleteDep();
  const responder = createInjectionSuiteBehaviorResponder(FIXTURE_INPUT, "none", {
    complete: dep.complete,
  });
  await responder.respond(QUESTION, RECALLED);

  assert.equal(
    JSON.stringify(dep.chats[0]!.messages).includes(RECALL_SENTINEL),
    true,
  );
});
test("concurrent markInFlight calls throw an ambiguous-task error instead of overwriting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "h5-util-test-"));
  const store = new UtilityCheckpointStore(dir, "fencing", 71, "locomo");
  store.markInFlight("task-a", false);
  assert.throws(
    () => store.markInFlight("task-a", false),
    /ambiguous paid utility task/,
  );
  store.markInFlight("task-a", true);
  // replace=true clears the previous marker so a subsequent claim succeeds.
  assert.doesNotThrow(() => store.markInFlight("task-a", true));
});

test("the utility judge resolves its model from the executor contract, not a literal", () => {
  const previous = process.env.REMNIC_OPENAI_COMPAT_API_KEY;
  process.env.REMNIC_OPENAI_COMPAT_API_KEY = "fixture-key";
  try {
    const compat = providerConfig(
      { ...FIXTURE_INPUT, executor: "openai-compat", baseUrl: "http://127.0.0.1:9/v1", model: undefined },
      1,
    );
    assert.equal(compat.model, DEFAULT_OLLAMA_MODEL, "documented default when --model is omitted");
    const ollama = providerConfig({ ...FIXTURE_INPUT, executor: "ollama", model: undefined }, 1);
    assert.equal(ollama.model, DEFAULT_OLLAMA_MODEL);
    const explicit = providerConfig({ ...FIXTURE_INPUT, executor: "ollama", model: "custom:latest" }, 1);
    assert.equal(explicit.model, "custom:latest");
  } finally {
    if (previous === undefined) delete process.env.REMNIC_OPENAI_COMPAT_API_KEY;
    else process.env.REMNIC_OPENAI_COMPAT_API_KEY = previous;
  }
});

test("a utility output directory is bound to its execution contract", async () => {
  const previous = process.env.REMNIC_OPENAI_COMPAT_API_KEY;
  process.env.REMNIC_OPENAI_COMPAT_API_KEY = "fixture-key";
  const dir = mkdtempSync(path.join(os.tmpdir(), "h5-util-contract-"));
  try {
    const input = { ...FIXTURE_INPUT, outputDir: dir };
    await assertUtilityContract(input, ["locomo", "drift-gen"]);
    assert.ok(existsSync(path.join(dir, UTILITY_CONTRACT_FILE)), "first run records the contract");
    await assertUtilityContract(input, ["locomo", "drift-gen"]);
    await assert.rejects(
      assertUtilityContract({ ...input, model: "other-model" }, ["locomo", "drift-gen"]),
      /different utility contract/,
      "a different model must not reuse the checkpoints",
    );
    await assert.rejects(
      assertUtilityContract(input, ["locomo"]),
      /different utility contract/,
      "a different benchmark set must not reuse the checkpoints",
    );
    await assert.rejects(
      assertUtilityContract({ ...input, limit: 5 }, ["locomo", "drift-gen"]),
      /different utility contract/,
    );
    // Checkpoints from before the contract existed are refused rather than reused.
    const legacy = mkdtempSync(path.join(os.tmpdir(), "h5-util-legacy-"));
    mkdirSync(path.join(legacy, "utility-checkpoints"), { recursive: true });
    await assert.rejects(
      assertUtilityContract({ ...input, outputDir: legacy }, ["locomo", "drift-gen"]),
      /no utility-contract.json/,
    );
  } finally {
    if (previous === undefined) delete process.env.REMNIC_OPENAI_COMPAT_API_KEY;
    else process.env.REMNIC_OPENAI_COMPAT_API_KEY = previous;
  }
});
