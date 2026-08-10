import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "./config.js";
import { ExtractionEngine } from "./extraction.js";

type TestMessage = { role: "system" | "user" | "assistant"; content: string };
type TestOptions = { maxTokens?: number; signal?: AbortSignal };

const superseded = { id: "support-old", content: "The service uses port 4000." };
const replacement = { id: "support-new", content: "The service uses port 5000." };
const dependents = [{ id: "dependent", category: "fact", content: "Port 4000 must be open." }];
const response = {
  content: JSON.stringify({
    verdicts: [{ memoryId: "dependent", verdict: "invalidated", reason: "The port changed." }],
  }),
};

function assertInvalidated(result: Awaited<ReturnType<ExtractionEngine["revalidateDependents"]>>): void {
  assert.deepEqual(result, {
    verdicts: [{ memoryId: "dependent", verdict: "invalidated", reason: "The port changed." }],
  });
}

test("revalidation keeps the official OpenAI base URL on the Responses API", async () => {
  const engine = new ExtractionEngine(
    parseConfig({ openaiApiKey: "fixture-key", openaiBaseUrl: "https://api.openai.com/v1" }),
  );
  const signal = new AbortController().signal;
  let calls = 0;
  let request: Record<string, unknown> | undefined;
  let requestOptions: { signal?: AbortSignal } | undefined;
  Reflect.set(engine, "client", {
    baseURL: "https://api.openai.com/v1",
    responses: {
      async create(body: Record<string, unknown>, options: { signal?: AbortSignal }) {
        calls += 1;
        request = body;
        requestOptions = options;
        return { output_text: response.content };
      },
    },
  });
  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents, signal));
  assert.equal(calls, 1);
  assert.equal(request?.model, "gpt-5.5");
  assert.equal(request?.max_output_tokens, 1024);
  assert.match(String(request?.instructions), /revalidate dependent memory claims/i);
  assert.match(String(request?.input), /SUPERSEDED MEMORY.*support-old/s);
  assert.equal(requestOptions?.signal, signal);
});

test("revalidation uses the client's effective custom base URL", async () => {
  const engine = new ExtractionEngine(
    parseConfig({
      openaiApiKey: "fixture-key",
      openaiBaseUrl: "https://api.openai.com/v1",
    }),
  );
  const signal = new AbortController().signal;
  let chatRequest: Record<string, unknown> | undefined;
  let chatOptions: { signal?: AbortSignal } | undefined;
  let responsesCalls = 0;
  Reflect.set(engine, "client", {
    baseURL: "https://inference.example.test/v1",
    chat: {
      completions: {
        async create(body: Record<string, unknown>, options: { signal?: AbortSignal }) {
          chatRequest = body;
          chatOptions = options;
          return { choices: [{ message: response }] };
        },
      },
    },
    responses: {
      async create() {
        responsesCalls += 1;
        throw new Error("custom endpoint does not implement /responses");
      },
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents, signal));
  assert.equal(responsesCalls, 0);
  assert.equal(chatRequest?.model, "gpt-5.5");
  assert.equal(chatRequest?.max_tokens, 1024);
  assert.ok(Array.isArray(chatRequest?.messages));
  assert.equal(chatOptions?.signal, signal);
});

test("revalidation falls back to the direct route when the injected fast route is unavailable", async () => {
  const engine = new ExtractionEngine(
    parseConfig({ openaiApiKey: "fixture-key", openaiBaseUrl: "https://api.openai.com/v1" }),
    undefined,
    undefined,
    undefined,
    undefined,
    async () => null,
  );
  const signal = new AbortController().signal;
  let fastCalls = 0;
  let directCalls = 0;
  let fastMessages: TestMessage[] | undefined;
  let fastOptions: TestOptions | undefined;
  let request: Record<string, unknown> | undefined;
  let requestOptions: { signal?: AbortSignal } | undefined;
  Reflect.set(engine, "fastChatCompletion", async (messages: TestMessage[], options: TestOptions) => {
    fastCalls += 1;
    fastMessages = messages;
    fastOptions = options;
    return null;
  });
  Reflect.set(engine, "client", {
    baseURL: "https://api.openai.com/v1",
    responses: {
      async create(body: Record<string, unknown>, options: { signal?: AbortSignal }) {
        directCalls += 1;
        request = body;
        requestOptions = options;
        return { output_text: response.content };
      },
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents, signal));
  assert.equal(fastCalls, 1);
  assert.equal(directCalls, 1);
  assert.equal(fastMessages?.[0]?.role, "system");
  assert.match(fastMessages?.[1]?.content ?? "", /support-new/);
  assert.equal(fastOptions?.maxTokens, 1024);
  assert.equal(fastOptions?.signal, signal);
  assert.equal(request?.max_output_tokens, 1024);
  assert.equal(requestOptions?.signal, signal);
});

test("revalidation preserves the gateway fallback route for the legacy constructor", async () => {
  const engine = new ExtractionEngine(parseConfig({ modelSource: "gateway" }));
  const signal = new AbortController().signal;
  let fastCalls = 0;
  let fallbackCalls = 0;
  let fallbackMessages: TestMessage[] | undefined;
  let fallbackOptions: TestOptions | undefined;
  Reflect.set(engine, "fastChatCompletion", async () => {
    fastCalls += 1;
    return null;
  });
  Reflect.set(engine, "fallbackLlm", {
    async chatCompletion(
      messages: TestMessage[],
      options: TestOptions,
    ) {
      fallbackCalls += 1;
      fallbackMessages = messages;
      fallbackOptions = options;
      return response;
    },
  });

  assertInvalidated(await engine.revalidateDependents(superseded, replacement, dependents, signal));
  assert.equal(fastCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(fallbackMessages?.[0]?.role, "system");
  assert.match(fallbackMessages?.[1]?.content ?? "", /dependent/);
  assert.equal(fallbackOptions?.maxTokens, 1024);
  assert.equal(fallbackOptions?.signal, signal);
});
