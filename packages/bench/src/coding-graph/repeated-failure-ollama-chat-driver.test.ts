import assert from "node:assert/strict";
import test from "node:test";
import {
  RepeatedFailureOllamaChatDriver,
  createRepeatedFailureOllamaChatDriver,
  validateOllamaChatEndpoint,
} from "./repeated-failure-ollama-chat-driver.js";
import type {
  ControlledResponsesCaps,
  ControlledResponsesToolDefinition as RepeatedFailureToolDefinition,
  ControlledResponsesTransport,
  RepeatedFailureActionEvaluator,
  RepeatedFailureLocalToolHost,
} from "./repeated-failure-responses-driver.js";
import type {
  RepeatedFailureEpisodeInput,
  RepeatedFailureProposedAction,
} from "./repeated-failure-types.js";

const TEST_PROFILE_ID = "ollama-chat-llama3.1-8b";
const TEST_PROFILE_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const defaultCaps: ControlledResponsesCaps = {
  maxTurns: 5,
  maxToolCalls: 5,
  maxTotalTokens: 10_000,
  maxDurationMs: 10_000,
  requestTimeoutMs: 5_000,
};

const dummyTool: RepeatedFailureToolDefinition = {
  name: "read_file",
  description: "Read a file from disk",
  gateEligible: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const makeMockToolHost = (
  tools: readonly RepeatedFailureToolDefinition[] = [dummyTool],
  executeImpl?: (action: RepeatedFailureProposedAction) => Promise<{ status: "completed" | "failed"; output: unknown }>,
): RepeatedFailureLocalToolHost => ({
  tools: tools.map((t) => ({ ...t, gateEligible: true })),
  execute: executeImpl
    ? async (action) => executeImpl(action)
    : async (action) => ({ status: "completed", output: { ok: true, path: action.arguments.path } }),
  captureFinalEvidence: async () => ({
    repoHash: TEST_PROFILE_HASH,
    checkResult: "FIXED",
    changedFiles: ["src/index.ts"],
  }),
});

const makeMockEvaluator = (
  status: "NO_MATCH" | "MATCH_WARN" = "NO_MATCH",
  advisoryText?: string,
): RepeatedFailureActionEvaluator => ({
  evaluate: async (action) => ({
    status,
    fingerprintHash: `fp_${action.tool}`,
    ...(advisoryText ? { advisoryText } : {}),
  }),
});

test("validateOllamaChatEndpoint accepts native Ollama endpoints and rejects OpenAI /v1 paths", () => {
  assert.equal(validateOllamaChatEndpoint("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(validateOllamaChatEndpoint("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434");
  assert.equal(validateOllamaChatEndpoint("https://ollama.internal.net/api/chat/"), "https://ollama.internal.net");

  assert.throws(
    () => validateOllamaChatEndpoint("http://127.0.0.1:11434/v1"),
    /Provider 'ollama-chat' requires a native Ollama endpoint.*rejects OpenAI compatibility paths/,
  );
  assert.throws(
    () => validateOllamaChatEndpoint("http://localhost:11434/v1/responses"),
    /Provider 'ollama-chat' requires a native Ollama endpoint/,
  );
  assert.throws(
    () => validateOllamaChatEndpoint("https://api.openai.com/v1/chat/completions"),
    /Provider 'ollama-chat' requires a native Ollama endpoint/,
  );
});

test("RepeatedFailureOllamaChatDriver constructor enforces honest endpoint contract", () => {
  assert.throws(
    () =>
      new RepeatedFailureOllamaChatDriver({
        model: "llama3.1",
        modelProfileId: TEST_PROFILE_ID,
        modelProfileHash: TEST_PROFILE_HASH,
        endpoint: "http://127.0.0.1:11434/v1",
      }),
    /Provider 'ollama-chat' requires a native Ollama endpoint/,
  );
});

test("RepeatedFailureOllamaChatDriver sends exact options.seed on native POST /api/chat request", async () => {
  let capturedUrl = "";
  const capturedBodies: Array<{
    model?: string;
    think?: boolean;
    options?: { seed?: number; temperature?: number; num_predict?: number };
    stream?: boolean;
  }> = [];

  const mockTransport: ControlledResponsesTransport = async (url, init) => {
    capturedUrl = url;
    capturedBodies.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({
        model: "llama3.1",
        message: { role: "assistant", content: "Done analysis" },
        done: true,
        prompt_eval_count: 50,
        eval_count: 20,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    endpoint: "http://127.0.0.1:11434",
    transport: mockTransport,
    maxOutputTokens: 2048,
    think: false,
  });

  const input: RepeatedFailureEpisodeInput = {
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 4242,
      arm: "TURN_START_SUCCESS",
    },
    prompt: "Fix the bug",
    caps: defaultCaps,
    toolHost: makeMockToolHost(),
    evaluator: makeMockEvaluator(),
  };

  const result = await driver.runEpisode(input);

  assert.equal(result.status, "COMPLETED");
  assert.equal(capturedUrl, "http://127.0.0.1:11434/api/chat");
  const capturedBody = capturedBodies[0];
  assert.ok(capturedBody);
  assert.ok(capturedBody.options);
  assert.equal(capturedBody.model, "llama3.1");
  assert.equal(capturedBody.options.seed, 4242);
  assert.equal(capturedBody.options.temperature, 0);
  assert.equal(capturedBody.options.num_predict, 2048);
  assert.equal(capturedBody.think, false);
  assert.equal(capturedBody.stream, false);
});

test("RepeatedFailureOllamaChatDriver formats tools array with nested function schema", async () => {
  const capturedBodies: Array<{
    tools?: Array<{
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }>;
  }> = [];

  const mockTransport: ControlledResponsesTransport = async (_url, init) => {
    capturedBodies.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({
        model: "llama3.1",
        message: { role: "assistant", content: "No tools needed" },
        done: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport: mockTransport,
  });

  await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 123,
      arm: "NO_MEMORY",
    },
    prompt: "Inspect code",
    caps: defaultCaps,
    toolHost: makeMockToolHost([dummyTool]),
    evaluator: makeMockEvaluator(),
  });

  const capturedBody = capturedBodies[0];
  assert.ok(capturedBody);
  assert.ok(Array.isArray(capturedBody.tools));
  assert.equal(capturedBody.tools.length, 1);
  assert.equal(capturedBody.tools[0].type, "function");
  assert.equal(capturedBody.tools[0].function.name, "read_file");
  assert.equal(capturedBody.tools[0].function.description, "Read a file from disk");
  assert.deepEqual(capturedBody.tools[0].function.parameters, dummyTool.inputSchema);
});

test("RepeatedFailureOllamaChatDriver handles multi-turn tool calls and usage aggregation", async () => {
  let requestCount = 0;
  const capturedBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];

  const mockTransport: ControlledResponsesTransport = async (_url, init) => {
    requestCount += 1;
    capturedBodies.push(JSON.parse(init.body as string));

    if (requestCount === 1) {
      return new Response(
        JSON.stringify({
          model: "llama3.1",
          message: {
            role: "assistant",
            content: "Checking file...",
            tool_calls: [
              {
                function: {
                  name: "read_file",
                  arguments: { path: "src/bug.ts" },
                },
              },
            ],
          },
          done: true,
          prompt_eval_count: 100,
          eval_count: 30,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        model: "llama3.1",
        message: {
          role: "assistant",
          content: "The file was read successfully.",
        },
        done: true,
        prompt_eval_count: 200,
        eval_count: 40,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolHost = makeMockToolHost([dummyTool]);
  const evaluator = makeMockEvaluator();

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport: mockTransport,
  });

  const result = await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 99,
      arm: "BOTH",
    },
    prompt: "Fix bug in src/bug.ts",
    caps: defaultCaps,
    toolHost,
    evaluator,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(requestCount, 2);
  assert.equal(result.responses.length, 2);
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0]?.tool, "read_file");

  assert.equal(result.usage.input, 300);
  assert.equal(result.usage.output, 70);
  assert.equal(result.usage.total, 370);

  const secondMessages = capturedBodies[1].messages;
  assert.deepEqual(secondMessages.map((message) => message.role), ["user", "assistant", "tool"]);
  const toolMsg = secondMessages.find((message) => message.role === "tool");
  assert.ok(toolMsg);
  if (typeof toolMsg.content !== "string") throw new Error("tool message content must be a string");
  assert.match(toolMsg.content, /src\/bug\.ts/);
});

