import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";

import { RemnicClient, RemnicHttpError, RemnicRequestAbortedError, RemnicRequestTimeoutError } from "./client.js";
import { DEFAULT_CONFIG } from "./config.js";

for (const transport of ["rest", "remnic.memory_store", "remnic_memory_store"] as const) {
  test(`${transport} store retries 503 once with an unchanged idempotent payload`, async (t) => {
    t.mock.method(Math, "random", () => 0);
    const bodies: Record<string, any>[] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      if (bodies.length === 1) return new Response("No server is available", { status: 503 });
      return Response.json(transport === "rest" ? { status: "stored" } : { result: { status: "stored" } });
    });
    const client = new RemnicClient(DEFAULT_CONFIG);
    const result = transport === "rest"
      ? await client.storeMemory("remember", "session")
      : await client.mcpTool(transport, { content: "remember", sessionKey: "session" });
    assert.deepEqual(result, { status: "stored" });
    assert.equal(bodies.length, 2);
    const firstArgs = transport === "rest" ? bodies[0] : bodies[0].params.arguments;
    const retryArgs = transport === "rest" ? bodies[1] : bodies[1].params.arguments;
    assert.match(firstArgs.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.deepEqual(firstArgs, retryArgs, "retries must reuse the exact write payload");
  });
}

test("MCP store preserves a caller-provided idempotency key", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const keys: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    keys.push(JSON.parse(String(init.body)).params.arguments.idempotencyKey);
    return keys.length === 1 ? new Response("busy", { status: 503 }) : Response.json({ result: {} });
  });
  const args = { content: "remember", idempotencyKey: "caller-key" };
  await new RemnicClient(DEFAULT_CONFIG).mcpTool("remnic_memory_store", args);
  assert.deepEqual(keys, ["caller-key", "caller-key"]);
  assert.deepEqual(args, { content: "remember", idempotencyKey: "caller-key" });
});

test("independent stores receive distinct idempotency keys", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    keys.push(JSON.parse(String(init.body)).idempotencyKey);
    return Response.json({ status: "stored" });
  });
  const client = new RemnicClient(DEFAULT_CONFIG);
  await client.storeMemory("same content", "session");
  await client.storeMemory("same content", "session");
  assert.equal(new Set(keys).size, 2);
  assert.ok(keys.every((key) => typeof key === "string" && key.length > 0));
});

test("store jitter delays initial and retry sends with a bounded backoff", async (t) => {
  t.mock.method(Math, "random", () => 0.999999);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sends: number[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    sends.push(Date.now());
    return sends.length === 1 ? new Response("busy", { status: 503 }) : Response.json({ status: "stored" });
  });
  const pending = new RemnicClient(DEFAULT_CONFIG).storeMemory("remember", "session");
  await setImmediate();
  assert.deepEqual(sends, [], "initial send must wait for jitter");
  t.mock.timers.tick(249);
  await setImmediate();
  assert.deepEqual(sends, []);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(sends, [250]);
  t.mock.timers.tick(449);
  await setImmediate();
  assert.deepEqual(sends, [250]);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: "stored" });
  assert.deepEqual(sends, [250, 700], "retry backoff is 200ms plus at most 250ms jitter");
});

for (const failure of ["503", "timeout", "socket"] as const) {
  test(`store stops after one retry on repeated ${failure} failures`, async (t) => {
    t.mock.method(Math, "random", () => 0);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      calls++;
      if (failure === "503") return new Response("busy", { status: 503 });
      if (failure === "socket") throw new Error("socket closed");
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    });
    const client = new RemnicClient({ ...DEFAULT_CONFIG, requestTimeoutMs: 2 });
    await assert.rejects(client.storeMemory("remember", "session", { maxRetries: 99 }), (err) => {
      if (failure === "timeout") assert.ok(err instanceof RemnicRequestTimeoutError);
      else if (failure === "503") assert.ok(err instanceof RemnicHttpError && err.status === 503);
      else assert.match(String(err), /socket closed/);
      return true;
    });
    assert.equal(calls, 2, "store retry count must never exceed one");
  });
}

test("store retries a timeout successfully using the same key", async (t) => {
  t.mock.method(Math, "random", () => 0);
  const keys: string[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
    keys.push(JSON.parse(String(init.body)).idempotencyKey);
    if (keys.length === 1) {
      const { promise, reject } = Promise.withResolvers<Response>();
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      return promise;
    }
    return Response.json({ status: "stored", idempotencyReplay: true });
  });
  const client = new RemnicClient({ ...DEFAULT_CONFIG, requestTimeoutMs: 2 });
  assert.deepEqual(await client.storeMemory("remember", "session"), { status: "stored", idempotencyReplay: true });
  assert.equal(keys.length, 2);
  assert.equal(typeof keys[0], "string");
  assert.equal(keys[0], keys[1]);
});

for (const status of [400, 401, 409, 500]) {
  test(`store does not retry HTTP ${status}`, async (t) => {
    t.mock.method(Math, "random", () => 0);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("rejected", { status });
    });
    await assert.rejects(new RemnicClient(DEFAULT_CONFIG).storeMemory("remember", "session"));
    assert.equal(calls, 1);
  });
}

for (const duringRetry of [false, true]) {
  test(`store honors cancellation during ${duringRetry ? "retry backoff" : "initial jitter"}`, async (t) => {
    t.mock.method(Math, "random", () => 0.999999);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("busy", { status: 503 });
    });
    const controller = new AbortController();
    const pending = new RemnicClient(DEFAULT_CONFIG).storeMemory("remember", "session", { signal: controller.signal });
    const rejected = assert.rejects(pending, RemnicRequestAbortedError);
    if (duringRetry) {
      t.mock.timers.tick(250);
      await setImmediate();
      assert.equal(calls, 1);
    }
    controller.abort();
    await rejected;
    t.mock.timers.tick(1000);
    assert.equal(calls, duringRetry ? 1 : 0);
  });
}

test("store maxRetries zero disables retry", async (t) => {
  t.mock.method(Math, "random", () => 0);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("busy", { status: 503 });
  });
  await assert.rejects(new RemnicClient(DEFAULT_CONFIG).storeMemory("remember", "session", { maxRetries: 0 }));
  assert.equal(calls, 1);
});
