import assert from "node:assert/strict";
import test from "node:test";

import { RemnicClient, RemnicHttpError } from "./client.js";
import type { RemnicPiConfig } from "./config.js";

test("RemnicClient reports request timeouts with actionable context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 1 });

  await assert.rejects(
    () => client.health(),
    /Remnic request timed out after 1ms/,
  );
});

function baseConfig(): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: true,
    observeEnabled: true,
    observeSkipExtraction: false,
    compactionEnabled: true,
    mcpToolsEnabled: true,
    statusEnabled: true,
    requestTimeoutMs: 60000,
  };
}

test("RemnicClient preserves HTTP status for non-JSON daemon errors", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(err instanceof RemnicHttpError);
      assert.equal(err.status, 502);
      assert.match(err.message, /Bad Gateway/);
      return true;
    },
  );
});

test("RemnicClient preserves HTTP status for non-JSON internal server errors", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    (err) => {
      assert.ok(err instanceof RemnicHttpError);
      assert.equal(err.status, 500);
      assert.match(err.message, /Internal Server Error/);
      return true;
    },
  );
});


test("RemnicClient reports invalid JSON clearly for successful daemon responses", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not-json", { status: 200, statusText: "OK" });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient(baseConfig());

  await assert.rejects(
    () => client.health(),
    /Invalid JSON response from Remnic daemon/,
  );
});
