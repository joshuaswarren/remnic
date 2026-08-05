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
const TEST_MODEL_DIGEST = "d".repeat(64);

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
  assert.equal(
    validateOllamaChatEndpoint(`http://127.0.0.1:11434${"/".repeat(100_000)}`),
    "http://127.0.0.1:11434",
  );
  assert.equal(
    validateOllamaChatEndpoint("https://ollama.internal.net////api/chat"),
    "https://ollama.internal.net",
  );
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
        modelDigest: TEST_MODEL_DIGEST,
        endpoint: "http://127.0.0.1:11434/v1",
      }),
    /Provider 'ollama-chat' requires a native Ollama endpoint/,
  );
});

test("RepeatedFailureOllamaChatDriver sends exact options.seed on native POST /api/chat request", async () => {
  let capturedUrl = "";
  let capturedRequestTimeoutMs: number | undefined;
  const capturedBodies: Array<{
    model?: string;
    think?: boolean;
    options?: { seed?: number; temperature?: number; num_predict?: number; num_ctx?: number };
    stream?: boolean;
  }> = [];

  const mockTransport: ControlledResponsesTransport = async (url, init, options) => {
    capturedUrl = url;
    capturedBodies.push(JSON.parse(init.body as string));
    capturedRequestTimeoutMs = options.timeoutMs;
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
    modelDigest: TEST_MODEL_DIGEST,
    endpoint: "http://127.0.0.1:11434",
    transport: mockTransport,
    maxOutputTokens: 2048,
    contextWindowTokens: 32768,
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
  assert.equal(capturedBody.options.num_ctx, 32768);
  assert.equal(capturedBody.think, false);
  assert.equal(capturedBody.stream, false);
  assert.equal(capturedRequestTimeoutMs, defaultCaps.requestTimeoutMs);
});

test("episode duration aborts a tool host that ignores its signal", async () => {
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    endpoint: "http://127.0.0.1:11434",
    transport: async () => new Response(JSON.stringify({
      model: "llama3.1",
      message: {
        role: "assistant",
        content: "Inspecting",
        tool_calls: [{
          function: {
            name: "read_file",
            arguments: { path: "src/index.ts" },
          },
        }],
      },
      done: true,
      prompt_eval_count: 1,
      eval_count: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  const toolHost: RepeatedFailureLocalToolHost = {
    tools: [dummyTool],
    execute: () => Promise.withResolvers<never>().promise,
    captureFinalEvidence: async () => ({
      repoHash: TEST_PROFILE_HASH,
      checkResult: "FIXED",
      changedFiles: [],
    }),
  };
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
    prompt: "Inspect code",
    caps: { ...defaultCaps, maxDurationMs: 20 },
    toolHost,
    evaluator: makeMockEvaluator(),
  });
  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "CAP_EXCEEDED");
  assert.equal(result.faults.at(-1)?.code, "DURATION_CAP");
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
        prompt_eval_count: 1,
        eval_count: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
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
  const capturedBodies: Array<{
    messages: Array<{ role: string; content?: string; tool_name?: string }>;
  }> = [];

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
    modelDigest: TEST_MODEL_DIGEST,
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
  assert.equal(toolMsg.tool_name, "read_file");
  if (typeof toolMsg.content !== "string") throw new Error("tool message content must be a string");
  assert.match(toolMsg.content, /src\/bug\.ts/);
});

test("RepeatedFailureOllamaChatDriver handles gate warning replan flow", async () => {
  let requestCount = 0;
  const capturedBodies: Array<{
    messages: Array<{ role: string; content?: string; tool_name?: string }>;
  }> = [];

  const mockTransport: ControlledResponsesTransport = async (_url, init) => {
    requestCount += 1;
    capturedBodies.push(JSON.parse(init.body as string));
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
          prompt_eval_count: 1,
          eval_count: 1,
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
        prompt_eval_count: 1,
        eval_count: 1,
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
    modelDigest: TEST_MODEL_DIGEST,
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
  const advisoryMessage = capturedBodies[1]?.messages.find((message) => message.role === "tool");
  assert.equal(advisoryMessage?.tool_name, "read_file");
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
        prompt_eval_count: 1,
        eval_count: 1,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
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
    modelDigest: TEST_MODEL_DIGEST,
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
      prompt_eval_count: 1,
      eval_count: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
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

test("RepeatedFailureOllamaChatDriver bounds a non-cooperative evaluator", async () => {
  let requestCount = 0;
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    gateWaitTimeoutMs: 5,
    transport: async () => {
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
        prompt_eval_count: 1,
        eval_count: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  // Integration coverage for the real driver deadline; the evaluator never settles.
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
    evaluator: { evaluate: () => new Promise(() => {}) },
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
    modelDigest: TEST_MODEL_DIGEST,
    developerInstructions: profileConfig.instructions,
    endpoint: profileConfig.endpoint,
    tokenizer: profileConfig.tokenizer,
  });

  assert.equal(driver.driverKind, "ollama-chat");
  assert.equal(driver.modelProfileId, "ollama-chat-llama3.1-8b");
  assert.equal(driver.developerInstructions, "You are a coding assistant");
  assert.equal(driver.tokenizer.identity, "ollama-utf8");
});

test("RepeatedFailureOllamaChatDriver times out a stalled response body", async () => {
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    transport: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
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
    prompt: "Wait for the model body",
    caps: { ...defaultCaps, requestTimeoutMs: 10 },
    toolHost: makeMockToolHost(),
    evaluator: makeMockEvaluator(),
  });

  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "FAULT");
  assert.equal(result.faults[0]?.code, "REQUEST_TIMEOUT");
});

