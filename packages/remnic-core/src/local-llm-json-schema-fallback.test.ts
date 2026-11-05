import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test, { mock } from "node:test";

import { LocalLlmClient } from "./local-llm.js";
import { ModelRegistry } from "./model-registry.js";
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

test("timeout before strip-retry headers uses the configured transport retry", async (t) => {
  const bodies: RecordedRequest["body"][] = [];
  t.mock.method(ChatTransport.prototype, "post", async (request: Parameters<ChatTransport["post"]>[0]) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return new Response("json_schema is not supported", { status: 400 });
    if (bodies.length === 2) throw new DOMException("Timed out before headers", "AbortError");
    return new Response(JSON.stringify(okCompletion), { status: 200 });
  });
  const client = new LocalLlmClient(createConfig({ localLlmRetry5xxCount: 1, localLlm400TripThreshold: 1 }));
  primeClient(client);
  const result = await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat });
  assert.equal(result?.content, "done");
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0].response_format, responseFormat);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[2].response_format, undefined);
});

test("a diagnostic echo of the format is not a schema capability rejection", async () => {
  for (const message of [
    "Context length exceeded; request included response_format json_schema",
    "Unsupported parameter temperature; request included response_format json_schema",
  ]) {
    const server = await startRecordingServer(() => ({ status: 400, body: { error: { message } } }));
    try {
      const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
      primeClient(client);
      assert.equal(await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }), null);
      assert.equal(server.requests.length, 1, "unrelated provider errors must not strip the format");
    } finally {
      await server.close();
    }
  }
});

test("an explicit unknown response_format field retries without the format", async () => {
  const server = await startRecordingServer((_req, count) => count === 1
    ? { status: 400, body: { error: { message: "Unknown field response_format" } } }
    : { status: 200, body: okCompletion });
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    assert.equal((await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }))?.content, "done");
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.requests[0].body.response_format, responseFormat);
    assert.equal(server.requests[1].body.response_format, undefined);
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

// ── Schema-validation rejections (the provider parses our json_schema) ──────
//
// Production signature (2026-11-05, MiniMax-M3.1-Flash via local proxy): a
// 400 "invalid params — Mismatch type string with value array" quoting a
// schema fragment like `"episodeTitle": {"type": ["string","null"]}`. The
// provider accepts structured output in principle but its strict parser
// rejects our draft-7 nullable type unions. Unlike capability rejections
// these errors never name response_format, so nothing stripped the format,
// every drain attempt re-sent the identical payload, and the 400 breaker
// opened. The zod draft-7 schema legitimately contains `type` arrays
// (nullable fields), so the provider dialect, not our request, is the
// constraint: degrade to the pre-schema request shape and remember it.

const schemaValidationRejection = {
  error: {
    // Verbatim production body shape (2026-11-05): "Mismatch type" (no "ed"),
    // JSON-escaped quotes around the schema fragment, and no mention of
    // response_format anywhere.
    message:
      'invalid params, Mismatch type string with value array "at index 13779: \\"episodeTitle\\": {\\"type\\": [\\"string\\",\\"null\\"]}"',
  },
};

test("a schema-validation 400 strips the format and retries without it", async () => {
  const server = await startRecordingServer((_req, count) =>
    count === 1
      ? { status: 400, body: schemaValidationRejection }
      : { status: 200, body: okCompletion },
  );
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
    });
    assert.equal(result?.content, "done");
    assert.equal(server.requests.length, 2, "exactly one strip-and-retry");
    assert.ok(server.requests[0].body.response_format, "the schema-shaped request went out first");
    assert.equal(server.requests[1].body.response_format, undefined);
  } finally {
    await server.close();
  }
});

test("a rejected schema format is not re-sent on later requests", async () => {
  const server = await startRecordingServer((_req, count) =>
    count === 1
      ? { status: 400, body: schemaValidationRejection }
      : { status: 200, body: okCompletion },
  );
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    assert.equal(
      (await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }))?.content,
      "done",
    );
    assert.equal(
      (await client.chatCompletion([{ role: "user", content: "hello again" }], { responseFormat }))?.content,
      "done",
    );
    assert.equal(server.requests.length, 3, "second call sends one request, not a new 400");
    assert.equal(
      server.requests[2].body.response_format,
      undefined,
      "the learned rejection skips the format entirely",
    );
  } finally {
    await server.close();
  }
});

