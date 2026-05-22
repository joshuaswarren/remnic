import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import { gzipSync } from "node:zlib";
import {
  createWeCloneProxy,
  writeResponseChunkRespectingBackpressure,
} from "./proxy.js";
import type { WeCloneConnectorConfig } from "./config.js";

/**
 * Create a mock HTTP server that responds with a fixed body for any request.
 * Listens on port 0 (OS-assigned) to avoid conflicts.
 */
function createMockServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) => void
): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}

/**
 * Read a response body as string.
 */
async function readResponse(res: Response): Promise<string> {
  return res.text();
}

/**
 * Build a test config pointing at the given mock ports.
 */
function testConfig(
  weclonePort: number,
  remnicPort: number,
  overrides: Partial<WeCloneConnectorConfig> = {}
): WeCloneConnectorConfig {
  return {
    wecloneApiUrl: `http://127.0.0.1:${weclonePort}/v1`,
    proxyPort: 0, // OS-assigned
    remnicDaemonUrl: `http://127.0.0.1:${remnicPort}`,
    sessionStrategy: "single",
    memoryInjection: {
      maxTokens: 1500,
      position: "system-append",
      template: "[Memory]\n{memories}\n[/Memory]",
    },
    ...overrides,
  };
}

// Track servers to clean up
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