test("RepeatedFailureOllamaChatDriver handles gate warning replan flow", async () => {
  let requestCount = 0;

  const mockTransport: ControlledResponsesTransport = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(
        JSON.stringify({
          model: "llama3.1",
          message: {
            role: "assistant",
            tool_calls: [
              { function: { name: "read_file", arguments: { path: "src/warn.ts" } } },
            ],
          },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        model: "llama3.1",
        message: {
          role: "assistant",
          tool_calls: [
            { function: { name: "read_file", arguments: { path: "src/fixed.ts" } } },
          ],
        },
        done: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const toolHost = makeMockToolHost([dummyTool]);
  const evaluator = makeMockEvaluator("MATCH_WARN", "Avoid src/warn.ts!");

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport: mockTransport,
  });

  const result = await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 777,
      arm: "PRE_ACTION_FAILURE",
    },
    prompt: "Refactor codebase",
    caps: defaultCaps,
    toolHost,
    evaluator,
  });

  assert.equal(result.disposition, "CHANGED");
  assert.ok(result.originalCallId);
  assert.ok(result.replacementCallId);
  assert.notEqual(result.originalCallId, result.replacementCallId);
  assert.equal(result.gate?.status, "MATCH_WARN");
});

test("RepeatedFailureOllamaChatDriver invalidates on malformed JSON tool arguments or non-done payload", async () => {
  const mockTransportMalformed: ControlledResponsesTransport = async () => {
    return new Response(
      JSON.stringify({
        model: "llama3.1",
        message: {
          role: "assistant",
          tool_calls: [
            { function: { name: "read_file", arguments: "INVALID_JSON_HERE" } },
          ],
        },
        done: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport: mockTransportMalformed,
  });

  const result = await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 1,
      arm: "NO_MEMORY",
    },
    prompt: "Test bad json",
    caps: defaultCaps,
    toolHost: makeMockToolHost(),
    evaluator: makeMockEvaluator(),
  });

  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "FAULT");
  assert.ok(result.faults.some((f) => f.code === "MALFORMED_TOOL_ARGUMENTS"));
});

