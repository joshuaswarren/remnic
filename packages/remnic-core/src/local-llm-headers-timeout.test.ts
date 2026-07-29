import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  Agent,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

import { LocalLlmClient } from "./local-llm.js";
import { ChatTransport } from "./local-llm-transport.js";
import type { PluginConfig } from "./types.js";

/**
 * Issue #2148: `localLlmTimeoutMs` above 300s was dead letter.
 *
 * Node's global fetch runs on undici, whose default `headersTimeout` is
 * 300s. A non-streaming completion emits its response headers only after
 * generation finishes, so every completion slower than five minutes died
 * with a bare `fetch failed` no matter how large the configured budget was.
 *
 * The fix hands the chat fetch an undici `Agent` whose header/body
 * inactivity budgets track `localLlmTimeoutMs`. These tests pin the three
 * links in that chain: the dispatcher is passed, the runtime honors a
 * passed dispatcher, and the dispatcher carries the configured budget.
 *
 * These are integration tests over a real socket: the behavior under test
 * IS undici's wall-clock inactivity timer, which fake timers cannot drive.
 * Delays are kept small, and every budget/delay pair leaves ~1s of room
 * because undici's timer wheel is coarse (a sub-second budget can fire up
 * to roughly a second late).
 */

function createConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmTimeoutMs: 1_000,
    localLlmRetry5xxCount: 0,
    localLlmRetryBackoffMs: 1,
    localLlmHeaders: {},
    localLlmApiKey: undefined,
    localLlmAuthHeader: false,
    localLlm400TripThreshold: 3,
    localLlm400CooldownMs: 60_000,
    debug: false,
    localLlmReasoningEffort: "none",
    slowLogEnabled: false,
    slowLogThresholdMs: 1_000,
    ...overrides,
  } as unknown as PluginConfig;
}

function primeClient(client: LocalLlmClient): void {
  // Pin the health probe so chatCompletion() reaches the fetch under test.
  const internals = client as unknown as {
    isAvailable: boolean;
    lastHealthCheck: number;
    detectedType: string | null;
  };
  internals.isAvailable = true;
  internals.lastHealthCheck = Date.now();
  internals.detectedType = "generic";
}

function clientIsAvailable(client: LocalLlmClient): boolean {
  const internals = client as unknown as { isAvailable: boolean };
  return internals.isAvailable;
}

/** Test seam: the pool is private, but its budget is what we assert on. */
function dispatcherOf(client: LocalLlmClient): Agent {
  const seam = client as unknown as {
    chatTransport: ChatTransport;
    config: PluginConfig;
  };
  const agent = seam.chatTransport.dispatcherFor(seam.config.localLlmTimeoutMs);
  assert.ok(agent, "expected a widened pool under the default global dispatcher");
  return agent;
}

function undiciErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("cause" in err)) return undefined;
  const cause = err.cause;
  if (!cause || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

function dispatcherOfInit(init: unknown): unknown {
  if (!init || typeof init !== "object" || !("dispatcher" in init)) return undefined;
  return init.dispatcher;
}

/** Server that withholds response headers for `delayMs`, then answers. */
async function startSlowHeaderServer(delayMs: number): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const pending = new Set<NodeJS.Timeout>();
  const server = http.createServer((_req, res) => {
    const timer = setTimeout(() => {
      pending.delete(timer);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "slow but complete" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }, delayMs);
    pending.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startTricklingBodyServer(chunkIntervalMs: number, status = 200): Promise<{
  url: string;
  requestBodies: string[];
  close: () => Promise<void>;
}> {
  const pending = new Set<NodeJS.Timeout>();
  const requestBodies: string[] = [];
  const payload = JSON.stringify({
    choices: [{ message: { content: "late completion" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const chunkSize = Math.ceil(payload.length / 16);
  const chunks = Array.from(
    { length: 16 },
    (_, index) => payload.slice(index * chunkSize, (index + 1) * chunkSize),
  ).filter((chunk) => chunk.length > 0);
  const server = http.createServer((req, res) => {
    let requestBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    req.on("end", () => {
      requestBodies.push(requestBody);
      res.writeHead(status, { "content-type": "application/json" });
      res.flushHeaders();
      let index = 0;
      const interval = setInterval(() => {
        const chunk = chunks[index];
        index += 1;
        if (chunk !== undefined) res.write(chunk);
        if (index >= chunks.length) {
          clearInterval(interval);
          pending.delete(interval);
          res.end();
        }
      }, chunkIntervalMs);
      pending.add(interval);
      res.once("close", () => {
        clearInterval(interval);
        pending.delete(interval);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requestBodies,
    close: async () => {
      for (const interval of pending) clearInterval(interval);
      pending.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("chat completion passes an undici dispatcher to fetch", async () => {
  const original = globalThis.fetch;
  let seenDispatcher: unknown;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    seenDispatcher = dispatcherOfInit(init);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new LocalLlmClient(createConfig());
    primeClient(client);
    const result = await client.chatCompletion([
      { role: "user", content: "hello" },
    ]);
    assert.equal(result?.content, "ok");
    assert.ok(
      seenDispatcher instanceof Agent,
      "chat fetch must carry an undici Agent so headersTimeout tracks localLlmTimeoutMs",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("runtime honors a per-request dispatcher (regression canary for #2148)", async () => {
  // The fix assumes fetch applies `init.dispatcher`. If a future runtime
  // silently ignores it, the 300s cap returns with no other signal — so
  // assert the mechanism itself rather than trusting it.
  const server = await startSlowHeaderServer(2_500);
  const tight = new Agent({ headersTimeout: 250, bodyTimeout: 250 });
  try {
    await assert.rejects(
      () =>
        fetch(`${server.url}/chat/completions`, {
          dispatcher: tight,
        } as RequestInit & { dispatcher: Agent }),
      (err: unknown) => {
        const code = undiciErrorCode(err);
        assert.equal(
          code,
          "UND_ERR_HEADERS_TIMEOUT",
          `expected the passed dispatcher's headersTimeout to fire, got ${String(code)}`,
        );
        return true;
      },
    );
  } finally {
    await tight.close();
    await server.close();
  }
});

test("client dispatcher carries the configured budget, not undici's default", async () => {
  // One server, two budgets: the only variable is localLlmTimeoutMs.
  const server = await startSlowHeaderServer(2_500);
  const pools: Agent[] = [];
  try {
    const impatient = new LocalLlmClient(createConfig({ localLlmTimeoutMs: 200 }));
    const impatientPool = dispatcherOf(impatient);
    pools.push(impatientPool);
    await assert.rejects(
      () =>
        undiciFetch(`${server.url}/chat/completions`, {
          dispatcher: impatientPool,
        }),
      (err: unknown) => undiciErrorCode(err) === "UND_ERR_HEADERS_TIMEOUT",
      "a 200ms budget must cap the header wait well before the 2.5s response",
    );

    const patient = new LocalLlmClient(createConfig({ localLlmTimeoutMs: 30_000 }));
    const patientPool = dispatcherOf(patient);
    pools.push(patientPool);
    const res = await undiciFetch(`${server.url}/chat/completions`, {
      dispatcher: patientPool,
    });
    assert.equal(res.status, 200);
    await res.body?.cancel();
  } finally {
    // Client-owned pools keep keep-alive sockets open past the request.
    for (const pool of pools) await pool.close();
    await server.close();
  }
});

test("dispatcher is cached per client and rebuilt when the budget changes", async () => {
  const client = new LocalLlmClient(createConfig({ localLlmTimeoutMs: 5_000 }));

  const first = dispatcherOf(client);
  assert.equal(dispatcherOf(client), first, "same budget must reuse one pool");

  const mutable = client as unknown as { config: PluginConfig };
  mutable.config = createConfig({ localLlmTimeoutMs: 9_000 });
  const rebuilt = dispatcherOf(client);
  assert.notEqual(rebuilt, first, "a changed budget must rebuild the pool");

  await first.close();
  await rebuilt.close();
});

test("a completion whose headers lag the request still succeeds", async () => {
  // Scaled-down proxy for the production shape: generation (and therefore
  // the response head) outlasts undici's default cap. Survivable only
  // because the pool now tracks the configured budget.
  const server = await startSlowHeaderServer(700);
  const client = new LocalLlmClient(
    createConfig({ localLlmUrl: server.url, localLlmTimeoutMs: 30_000 }),
  );
  try {
    primeClient(client);
    const result = await client.chatCompletion([
      { role: "user", content: "extract facts" },
    ]);
    assert.equal(result?.content, "slow but complete");
  } finally {
    await dispatcherOf(client).close();
    await server.close();
  }
});

test("the request budget covers a trickling response body", async () => {
  const timeoutMs = 250;
  const server = await startTricklingBodyServer(75);
  const client = new LocalLlmClient(
    createConfig({ localLlmUrl: server.url, localLlmTimeoutMs: timeoutMs }),
  );
  try {
    primeClient(client);
    const startedAt = Date.now();
    const result = await client.chatCompletion([
      { role: "user", content: "extract facts" },
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result, null);
    assert.ok(
      elapsedMs < 800,
      `response body must abort near the ${timeoutMs}ms request budget; elapsed ${elapsedMs}ms`,
    );
    const requestBody: unknown = JSON.parse(server.requestBodies[0] ?? "{}");
    assert.ok(requestBody && typeof requestBody === "object" && "stream" in requestBody);
    assert.equal(requestBody.stream, false);
  } finally {
    await dispatcherOf(client).close();
    await server.close();
  }
});

test("caller abort during body consumption remains cancellation for an arbitrary reason", async () => {
  const original = globalThis.fetch;
  const caller = new AbortController();
  let calls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls += 1;
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    queueMicrotask(() => caller.abort(new Error("caller cancelled")));
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const client = new LocalLlmClient(createConfig({ localLlmRetry5xxCount: 2 }));
  try {
    primeClient(client);
    const result = await client.chatCompletion(
      [{ role: "user", content: "extract facts" }],
      { signal: caller.signal },
    );
    assert.equal(result, null);
    assert.equal(calls, 1);
    assert.equal(clientIsAvailable(client), true);
  } finally {
    globalThis.fetch = original;
    await dispatcherOf(client).close();
  }
});

test("a timed-out 400 body is accounted once and enters cooldown", async () => {
  const server = await startTricklingBodyServer(75, 400);
  const client = new LocalLlmClient(
    createConfig({
      localLlmUrl: server.url,
      localLlmTimeoutMs: 250,
      localLlmRetry5xxCount: 2,
      localLlm400TripThreshold: 1,
    }),
  );
  try {
    primeClient(client);
    assert.equal(
      await client.chatCompletion([{ role: "user", content: "extract facts" }]),
      null,
    );
    assert.equal(server.requestBodies.length, 1);
    assert.equal(
      await client.chatCompletion([{ role: "user", content: "extract facts again" }]),
      null,
    );
    assert.equal(server.requestBodies.length, 1, "cooldown must stop a second request");
  } finally {
    await dispatcherOf(client).close();
    await server.close();
  }
});

test("a truncated 503 body retains the configured retry", async () => {
  const original = globalThis.fetch;
  const encoder = new TextEncoder();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"error":'));
          controller.error(new TypeError("terminated"));
        },
      });
      return new Response(body, {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "retry succeeded" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const client = new LocalLlmClient(
    createConfig({ localLlmRetry5xxCount: 1, localLlmRetryBackoffMs: 1 }),
  );
  try {
    primeClient(client);
    const result = await client.chatCompletion([
      { role: "user", content: "extract facts" },
    ]);
    assert.equal(result?.content, "retry succeeded");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    await dispatcherOf(client).close();
  }
});

test("a process-wide custom dispatcher is left in place", async () => {
  // A deployment may reach the local endpoint only through a ProxyAgent (or
  // another custom connect/TLS/DNS transport) installed with
  // setGlobalDispatcher. Swapping in our own pool would bypass it and break
  // the request outright, so the widened pool must stand down.
  const original = getGlobalDispatcher();
  const proxy = new ProxyAgent("http://127.0.0.1:9");
  try {
    setGlobalDispatcher(proxy);
    const transport = new ChatTransport();
    assert.equal(
      transport.dispatcherFor(900_000),
      undefined,
      "must not displace a non-Agent global dispatcher",
    );
  } finally {
    setGlobalDispatcher(original);
    await proxy.close();
  }

  // ...and the widened pool returns once the default transport is back.
  const restored = new ChatTransport().dispatcherFor(900_000);
  assert.ok(restored);
  await restored.close();
});

test("aborting during a retry backoff stops the local request lane", async () => {
  const original = globalThis.fetch;
  const abortController = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    setTimeout(() => abortController.abort(new Error("deadline")), 10);
    return new Response("temporary failure", { status: 503 });
  }) as typeof fetch;

  try {
    const client = new LocalLlmClient(
      createConfig({ localLlmRetry5xxCount: 2, localLlmRetryBackoffMs: 5_000 }),
    );
    primeClient(client);
    const result = await client.chatCompletion(
      [{ role: "user", content: "extract facts" }],
      { signal: abortController.signal },
    );
    assert.equal(result, null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("availability probes stop after the caller aborts", async () => {
  const abortController = new AbortController();
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    if (requests === 1) abortController.abort();
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const client = new LocalLlmClient(
      createConfig({ localLlmUrl: `http://127.0.0.1:${port}/v1` }),
    );
    assert.equal(await client.checkAvailability(abortController.signal), false);
    assert.equal(requests, 1, "an aborted availability check must not start later probes");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
