import assert from "node:assert/strict";
import test from "node:test";
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
  createInjectionSuiteBehaviorResponder,
  isRetryableUtilityFailure,
} from "./utility-runner.js";

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
const FIXTURE_INPUT = {
  executor: "openai-compat",
  baseUrl: "https://utility-fixture.test/v1",
  model: "utility-fixture-model",
  requestTimeoutMs: 1000,
} as const;

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
