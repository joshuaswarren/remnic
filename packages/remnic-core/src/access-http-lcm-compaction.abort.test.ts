import assert from "node:assert/strict";
import test from "node:test";

import { runLcmCompactionFlushHttp } from "./access-http-lcm-compaction.js";

test("#3077 aborted LCM flush does not start compaction", async () => {
  let calls = 0;
  const abortSignal = AbortSignal.abort();
  await assert.rejects(
    () =>
      runLcmCompactionFlushHttp({
        body: { sessionKey: "sess-1" },
        service: {
          async lcmCompactionFlush() {
            calls += 1;
            return { enabled: true, flushed: true, sessionKey: "sess-1", namespace: "default" };
          },
          async lcmCompactionRecord() {
            throw new Error("unused");
          },
        },
        ensureWriteRateLimitAvailable() {},
        recordWriteRateLimitHit() {},
        resolveNamespace: (namespace) => namespace,
        resolveRequestPrincipal: () => undefined,
        abortSignal,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(calls, 0);
});

test("#3077 aborted batch LCM flush rethrows instead of settling", async () => {
  const abort = new AbortController();
  let hits = 0;
  await assert.rejects(
    () =>
      runLcmCompactionFlushHttp({
        body: { sessionKey: "sess-1", namespaces: ["ns-a", "ns-b"] },
        service: {
          async lcmCompactionFlush() {
            abort.abort();
            return { enabled: true, flushed: true, sessionKey: "sess-1", namespace: "ns-a" };
          },
          async lcmCompactionRecord() {
            throw new Error("unused");
          },
        },
        ensureWriteRateLimitAvailable() {},
        recordWriteRateLimitHit() {
          hits += 1;
        },
        resolveNamespace: (namespace) => namespace,
        resolveRequestPrincipal: () => undefined,
        abortSignal: abort.signal,
      }),
    (err: unknown) => err instanceof Error && err.name === "AbortError",
  );
  assert.equal(hits, 1);
});