describe("WeCloneProxy", () => {
  it("starts and stops cleanly", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    assert.ok(proxy.port > 0, "proxy should have a valid port");
    assert.equal(proxy.host, "127.0.0.1");
    await proxy.stop();
    // Remove from cleanups since we already stopped
    cleanups.pop();
  });

  it("stream writes wait for drain when response backpressure is signaled", async () => {
    const res = new EventEmitter() as http.ServerResponse;
    (res as unknown as { destroyed: boolean }).destroyed = false;
    (res as unknown as { writableEnded: boolean }).writableEnded = false;
    let writeCalls = 0;
    (res as unknown as { write: (chunk: Uint8Array) => boolean }).write = () => {
      writeCalls += 1;
      return false;
    };

    const written = writeResponseChunkRespectingBackpressure(res, Buffer.from("chunk"));
    queueMicrotask(() => res.emit("drain"));

    assert.equal(await written, true);
    assert.equal(writeCalls, 1);
  });

  it("stream writes stop when the client closes before drain", async () => {
    const res = new EventEmitter() as http.ServerResponse;
    (res as unknown as { destroyed: boolean }).destroyed = false;
    (res as unknown as { writableEnded: boolean }).writableEnded = false;
    (res as unknown as { write: (chunk: Uint8Array) => boolean }).write = () => false;

    const written = writeResponseChunkRespectingBackpressure(res, Buffer.from("chunk"));
    queueMicrotask(() => res.emit("close"));

    assert.equal(await written, false);
  });

  it("health endpoint returns 200 with status ok", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const config = testConfig(weclone.port, remnic.port);
    const proxy = createWeCloneProxy(config);
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/health`);
    assert.equal(res.status, 200);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.status, "ok");
    assert.equal(body.wecloneApi, config.wecloneApiUrl);
  });

  it("proxies chat completions with memory injection", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Hello from WeClone!" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { content: "User prefers formal tone", confidence: 0.9 },
          ],
        })
      );
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hi there" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    const responseBody = JSON.parse(await readResponse(res));
    assert.equal(responseBody.choices[0].message.content, "Hello from WeClone!");

    // Verify memory was injected into the forwarded request
    assert.ok(receivedBody, "WeClone should have received a request");
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg, "System message should exist");
    assert.ok(
      systemMsg.content.includes("User prefers formal tone"),
      "Memory should be injected into system message"
    );
    assert.ok(
      systemMsg.content.includes("[Memory]"),
      "Memory template should be used"
    );
  });

  it("forwards the configured WeClone model name", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port, {
      wecloneModelName: "custom-avatar",
    }));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "client-placeholder",
        messages: [{ role: "user", content: "Hi there" }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(receivedBody);
    assert.equal((receivedBody as Record<string, unknown>).model, "custom-avatar");
  });

  it("continues working when Remnic recall fails", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Response without memory" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    // Remnic returns 500
    const remnic = await createMockServer((_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    const responseBody = JSON.parse(await readResponse(res));
    assert.equal(
      responseBody.choices[0].message.content,
      "Response without memory"
    );

    // Verify the system message was NOT modified (no memory block)
    assert.ok(receivedBody);
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.equal(
      systemMsg.content,
      "You are helpful.",
      "System message should be unmodified when recall fails"
    );
  });

  it("transparently proxies non-chat paths", async () => {
    const weclone = await createMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/models`
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.path, "/v1/models");
    assert.equal(body.method, "GET");
  });

  it("sends auth token to Remnic daemon when configured", async () => {
    let recallAuthHeader: string | undefined;
    let observeAuthHeader: string | undefined;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Hello!" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    let requestCount = 0;
    const remnic = await createMockServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        recallAuthHeader = req.headers["authorization"] as string | undefined;
      } else {
        observeAuthHeader = req.headers["authorization"] as string | undefined;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ preview: "Some memory", confidence: 0.9 }] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        remnicAuthToken: "test-secret-token",
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      }),
    });

    // Wait briefly for fire-and-forget observe
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(
      recallAuthHeader,
      "Bearer test-secret-token",
      "Recall request should include auth header"
    );
    assert.equal(
      observeAuthHeader,
      "Bearer test-secret-token",
      "Observe request should include auth header"
    );
  });

  it("sends observe body in messages array format", async () => {
    let observeBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "I remember you!" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    let requestCount = 0;
    const remnic = await createMockServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        // recall request
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      } else {
        // observe request
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          observeBody = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      }
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello friend" },
        ],
      }),
    });

    // Wait for fire-and-forget observe
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(observeBody, "Observe request should have been sent");
    assert.ok(
      Array.isArray((observeBody as Record<string, unknown>).messages),
      "Observe body should have a messages array"
    );
    const messages = (observeBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "Hello friend");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "I remember you!");
    assert.equal(
      (observeBody as Record<string, unknown>).sessionKey,
      "weclone-default",
      "Observe body should include sessionKey"
    );
  });

  it("normalizes recall results with preview field to content", async () => {
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: "Reply" },
              },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    // Remnic returns results with preview field (EngramAccessMemorySummary format)
    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { preview: "User likes dogs", confidence: 0.85, category: "preference" },
            { content: "User lives in NYC", confidence: 0.7 },
          ],
        })
      );
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "What do I like?" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.ok(receivedBody);
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsg = messages.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(
      systemMsg.content.includes("User likes dogs"),
      "preview field should be normalized to content"
    );
    assert.ok(
      systemMsg.content.includes("User lives in NYC"),
      "content field should still work as fallback"
    );
  });

  it("streams SSE responses for stream: true requests", async () => {
    // WeClone mock returns SSE chunks
    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        res.write(
          'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n\n'
        );
        res.write(
          'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'
        );
        res.write(
          'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    cleanups.push(weclone.close);

    let observeReceived = false;
    let observeContent = "";
    let requestCount = 0;
    const remnic = await createMockServer((req, res) => {
      requestCount++;
      if (requestCount === 1) {
        // recall
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      } else {
        // observe
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          observeReceived = true;
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            messages?: Array<{ role: string; content: string }>;
          };
          const assistantMsg = body.messages?.find(
            (m: { role: string }) => m.role === "assistant"
          );
          observeContent = assistantMsg?.content ?? "";
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        });
      }
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          stream: true,
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Say hello" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "text/event-stream",
      "Response should have SSE content type"
    );

    // Read the full streamed response
    const streamedBody = await res.text();
    assert.ok(
      streamedBody.includes("data: [DONE]"),
      "Streamed response should include [DONE] marker"
    );
    assert.ok(
      streamedBody.includes('"content":"Hello"'),
      "Streamed response should include content chunks"
    );

    // Wait for fire-and-forget observe
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(
      observeReceived,
      "Observe should be called with reconstructed content"
    );
    assert.equal(
      observeContent,
      "Hello world",
      "Observed content should be the concatenated stream deltas"
    );
  });

  it("stops buffering streaming observation after the configured cap while passing stream through", async () => {
    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        for (let index = 0; index < 100; index += 1) {
          res.write(
            `data: {"choices":[{"delta":{"content":"chunk-${index}-${"x".repeat(256)}"},"index":0}]}\n\n`
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    cleanups.push(weclone.close);

    let observeCount = 0;
    let requestCount = 0;
    const remnic = await createMockServer((_req, res) => {
      requestCount++;
      if (requestCount > 1) observeCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(requestCount === 1 ? JSON.stringify({ results: [] }) : JSON.stringify({ ok: true }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        streamObservationMaxBytes: 32,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          stream: true,
          messages: [{ role: "user", content: "stream please" }],
        }),
      }
    );

    assert.equal(res.status, 200);
    const streamedBody = await res.text();
    assert.ok(streamedBody.includes("data: [DONE]"));
    assert.ok(streamedBody.includes("chunk-99-"));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(observeCount, 0, "oversized streams should not be buffered for observe");
  });

  it("does not expose error details in 502 responses", async () => {
    // WeClone is unreachable (no mock server started on this port)
    const fakeWeclonePort = 59999;

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(fakeWeclonePort, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }
    );

    assert.equal(res.status, 502);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "upstream_unreachable");
    assert.equal(
      body.detail,
      undefined,
      "Error response must not expose detail/stack trace"
    );
  });

  it("returns 400 for invalid JSON body on chat completions", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json at all{{{",
      }
    );
    assert.equal(res.status, 400);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "bad_request");
  });

  it("returns 400 for non-object JSON chat bodies without contacting upstream", async () => {
    let upstreamRequests = 0;
    const weclone = await createMockServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    for (const bodyValue of [null, [], "hello", 42]) {
      const res = await fetch(
        `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bodyValue),
        }
      );
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bodyValue)}`);
      const body = JSON.parse(await readResponse(res));
      assert.equal(body.error, "bad_request");
    }

    assert.equal(upstreamRequests, 0, "invalid top-level JSON must not reach upstream services");
  });

  it("trailing slash in wecloneApiUrl does not produce double-slash URLs", async () => {
    let receivedUrl = "";

    const weclone = await createMockServer((req, res) => {
      receivedUrl = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "OK" } },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    // Config with trailing slash -- should NOT produce /v1//chat/completions
    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        wecloneApiUrl: `http://127.0.0.1:${weclone.port}/v1/`,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.equal(
      receivedUrl,
      "/v1/chat/completions",
      "Upstream URL must not contain double slashes"
    );
    assert.ok(
      !receivedUrl.includes("//"),
      "URL path must not contain double slashes"
    );
  });

  it("transparent proxy sets Content-Length and ends response correctly", async () => {
    const responsePayload = JSON.stringify({
      data: [{ id: "model-1" }, { id: "model-2" }],
    });

    const weclone = await createMockServer((_req, res) => {
      // Simulate upstream with transfer-encoding: chunked
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      });
      res.write(responsePayload.slice(0, 10));
      res.write(responsePayload.slice(10));
      res.end();
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "application/json",
      "Content-Type should be forwarded"
    );
    assert.equal(
      res.headers.get("content-length"),
      String(Buffer.byteLength(responsePayload)),
      "Content-Length should be set to actual body length"
    );
    assert.equal(
      res.headers.get("transfer-encoding"),
      null,
      "transfer-encoding hop-by-hop header must be stripped"
    );

    const body = JSON.parse(await readResponse(res));
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].id, "model-1");
  });

  it("transparent proxy returns 502 when upstream is unreachable", async () => {
    const fakeWeclonePort = 59998;

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(fakeWeclonePort, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(res.status, 502);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "upstream_unreachable");
  });

  it("rejects transparent proxy request bodies over the configured limit", async () => {
    let upstreamCalled = false;
    const weclone = await createMockServer((_req, res) => {
      upstreamCalled = true;
      res.writeHead(200);
      res.end("unexpected");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        maxRequestBytes: 8,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/uploads`, {
      method: "POST",
      body: "0123456789abcdef",
    });

    assert.equal(res.status, 413);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "request_body_too_large");
    assert.equal(upstreamCalled, false);
  });

  it("returns 502 when a buffered transparent upstream response exceeds the configured limit", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("0123456789abcdef");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        maxResponseBytes: 8,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);

    assert.equal(res.status, 502);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "upstream_response_too_large");
  });

  it("passes through upstream error body for stream requests instead of SSE headers", async () => {
    const errorPayload = JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } });

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        // Return a 401 JSON error, not SSE
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(errorPayload);
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          stream: true,
          messages: [{ role: "user", content: "Hello" }],
        }),
      }
    );

    assert.equal(res.status, 401, "Upstream error status should be forwarded");
    assert.equal(
      res.headers.get("content-type"),
      "application/json",
      "Error response should have JSON content-type, not text/event-stream"
    );
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error.message, "Unauthorized");
  });

  it("strips hop-by-hop headers from non-streaming chat completions responses", async () => {
    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        // Upstream responds with hop-by-hop headers that must be stripped
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
          "Connection": "keep-alive",
        });
        res.end(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "filtered reply" } },
            ],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [{ role: "user", content: "Hi" }],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("transfer-encoding"),
      null,
      "transfer-encoding hop-by-hop header must be stripped from chat completions responses"
    );
    // Note: Node.js HTTP server adds its own Connection header at the
    // transport layer, so we cannot assert it is absent. The important
    // guarantee is that upstream hop-by-hop headers like transfer-encoding
    // and content-encoding do not leak through.
    assert.ok(
      res.headers.get("content-length"),
      "content-length should be set on non-streaming chat completions responses"
    );
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.choices[0].message.content, "filtered reply");
  });

  it("strips hop-by-hop request headers from transparent proxy forwarding", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};

    const weclone = await createMockServer((req, res) => {
      receivedHeaders = { ...req.headers };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "model-1" }] }));
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    // Use a raw HTTP request so we can set hop-by-hop headers that
    // Node's fetch() / undici would reject (Upgrade, Trailer, TE).
    // We use a raw TCP socket to bypass Node http.ClientRequest
    // validation as well (it rejects Trailer without chunked TE).
    const responseBody = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(proxy.port, "127.0.0.1", () => {
        const rawRequest = [
          "GET /v1/models HTTP/1.1",
          `Host: 127.0.0.1:${proxy.port}`,
          "Content-Type: application/json",
          "X-Custom-Header: should-survive",
          "Proxy-Authorization: Basic secret-proxy-creds",
          "Proxy-Authenticate: Basic realm=proxy",
          "TE: trailers",
          "Trailer: X-Checksum",
          "Upgrade: websocket",
          "Keep-Alive: timeout=5",
          "Connection: close",
          "",
          "",
        ].join("\r\n");
        socket.write(rawRequest);
      });
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("socket timeout")); });
      const chunks: Buffer[] = [];
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      socket.on("error", reject);
    });

    // Parse HTTP response: skip headers, extract body after blank line
    const bodyStart = responseBody.indexOf("\r\n\r\n");
    assert.ok(bodyStart > 0, "Response should have headers and body");
    // The body might be chunked; extract the JSON payload
    const rawBody = responseBody.slice(bodyStart + 4);
    // Handle possible chunked transfer encoding in the response
    const jsonMatch = rawBody.match(/\{[^]*\}/);
    assert.ok(jsonMatch, "Response body should contain JSON");
    const reqBody = JSON.parse(jsonMatch[0]);
    assert.equal(reqBody.data[0].id, "model-1");

    // Verify hop-by-hop headers were stripped
    assert.equal(
      receivedHeaders["proxy-authorization"],
      undefined,
      "proxy-authorization must be stripped to prevent credential leakage"
    );
    assert.equal(
      receivedHeaders["proxy-authenticate"],
      undefined,
      "proxy-authenticate must be stripped"
    );
    assert.equal(
      receivedHeaders["te"],
      undefined,
      "te must be stripped"
    );
    assert.equal(
      receivedHeaders["trailer"],
      undefined,
      "trailer must be stripped"
    );
    assert.equal(
      receivedHeaders["upgrade"],
      undefined,
      "upgrade must be stripped"
    );
    assert.equal(
      receivedHeaders["keep-alive"],
      undefined,
      "keep-alive must be stripped"
    );
    // Note: we don't assert connection is absent because fetch() (undici)
    // adds its own Connection header for transport. The proxy strips the
    // *original* client Connection header; fetch replaces it with its own.

    // Verify non-hop-by-hop headers survive
    assert.equal(
      receivedHeaders["x-custom-header"],
      "should-survive",
      "Non-hop-by-hop headers must be forwarded"
    );
    assert.equal(
      receivedHeaders["content-type"],
      "application/json",
      "Content-Type must be forwarded"
    );

    // Host must also be stripped (replaced by fetch with upstream host)
    assert.notEqual(
      receivedHeaders["host"],
      `127.0.0.1:${proxy.port}`,
      "Original host header must not be forwarded"
    );
  });

  it("strips content-encoding from transparent proxy responses", async () => {
    const payload = JSON.stringify({ data: "test" });
    const compressed = gzipSync(Buffer.from(payload));

    const weclone = await createMockServer((_req, res) => {
      // Serve actually-gzipped body with the matching header.
      // fetch() auto-decompresses, so the proxy receives decoded bytes.
      // The proxy must NOT forward content-encoding to the client.
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": String(compressed.length),
      });
      res.end(compressed);
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-encoding"),
      null,
      "content-encoding must be stripped from buffered proxy responses"
    );
    assert.equal(
      res.headers.get("content-type"),
      "application/json",
      "Other headers should still be forwarded"
    );
    // Verify the body is readable as decompressed JSON
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.data, "test", "Body should be decompressed and readable");
  });

  it("matches chat completions route when URL has a query string", async () => {
    let recallCalled = false;
    let receivedBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Hi" } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      recallCalled = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [{ preview: "memory X", confidence: 0.9 }] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    // Simulate Azure-OpenAI style query string; route matching must not fall
    // through to the transparent proxy.
    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions?api-version=2024-01-01`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
          ],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.ok(recallCalled, "Recall must be invoked for chat URLs with query strings");
    const forwardedBody = receivedBody as unknown as Record<string, unknown> | null;
    assert.ok(forwardedBody, "WeClone should have received a request");
    const msgs = forwardedBody.messages as Array<{
      role: string;
      content: string;
    }>;
    const sys = msgs.find((m) => m.role === "system");
    assert.ok(sys && sys.content.includes("memory X"), "Memory must be injected");
  });

  it("handles multimodal user message content (array of parts)", async () => {
    let recallQuery: string | undefined;
    let observeBody: Record<string, unknown> | null = null;

    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Describing the image." } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    let reqCount = 0;
    const remnic = await createMockServer((req, res) => {
      reqCount++;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
          query?: string;
          messages?: Array<{ role: string; content: unknown }>;
        };
        if (reqCount === 1) {
          recallQuery = parsed.query;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results: [] }));
        } else {
          observeBody = parsed as unknown as Record<string, unknown>;
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [
          { role: "system", content: "You are helpful." },
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: "https://example.invalid/i.png" } },
            ],
          },
        ],
      }),
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      typeof recallQuery,
      "string",
      "Recall query must be a string even for multimodal content"
    );
    assert.equal(
      recallQuery,
      "What is in this image?",
      "Text parts from multimodal content must be extracted for recall"
    );
    assert.ok(observeBody, "Observe must be sent");
    const messages = (observeBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: unknown;
    }>;
    assert.equal(messages[0].role, "user");
    assert.equal(
      messages[0].content,
      "What is in this image?",
      "Observe user content must be plain text extracted from multimodal parts"
    );
  });

  it("normalizes trailing slashes on remnicDaemonUrl", async () => {
    let recallUrl = "";
    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((req, res) => {
      if (!recallUrl) recallUrl = req.url ?? "";
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        // Trailing slash must not produce `//engram/v1/recall`.
        remnicDaemonUrl: `http://127.0.0.1:${remnic.port}/`,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(
      recallUrl,
      "/engram/v1/recall",
      "Recall path must not have double-slash from trailing-slash config"
    );
  });

  it("forwards query string on chat completions to upstream", async () => {
    let receivedUrl = "";
    const weclone = await createMockServer((req, res) => {
      receivedUrl = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions?api-version=2024-01-01&tenant=abc`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: [{ role: "user", content: "hi" }],
        }),
      }
    );

    assert.equal(res.status, 200);
    assert.ok(
      receivedUrl.includes("api-version=2024-01-01"),
      "Upstream URL must preserve api-version query param"
    );
    assert.ok(
      receivedUrl.includes("tenant=abc"),
      "Upstream URL must preserve additional query params"
    );
  });

  it("preserves distinct system messages after memory injection", async () => {
    let receivedBody: Record<string, unknown> | null = null;
    const weclone = await createMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [{ preview: "injected-memory", confidence: 0.9 }],
        })
      );
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [
          { role: "system", content: "First instruction." },
          { role: "system", content: "Second instruction." },
          { role: "user", content: "Hi" },
        ],
      }),
    });

    assert.ok(receivedBody);
    const messages = (receivedBody as Record<string, unknown>).messages as Array<{
      role: string;
      content: string;
    }>;
    const systemMsgs = messages.filter((m) => m.role === "system");
    assert.equal(systemMsgs.length, 2, "Both system messages must survive");
    assert.ok(
      systemMsgs[0].content.includes("First instruction.") &&
        systemMsgs[0].content.includes("injected-memory"),
      "First system message must contain original + injected memory"
    );
    assert.equal(
      systemMsgs[1].content,
      "Second instruction.",
      "Second system message must be preserved verbatim"
    );
  });

  it("preserves OpenAI chat message metadata and end-to-end headers", async () => {
    let receivedBody: Record<string, unknown> | null = null;
    let receivedApiKey: string | undefined;
    let receivedRequestId: string | undefined;
    const weclone = await createMockServer((req, res) => {
      receivedApiKey = req.headers["api-key"] as string | undefined;
      receivedRequestId = req.headers["x-ms-client-request-id"] as string | undefined;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok" } }],
          })
        );
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [{ preview: "metadata-memory", confidence: 0.9 }],
        })
      );
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": "azure-key",
        "x-ms-client-request-id": "request-123",
      },
      body: JSON.stringify({
        model: "weclone-avatar",
        messages: [
          { role: "system", content: "First instruction.", name: "primary" },
          { role: "user", content: "Use the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "tool result",
          },
        ],
      }),
    });

    assert.equal(receivedApiKey, "azure-key");
    assert.equal(receivedRequestId, "request-123");
    assert.ok(receivedBody);
    const messages = (receivedBody as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].name, "primary");
    assert.match(String(messages[0].content), /metadata-memory/);
    assert.deepEqual(messages[2].tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      },
    ]);
    assert.equal(messages[3].role, "tool");
    assert.equal(messages[3].tool_call_id, "call_1");
    assert.equal(messages[3].content, "tool result");
  });

  it("returns 400 when messages is not an array", async () => {
    const weclone = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(testConfig(weclone.port, remnic.port));
    await proxy.start();
    cleanups.push(() => proxy.stop());

    const res = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "weclone-avatar",
          messages: "not-an-array",
        }),
      }
    );
    assert.equal(res.status, 400);
    const body = JSON.parse(await readResponse(res));
    assert.equal(body.error, "bad_request");
    assert.ok(
      typeof body.detail === "string" && body.detail.includes("array"),
      "Detail must mention the expected array type"
    );
  });

  it("preserves configured base path when forwarding to WeClone", async () => {
    let receivedUrl = "";
    const weclone = await createMockServer((req, res) => {
      receivedUrl = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (receivedUrl.startsWith("/weclone/v1/chat/completions")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" } }],
            })
          );
        } else if (receivedUrl.startsWith("/weclone/v1/models")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "m" }] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    cleanups.push(weclone.close);

    const remnic = await createMockServer((_req, res) => {
      res.writeHead(200);
      res.end(JSON.stringify({ results: [] }));
    });
    cleanups.push(remnic.close);

    const proxy = createWeCloneProxy(
      testConfig(weclone.port, remnic.port, {
        wecloneApiUrl: `http://127.0.0.1:${weclone.port}/weclone/v1`,
      })
    );
    await proxy.start();
    cleanups.push(() => proxy.stop());

    // Chat completions: should prepend /weclone/v1.
    const chatRes = await fetch(
      `http://127.0.0.1:${proxy.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      }
    );
    assert.equal(chatRes.status, 200);
    assert.equal(
      receivedUrl,
      "/weclone/v1/chat/completions",
      "Chat path must be prefixed with configured base path"
    );

    // Transparent proxy: GET /v1/models should also be prefixed.
    const modelsRes = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(modelsRes.status, 200);
    assert.equal(
      receivedUrl,
      "/weclone/v1/models",
      "Transparent proxy must also preserve base path"
    );
  });
});

describe("WeClone Installer", () => {
  it("generates instructions with --config flag matching CLI", async () => {
    // Dynamic import to avoid circular dependency issues
    const { generateWeCloneInstructions } = await import("./installer.js");
    const result = generateWeCloneInstructions({
      wecloneApiUrl: "http://localhost:8000/v1",
      proxyPort: 8100,
      remnicDaemonUrl: "http://localhost:4318",
      sessionStrategy: "single",
      memoryInjection: {
        maxTokens: 1500,
        position: "system-append",
        template: "[Memory]\n{memories}\n[/Memory]",
      },
    });

    assert.ok(
      result.instructions.includes("--config"),
      "Instructions should reference the --config flag"
    );
    assert.ok(
      !result.instructions.includes("--port"),
      "Instructions must not reference unsupported --port flag"
    );
    assert.ok(
      !result.instructions.includes("--weclone-api"),
      "Instructions must not reference unsupported --weclone-api flag"
    );
    assert.ok(
      !result.instructions.includes("--remnic-daemon"),
      "Instructions must not reference unsupported --remnic-daemon flag"
    );
    assert.ok(
      result.instructions.includes("remnic-weclone-proxy"),
      "Instructions should reference the correct binary name"
    );
  });
});
