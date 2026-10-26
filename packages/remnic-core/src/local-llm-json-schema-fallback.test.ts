import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { mock } from "node:test";

import { LocalLlmClient } from "./local-llm.js";
import { ChatTransport } from "./local-llm-transport.js";
import { parseConfig } from "./config.js";
import type { LocalLlmChatCompletionOptions } from "./local-llm-helpers.js";
import type { PluginConfig } from "./types.js";

function createConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return parseConfig({
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmTimeoutMs: 5_000,
    localLlmRetry5xxCount: 0,
    localLlmRateLimitRetryCount: 0,
    localLlmRetryBackoffMs: 1,
    localLlmHeaders: { "X-Test": "yes" },
    localLlmApiKey: undefined,
    localLlmAuthHeader: false,
    localLlm400TripThreshold: 50,
    localLlm400CooldownMs: 60_000,
    debug: false,
    localLlmReasoningEffort: "none",
    slowLogEnabled: false,
    slowLogThresholdMs: 60_000,
    ...overrides,
  });
}

function primeClient(client: LocalLlmClient): void {
  mock.method(client, "checkAvailability", async () => true);
}

interface RecordedRequest {
  headers: http.IncomingHttpHeaders;
  body: { model: string; response_format?: LocalLlmChatCompletionOptions["responseFormat"] };
}

async function startRecordingServer(
  respond: (req: http.IncomingMessage, requestCount: number) => {
    status: number;
    body: unknown;
  },
): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      const { status, body } = respond(req, requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: listen(0, "127.0.0.1") above binds TCP, so its address is AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const okCompletion = {
  choices: [{ message: { content: "done" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const responseFormat = {
  type: "json_schema",
  json_schema: {
    name: "result",
    schema: { type: "object", properties: { ok: { type: "boolean" } } },
  },
};

test("forwards json_schema response_format when the backend accepts it", async () => {
  const server = await startRecordingServer(() => ({ status: 200, body: okCompletion }));
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
    });
    assert.equal(result?.content, "done");
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0].body.response_format, responseFormat);
  } finally {
    await server.close();
  }
});

test("400 rejecting json_schema triggers exactly one retry without the format", async (t) => {
  const server = await startRecordingServer((_req, count) =>
    count === 1
      ? {
          status: 400,
          body: {
            error: { message: "response_format type json_schema is not supported" },
          },
        }
      : { status: 200, body: okCompletion },
  );
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    const post = ChatTransport.prototype.post;
    const attempts: Array<Parameters<ChatTransport["post"]>[0]> = [];
    t.mock.method(ChatTransport.prototype, "post", async function (this: ChatTransport, request: Parameters<ChatTransport["post"]>[0]) {
      attempts.push(request);
      return post.call(this, request);
    });
    const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
    });
    assert.equal(result?.content, "done");
    assert.equal(server.requests.length, 2, "exactly one strip-and-retry");
    assert.deepEqual(server.requests[0].body.response_format, responseFormat);
    assert.equal(server.requests[1].body.response_format, undefined);
    // headers/model/deadline preserved on the retry
    assert.equal(server.requests[1].headers["x-test"], "yes");
    assert.equal(server.requests[1].body.model, "test-local-model");
    assert.equal(attempts[0].signal, attempts[1].signal, "retry shares the attempt deadline and caller abort");
    assert.equal(attempts[0].budgetMs, attempts[1].budgetMs);
    assert.deepEqual(attempts[0].headers, attempts[1].headers);
  } finally {
    await server.close();
  }
});

test("format removal persists for later 5xx attempts", async () => {
  const server = await startRecordingServer((_req, count) =>
    count === 1
      ? { status: 400, body: { error: { message: "json_schema unsupported by backend" } } }
      : count === 2
        ? { status: 500, body: { error: { message: "boom" } } }
        : { status: 200, body: okCompletion },
  );
  try {
    const client = new LocalLlmClient(
      createConfig({ localLlmUrl: server.url, localLlmRetry5xxCount: 2 }),
    );
    primeClient(client);
    const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
    });
    assert.equal(result?.content, "done");
    assert.equal(server.requests.length, 3);
    assert.equal(server.requests[2].body.response_format, undefined);
  } finally {
    await server.close();
  }
});

test("unrelated 400 and 429 are not retried with a stripped format", async () => {
  for (const status of [400, 429]) {
    const server = await startRecordingServer(() => ({
      status,
      body: { error: { message: "some other problem" } },
    }));
    try {
      const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
      primeClient(client);
      const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
        responseFormat,
      });
      assert.equal(result, null);
      assert.equal(server.requests.length, 1);
      assert.ok(server.requests[0].body.response_format, "format still present");
    } finally {
      await server.close();
    }
  }
});

test("caller abort still fails closed during the strip retry", async () => {
  const controller = new AbortController();
  const server = await startRecordingServer((_req, count) => {
    if (count === 2) controller.abort();
    return count === 1
      ? { status: 400, body: { error: { message: "response_format json_schema is not supported" } } }
      : { status: 200, body: okCompletion };
  });
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    const pending = client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
      signal: controller.signal,
    });
    const result = await pending;
    assert.equal(result, null);
    assert.equal(server.requests.length, 2, "caller abort happens during the strip retry, not before the first request");
  } finally {
    await server.close();
  }
});

test("request without response_format is unchanged", async () => {
  const server = await startRecordingServer(() => ({ status: 200, body: okCompletion }));
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    const result = await client.chatCompletion([{ role: "user", content: "hello" }]);
    assert.equal(result?.content, "done");
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].body.response_format, undefined);
  } finally {
    await server.close();
  }
});

