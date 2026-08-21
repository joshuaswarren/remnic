import test from "node:test";
import assert from "node:assert/strict";
import { RemoteSearchBackend } from "../src/search/remote-backend.js";

function abortError(message: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, "name", { value: "AbortError" });
  return err;
}

test("remote search backend forwards caller abort signals to fetch", async () => {
  const backend = new RemoteSearchBackend({
    baseUrl: "https://example.com",
    timeoutMs: 1_000,
  });
  (backend as any).available = true;

  const callerAbortController = new AbortController();
  const originalFetch = globalThis.fetch;
  let observedSignal: AbortSignal | undefined;

  globalThis.fetch = (async (_input, init) => {
    observedSignal = init?.signal as AbortSignal | undefined;
    return await new Promise<Response>((_resolve, reject) => {
      observedSignal?.addEventListener("abort", () => reject(abortError("caller aborted")), { once: true });
    });
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const searchPromise = backend.search(
      "remote abort",
      "test-collection",
      5,
      undefined,
      { signal: callerAbortController.signal },
    );
    setTimeout(() => callerAbortController.abort(), 5);

    const result = await searchPromise;
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result, []);
    assert.ok(observedSignal);
    assert.notEqual(observedSignal, callerAbortController.signal);
    assert.equal(observedSignal?.aborted, true);
    assert.ok(elapsedMs < 150, `expected caller abort to resolve promptly, saw ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote search backend still applies timeout when no caller signal is provided", async () => {
  const backend = new RemoteSearchBackend({
    baseUrl: "https://example.com",
    timeoutMs: 25,
  });
  (backend as any).available = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_input, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    return await new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("expected timeout signal to abort fetch")), 250);
      signal?.addEventListener("abort", () => reject(abortError("timed out")), { once: true });
      signal?.addEventListener("abort", () => clearTimeout(watchdog), { once: true });
    });
  }) as typeof fetch;

  try {
    const startedAt = Date.now();
    const result = await backend.search("timeout only", "test-collection", 5);
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result, []);
    assert.ok(elapsedMs >= 15, `expected timeout guard to remain active, saw ${elapsedMs}ms`);
    assert.ok(elapsedMs < 250, `expected timeout guard to resolve promptly, saw ${elapsedMs}ms`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
