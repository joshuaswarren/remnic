import assert from "node:assert/strict";
import { test } from "node:test";

import { XCreditsDepletedError, XMcpClient, XMcpError, parseSseData } from "./mcp-client.js";
import { XRefreshChainBrokenError, XTokenError } from "./token-store.js";

interface FetchCall {
  method: string;
  body: string;
  headers: Record<string, string>;
}

type ToolStep =
  | { kind: "status"; status: number }
  | { kind: "tool"; text: string; isError?: boolean; sse?: boolean }
  | { kind: "rpcError"; message: string; code?: number };

interface Script {
  sessionHeader: string;
  toolScript: ToolStep[];
  calls: FetchCall[];
  sleeps: number[];
}

/**
 * Request-driven fake X MCP server: initialize and notifications always
 * succeed, tools/call pops the next scripted step and echoes the
 * request id — immune to the client's internal id allocation.
 */
function makeClient(toolScript: ToolStep[], sessionHeader = "sess-42"): { client: XMcpClient; script: Script } {
  const script: Script = { sessionHeader, toolScript, calls: [], sleeps: [] };
  const client = new XMcpClient({
    tokenProvider: async () => "user-token-not-real",
    fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const message = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        id?: number;
        method?: string;
      };
      script.calls.push({
        method: message.method ?? "?",
        body: typeof init?.body === "string" ? init.body : "",
        headers,
      });
      if (message.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "xmcp" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": script.sessionHeader } }
        );
      }
      if (message.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      const step = script.toolScript.shift();
      if (step === undefined) throw new Error("unexpected extra tools/call");
      if (step.kind === "status") {
        return new Response(JSON.stringify({ detail: "status" }), {
          status: step.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (step.kind === "rpcError") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: step.message } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      const envelope = {
        jsonrpc: "2.0",
        id: message.id,
        result: { isError: step.isError === true, content: [{ type: "text", text: step.text }] },
      };
      return step.sse === true
        ? new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          })
        : new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }) as typeof fetch,
    sleep: async (ms: number) => {
      script.sleeps.push(ms);
    },
  });
  return { client, script };
}

test("initialize → notification → tools/call carries session id and bearer", async () => {
  const { client, script } = makeClient([{ kind: "tool", text: '{"data":[]}' }]);
  const result = await client.callTool("get_users_bookmarks", { max_results: 5 });
  assert.equal(result.isError, false);
  assert.deepEqual(
    script.calls.map((call) => call.method),
    ["initialize", "notifications/initialized", "tools/call"]
  );
  const toolCall = script.calls[2];
  assert.equal(toolCall.headers["Mcp-Session-Id"], "sess-42");
  assert.equal(toolCall.headers.Authorization, "Bearer user-token-not-real");
  assert.equal(JSON.parse(script.calls[0].body).params.protocolVersion, "2025-06-18");
  assert.deepEqual(JSON.parse(toolCall.body).params, { name: "get_users_bookmarks", arguments: { max_results: 5 } });
});

test("parses SSE (text/event-stream) responses", async () => {
  const { client } = makeClient([{ kind: "tool", text: '{"data":[{"id":"1"}]}', sse: true }]);
  const result = await client.callTool("get_users_bookmarks", {});
  assert.deepEqual(result.texts, ['{"data":[{"id":"1"}]}']);
});

test("parseSseData decodes data lines and skips keep-alives", () => {
  const values = parseSseData(': ping\ndata: {"a":1}\n\ndata: not-json\n');
  assert.deepEqual(values, [{ a: 1 }]);
});

test("HTTP 402 maps to XCreditsDepletedError", async () => {
  const { client } = makeClient([{ kind: "status", status: 402 }]);
  await assert.rejects(client.callTool("t", {}), XCreditsDepletedError);
});

test("402-in-tool-result (isError payload) maps to XCreditsDepletedError", async () => {
  const { client } = makeClient([{ kind: "tool", text: '{"detail":"credits depleted","status":402}', isError: true }]);
  await assert.rejects(client.callTool("get_users_bookmarks", {}), XCreditsDepletedError);
});

test("JSON-RPC error surfaces as XMcpError with detail", async () => {
  const { client } = makeClient([{ kind: "rpcError", message: "bad args" }]);
  await assert.rejects(client.callTool("t", {}), (err: unknown) => {
    assert.ok(err instanceof XMcpError);
    assert.match(err.message, /bad args/);
    return true;
  });
});

test("401 surfaces the refresh-chain hint", async () => {
  const { client } = makeClient([{ kind: "status", status: 401 }]);
  await assert.rejects(client.callTool("t", {}), /refresh chain is broken/);
});

test("session 404 re-initializes once and retries the call", async () => {
  const { client, script } = makeClient([
    { kind: "status", status: 404 },
    { kind: "tool", text: '{"data":[]}' },
  ]);
  const result = await client.callTool("t", {});
  assert.equal(result.isError, false);
  assert.deepEqual(
    script.calls.map((call) => call.method),
    [
      "initialize",
      "notifications/initialized",
      "tools/call", // 404 → session dropped
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]
  );
});

test("429 retries with backoff then succeeds", async () => {
  const { client, script } = makeClient([
    { kind: "status", status: 429 },
    { kind: "tool", text: '{"data":[]}' },
  ]);
  const result = await client.callTool("t", {});
  assert.equal(result.isError, false);
  assert.deepEqual(script.sleeps, [500]);
});

test("requires a tokenProvider", () => {
  assert.throws(
    () => new XMcpClient({ tokenProvider: undefined as unknown as () => Promise<string> }),
    /tokenProvider/
  );
});

test("token-provider failure runs once, propagates as XTokenError, never fetches", async () => {
  const failure = new XRefreshChainBrokenError("grant revoked");
  let tokenCalls = 0;
  let fetchCalls = 0;
  const client = new XMcpClient({
    tokenProvider: async () => {
      tokenCalls += 1;
      throw failure;
    },
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    sleep: async () => {},
  });
  await assert.rejects(
    client.callTool("get_users_bookmarks", {}),
    (err: unknown): boolean =>
      err instanceof XTokenError &&
      err instanceof XRefreshChainBrokenError &&
      err === failure &&
      err.message === failure.message,
  );
  assert.equal(tokenCalls, 1);
  assert.equal(fetchCalls, 0);
});