test("RepeatedFailureOllamaChatDriver aborts during response body read", async () => {
  const { promise: bodyStarted, resolve: markBodyStarted } = Promise.withResolvers<void>();
  const driver = createRepeatedFailureOllamaChatDriver({
    model: "llama3.1",
    modelProfileId: TEST_PROFILE_ID,
    modelProfileHash: TEST_PROFILE_HASH,
    modelDigest: TEST_MODEL_DIGEST,
    transport: async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        markBodyStarted();
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  const controller = new AbortController();
  const pending = driver.runEpisode({
    identity: {
      suiteVersion: "v1",
      taskId: "task1",
      variantId: "var1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      seed: 1,
      arm: "NO_MEMORY",
    },
    prompt: "Wait for the model body",
    caps: defaultCaps,
    toolHost: makeMockToolHost(),
    evaluator: makeMockEvaluator(),
    signal: controller.signal,
  });
  await bodyStarted;
  controller.abort();

  const result = await pending;

  assert.equal(result.status, "INVALID");
  assert.equal(result.invalidReason, "ABORTED");
  assert.equal(result.faults[0]?.code, "REQUEST_ABORTED");
});

test("RepeatedFailureOllamaChatDriver rejects missing or mismatched response models", async () => {
  for (const model of [undefined, "different-model"]) {
    const driver = createRepeatedFailureOllamaChatDriver({
      model: "llama3.1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      modelDigest: TEST_MODEL_DIGEST,
      transport: async () => new Response(JSON.stringify({
        ...(model === undefined ? {} : { model }),
        message: { role: "assistant", content: "Done" },
        done: true,
        prompt_eval_count: 1,
        eval_count: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
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
      prompt: "Check model identity",
      caps: defaultCaps,
      toolHost: makeMockToolHost(),
      evaluator: makeMockEvaluator(),
    });

    assert.equal(result.status, "INVALID");
    assert.equal(result.faults[0]?.code, "MODEL_IDENTITY_MISMATCH");
  }
});

test("RepeatedFailureOllamaChatDriver rejects completed responses without token counts", async () => {
  for (const counts of [
    { eval_count: 1 },
    { prompt_eval_count: 1 },
    {},
  ]) {
    const driver = createRepeatedFailureOllamaChatDriver({
      model: "llama3.1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      modelDigest: TEST_MODEL_DIGEST,
      transport: async () => new Response(JSON.stringify({
        model: "llama3.1",
        message: { role: "assistant", content: "Done" },
        done: true,
        ...counts,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
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
      prompt: "Check usage",
      caps: defaultCaps,
      toolHost: makeMockToolHost(),
      evaluator: makeMockEvaluator(),
    });

    assert.equal(result.status, "INVALID");
    assert.equal(result.faults[0]?.code, "MISSING_TOKEN_USAGE");
  }
});

test("RepeatedFailureOllamaChatDriver rejects invalid token counts", async () => {
  for (const counts of [
    { prompt_eval_count: -1, eval_count: 1 },
    { prompt_eval_count: 1.5, eval_count: 1 },
    { prompt_eval_count: Number.MAX_SAFE_INTEGER + 1, eval_count: 1 },
  ]) {
    const driver = createRepeatedFailureOllamaChatDriver({
      model: "llama3.1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      modelDigest: TEST_MODEL_DIGEST,
      transport: async () => new Response(JSON.stringify({
        model: "llama3.1",
        message: { role: "assistant", content: "Done" },
        done: true,
        ...counts,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
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
      prompt: "Check usage",
      caps: defaultCaps,
      toolHost: makeMockToolHost(),
      evaluator: makeMockEvaluator(),
    });

    assert.equal(result.status, "INVALID");
    assert.equal(result.faults[0]?.code, "MALFORMED_RESPONSE_SCHEMA");
  }
});

test("Ollama model preflight accepts the exact configured digest and rejects drift", async () => {
  for (const [servedDigest, shouldPass] of [
    [TEST_MODEL_DIGEST, true],
    ["e".repeat(64), false],
  ] as const) {
    let capturedUrl = "";
    let capturedMethod = "";
    const driver = createRepeatedFailureOllamaChatDriver({
      model: "llama3.1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      modelDigest: TEST_MODEL_DIGEST,
      transport: async (url, init) => {
        capturedUrl = url;
        capturedMethod = init.method ?? "";
        return new Response(JSON.stringify({
          models: [{
            name: "llama3.1",
            model: "llama3.1",
            digest: servedDigest,
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    if (shouldPass) {
      await driver.preflight();
      assert.equal(capturedUrl, "http://127.0.0.1:11434/api/tags");
      assert.equal(capturedMethod, "GET");
    } else {
      await assert.rejects(() => driver.preflight(), /digest mismatch/i);
    }
  }

});

test("Ollama model preflight rejects a registered context window above native capacity", async () => {
  for (const [contextWindowTokens, shouldPass] of [[32_768, true], [65_536, false]] as const) {
    const driver = createRepeatedFailureOllamaChatDriver({
      model: "llama3.1",
      modelProfileId: TEST_PROFILE_ID,
      modelProfileHash: TEST_PROFILE_HASH,
      modelDigest: TEST_MODEL_DIGEST,
      contextWindowTokens,
      transport: async (url) => new Response(JSON.stringify(
        url.endsWith("/api/tags")
          ? {
            models: [{
              name: "llama3.1",
              model: "llama3.1",
              digest: TEST_MODEL_DIGEST,
            }],
          }
          : { model_info: { "llama.context_length": 32_768 } },
      ), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    if (shouldPass) {
      await driver.preflight();
    } else {
      await assert.rejects(() => driver.preflight(), /context window/i);
    }
  }
});