test("a learned schema rejection persists in the model registry for fresh clients", async () => {
  const memoryDir = fs.mkdtempSync(join(os.tmpdir(), "remnic-schema-cap-"));
  const server = await startRecordingServer((_req, count) =>
    count === 1
      ? { status: 400, body: schemaValidationRejection }
      : { status: 200, body: okCompletion },
  );
  try {
    const registry = new ModelRegistry(memoryDir);
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }), registry);
    primeClient(client);
    assert.equal(
      (await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }))?.content,
      "done",
    );
    // SAFETY: we wrote model-capabilities.json through ModelRegistry above; the
    // document is an object keyed by normalized model id.
    const persisted = JSON.parse(
      fs.readFileSync(join(memoryDir, ".registry", "model-capabilities.json"), "utf8"),
    ) as { models: Record<string, { structuredOutput?: string }> };
    assert.equal(persisted.models["test-local-model"]?.structuredOutput, "none");

    const fresh = new LocalLlmClient(createConfig({ localLlmUrl: server.url }), new ModelRegistry(memoryDir));
    primeClient(fresh);
    assert.equal(
      (await fresh.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }))?.content,
      "done",
    );
    const formatRequests = server.requests.filter((r) => r.body.response_format);
    assert.equal(formatRequests.length, 1, "only the first-ever request carries the format");
  } finally {
    await server.close();
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("a schema-carrying success records native and keeps sending the format", async () => {
  const memoryDir = fs.mkdtempSync(join(os.tmpdir(), "remnic-schema-cap-"));
  const server = await startRecordingServer(() => ({ status: 200, body: okCompletion }));
  try {
    const registry = new ModelRegistry(memoryDir);
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }), registry);
    primeClient(client);
    await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat });
    await client.chatCompletion([{ role: "user", content: "hello again" }], { responseFormat });
    // SAFETY: we wrote model-capabilities.json through ModelRegistry above; the
    // document is an object keyed by normalized model id.
    const persisted = JSON.parse(
      fs.readFileSync(join(memoryDir, ".registry", "model-capabilities.json"), "utf8"),
    ) as { models: Record<string, { structuredOutput?: string }> };
    assert.equal(persisted.models["test-local-model"]?.structuredOutput, "native");
    assert.equal(server.requests.length, 2);
    assert.ok(server.requests[1].body.response_format, "structured output remains for supporting providers");
  } finally {
    await server.close();
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("an expired registry rejection is re-probed instead of honored forever", async () => {
  const memoryDir = fs.mkdtempSync(join(os.tmpdir(), "remnic-schema-cap-"));
  const server = await startRecordingServer(() => ({ status: 200, body: okCompletion }));
  try {
    const registry = new ModelRegistry(memoryDir);
    registry.setStructuredOutput("test-local-model", "none");
    // Age the entry past the 7-day registry TTL, as a long-lived deployment
    // would: the learned rejection must not be honored forever.
    const registryPath = join(memoryDir, ".registry", "model-capabilities.json");
    // SAFETY: we wrote model-capabilities.json through ModelRegistry above; the
    // document is an object keyed by normalized model id.
    const persisted = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      models: Record<string, { fetchedAt: string }>;
    };
    persisted.models["test-local-model"].fetchedAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(registryPath, JSON.stringify(persisted));

    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }), new ModelRegistry(memoryDir));
    primeClient(client);
    const result = await client.chatCompletion([{ role: "user", content: "hello" }], {
      responseFormat,
    });
    assert.equal(result?.content, "done");
    assert.ok(server.requests[0].body.response_format, "expired rejection is re-probed with the schema");
    // The provider accepts it this time: the native record refreshes.
    // SAFETY: the file above was written by ModelRegistry's own persistence;
    // the document is an object keyed by normalized model id.
    const refreshed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      models: Record<string, { structuredOutput?: string }>;
    };
    assert.equal(refreshed.models["test-local-model"]?.structuredOutput, "native");
  } finally {
    await server.close();
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("a later capabilities write preserves the learned structuredOutput", async () => {
  const memoryDir = fs.mkdtempSync(join(os.tmpdir(), "remnic-schema-cap-"));
  try {
    const registry = new ModelRegistry(memoryDir);
    registry.setStructuredOutput("test-local-model", "none");
    // Mirrors getCachedContextWindow's LM Studio detection replacing the record.
    registry.setCapabilities("test-local-model", {
      maxPositionEmbeddings: 131072,
      contextWindow: 131072,
      supportsExtendedContext: true,
      typicalOutputTokens: 8192,
      source: "lmstudio",
    });
    assert.equal(registry.getStructuredOutput("test-local-model"), "none");
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("an expired structuredOutput decision is not renewed by a capability refresh", async () => {
  const memoryDir = fs.mkdtempSync(join(os.tmpdir(), "remnic-schema-cap-"));
  try {
    const registry = new ModelRegistry(memoryDir);
    registry.setStructuredOutput("test-local-model", "none");
    // Age the learned decision past the registry TTL exactly as a long-lived
    // deployment would.
    const registryPath = join(memoryDir, ".registry", "model-capabilities.json");
    // SAFETY: we wrote model-capabilities.json through ModelRegistry above; the
    // document is an object keyed by normalized model id.
    const persisted = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      models: Record<string, { fetchedAt: string }>;
    };
    persisted.models["test-local-model"].fetchedAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString();
    fs.writeFileSync(registryPath, JSON.stringify(persisted));
    // The refresh happens in a process that loaded the AGED state from disk
    // (a restart or another runtime sharing the memory dir).
    const refreshedRegistry = new ModelRegistry(memoryDir);
    refreshedRegistry.setCapabilities("test-local-model", {
      maxPositionEmbeddings: 131072,
      contextWindow: 131072,
      supportsExtendedContext: true,
      typicalOutputTokens: 8192,
      source: "lmstudio",
    });
    assert.equal(
      refreshedRegistry.getStructuredOutput("test-local-model"),
      undefined,
      "an expired decision must not be renewed into a fresh record — the re-probe stays due",
    );
  } finally {
    fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("invalid params without schema evidence is not treated as a schema rejection", async () => {
  const server = await startRecordingServer(() => ({
    status: 400,
    body: { error: { message: "invalid params: temperature must be between 0 and 2" } },
  }));
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    assert.equal(await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }), null);
    assert.equal(server.requests.length, 1, "unrelated invalid-param errors must not strip the format");
  } finally {
    await server.close();
  }
});

test("an echoed format name inside an unrelated invalid-param error does not strip", async () => {
  const server = await startRecordingServer(() => ({
    status: 400,
    body: {
      error: {
        message: "invalid params: quota exceeded; request included response_format json_schema",
      },
    },
  }));
  try {
    const client = new LocalLlmClient(createConfig({ localLlmUrl: server.url }));
    primeClient(client);
    assert.equal(await client.chatCompletion([{ role: "user", content: "hello" }], { responseFormat }), null);
    assert.equal(server.requests.length, 1, "an echo of the format name is not schema-rejection evidence");
  } finally {
    await server.close();
  }
});