test("RepeatedFailureOllamaChatDriver classifies duration expiry as a duration cap", async () => {
  const hangingTransport: ControlledResponsesTransport = async (_url, init) => {
    const signal = init.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      const rejectAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    });
  };
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport: hangingTransport,
  });

  const result = await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 1,
      arm: "NO_MEMORY",
    },
    prompt: "Wait for the model",
    caps: { ...defaultCaps, maxDurationMs: 5 },
    toolHost: makeMockToolHost(),
    evaluator: makeMockEvaluator(),
  });

  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "CAP_EXCEEDED");
  assert.equal(result.faults.at(-1)?.code, "DURATION_CAP");
});

test("RepeatedFailureOllamaChatDriver preserves evaluator wait expiry", async () => {
  let requestCount = 0;
  const transport: ControlledResponsesTransport = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({
      model: "llama3.1",
      message: requestCount === 1
        ? {
            role: "assistant",
            tool_calls: [
              { function: { name: "read_file", arguments: { path: "src/index.ts" } } },
            ],
          }
        : { role: "assistant", content: "Done" },
      done: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    transport,
  });

  const result = await driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 2,
      arm: "PRE_ACTION_FAILURE",
    },
    prompt: "Read the file",
    caps: defaultCaps,
    toolHost: makeMockToolHost(),
    evaluator: {
      evaluate: async () => ({
        status: "ERROR_FAIL_OPEN",
        fingerprintHash: "f".repeat(64),
        waitExpired: true,
      }),
    },
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.gate?.faultCode, "GATE_WAIT_EXPIRED");
});

test("RepeatedFailureOllamaChatDriver binds provider, endpoint, model, tokenizer into profile hash contract", () => {
  const profileConfig = {
    provider: "ollama-chat",
    endpoint: "http://127.0.0.1:11434",
    model: "llama3.1-8b",
    instructions: "You are a coding assistant",
    tokenizer: { identity: "ollama-utf8", implementation: "nfkc-whitespace-v1" as const },
    seedCapability: { kind: "options_parameter" as const, requestField: "seed" as const },
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: profileConfig.model,
    modelProfileId: "ollama-chat-llama3.1-8b",
    modelProfileHash: TEST_PROFILE_HASH,
    developerInstructions: profileConfig.instructions,
    endpoint: profileConfig.endpoint,
    tokenizer: profileConfig.tokenizer,
  });

  assert.equal(driver.driverKind, "ollama-chat");
  assert.equal(driver.modelProfileId, "ollama-chat-llama3.1-8b");
  assert.equal(driver.developerInstructions, "You are a coding assistant");
  assert.equal(driver.tokenizer.identity, "ollama-utf8");
});
