import assert from "node:assert/strict";
import test from "node:test";

import {
  completeBackgroundGeneration,
  parseBackgroundGenerationJson,
} from "./background-generation.js";

test("completeBackgroundGeneration posts to the dedicated endpoint with the bearer", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"bullets":["one"]}' } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const text = await completeBackgroundGeneration(
    {
      backgroundGeneration: {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "bridge-token-fixture",
        timeoutSeconds: 12,
      },
    },
    [{ role: "user", content: "summarize" }],
    fetchImpl,
  );

  assert.equal(text, '{"bullets":["one"]}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:8765/v1/chat/completions");
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer bridge-token-fixture");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(
    calls[0]?.init.body,
    JSON.stringify({ messages: [{ role: "user", content: "summarize" }] }),
  );
});

test("completeBackgroundGeneration refuses an unconfigured client", async () => {
  await assert.rejects(
    () => completeBackgroundGeneration({}, [{ role: "user", content: "x" }]),
    /not configured/,
  );
});

test("parseBackgroundGenerationJson keeps the first valid candidate", () => {
  const parsed = parseBackgroundGenerationJson(
    'preamble {"bullets":["kept"]} trailing',
    (value) => {
      const record = value as { bullets?: string[] };
      if (!Array.isArray(record.bullets)) throw new Error("no bullets");
      return record.bullets;
    },
  );
  assert.deepEqual(parsed, ["kept"]);
});
