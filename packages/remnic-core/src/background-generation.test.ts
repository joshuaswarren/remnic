import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  completeBackgroundGeneration,
  parseBackgroundGenerationJson,
} from "./background-generation.js";
import { parseConfig } from "./config.js";
import { HourlySummarizer } from "./summarizer.js";

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

test("HourlySummarizer uses backgroundGeneration and not openaiBaseUrl", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-bg-summary-"));
  const previousFetch = globalThis.fetch;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = memoryDir;
  const calls: string[] = [];
  try {
    const config = parseConfig({
      memoryDir,
      openaiApiKey: "keep-me",
      openaiBaseUrl: "http://127.0.0.1:9999/v1",
      backgroundGeneration: {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "bridge-token-fixture",
        timeoutSeconds: 12,
      },
    });
    let sentBody: string | undefined;
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (String(url) !== "http://127.0.0.1:8765/v1/chat/completions") {
        return new Response("not the bridge", { status: 404 });
      }
      sentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"bullets":["bridge-only"]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const summarizer = new HourlySummarizer(config);
    const summary = await summarizer.generateSummary(
      "session-bridge",
      new Date("2026-08-23T10:00:00.000Z"),
      [
        {
          timestamp: "2026-08-23T10:01:00.000Z",
          role: "user",
          content: "ship the bridge",
          sessionKey: "session-bridge",
          turnId: "t1",
        },
      ],
    );

    assert.deepEqual(summary?.bullets, ["bridge-only"]);
    assert.deepEqual(calls, ["http://127.0.0.1:8765/v1/chat/completions"]);
    assert.equal(config.openaiBaseUrl, "http://127.0.0.1:9999/v1");
    // The bridge prompt must spell out the required JSON shape; without it a
    // literal host model returns {"summary": "..."} and the schema rejects it.
    const sent = JSON.parse(String(sentBody)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = sent.messages.find((message) => message.role === "system")?.content ?? "";
    assert.match(system, /"bullets"/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(memoryDir, { recursive: true, force: true });
  }
});

test("HourlySummarizer routes extended summaries through backgroundGeneration", async () => {
  const memoryDir = mkdtempSync(path.join(tmpdir(), "remnic-bg-extended-"));
  const previousFetch = globalThis.fetch;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = memoryDir;
  const calls: string[] = [];
  try {
    const config = parseConfig({
      memoryDir,
      openaiApiKey: "keep-me",
      openaiBaseUrl: "http://127.0.0.1:9999/v1",
      hourlySummariesExtendedEnabled: true,
      backgroundGeneration: {
        endpoint: "http://127.0.0.1:8765/v1/chat/completions",
        token: "bridge-token-fixture",
        timeoutSeconds: 12,
      },
    });
    let sentBody: string | undefined;
    globalThis.fetch = (async (url, init) => {
      calls.push(String(url));
      if (String(url) !== "http://127.0.0.1:8765/v1/chat/completions") {
        return new Response("not the bridge", { status: 404 });
      }
      sentBody = String(init?.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"topics":["bridge-topic"],"decisions":["ship it"],"actionItems":["land the PR"],"rejected":[]}',
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const summarizer = new HourlySummarizer(config);
    const summary = await summarizer.generateSummary(
      "session-bridge",
      new Date("2026-08-23T10:00:00.000Z"),
      [
        {
          timestamp: "2026-08-23T10:01:00.000Z",
          role: "user",
          content: "ship the bridge",
          sessionKey: "session-bridge",
          turnId: "t1",
        },
      ],
    );

    assert.deepEqual(summary?.bullets, ["bridge-topic"]);
    const extended = (summary as { _extended?: { topics: string[]; decisions: string[]; actionItems: string[]; rejected: string[] } })._extended;
    assert.deepEqual(extended?.topics, ["bridge-topic"]);
    assert.deepEqual(extended?.decisions, ["ship it"]);
    assert.deepEqual(extended?.actionItems, ["land the PR"]);
    assert.deepEqual(extended?.rejected, []);
    assert.deepEqual(calls, ["http://127.0.0.1:8765/v1/chat/completions"]);
    assert.equal(config.openaiBaseUrl, "http://127.0.0.1:9999/v1");
    const sent = JSON.parse(String(sentBody)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = sent.messages.find((message) => message.role === "system")?.content ?? "";
    assert.match(system, /"topics"/);
    assert.match(system, /"decisions"/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    rmSync(memoryDir, { recursive: true, force: true });
  }
});
