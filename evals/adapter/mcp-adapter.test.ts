import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createMcpAdapter } from "./mcp-adapter.js";
import type { Message } from "./types.js";

test("MCP adapter reset isolates later searches from prior run sessions", async () => {
  const stored = new Map<string, Message[]>();
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readRequestJson(req);
    const params = (body.params ?? {}) as Record<string, unknown>;
    let result: unknown = null;

    if (body.method === "engram.lcm.observe") {
      const sessionId = String(params.sessionId ?? "");
      stored.set(sessionId, params.messages as Message[]);
      result = { accepted: (params.messages as Message[]).length };
    } else if (body.method === "engram.lcm.search") {
      const query = String(params.query ?? "");
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : undefined;
      const rows = [...stored.entries()]
        .filter(([storedSessionId]) => !sessionId || storedSessionId === sessionId)
        .flatMap(([storedSessionId, messages]) =>
          messages
            .filter((message) => message.content.includes(query))
            .map((message, index) => ({
              turn_index: index,
              role: message.role,
              snippet: message.content,
              session_id: storedSessionId,
            })),
        );
      result = rows;
    } else if (body.method === "engram.lcm.recall") {
      const sessionId = String(params.sessionId ?? "");
      const query = String(params.query ?? "");
      result = (stored.get(sessionId) ?? [])
        .filter((message) => message.content.includes(query))
        .map((message) => message.content)
        .join("\n");
    } else if (body.method === "engram.lcm.stats") {
      result = { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, result }));
  });

  try {
    const baseUrl = await listen(server);
    const adapter = await createMcpAdapter({ baseUrl });

    await adapter.store("shared-session", [
      { role: "user", content: "old unique marker" },
    ]);
    assert.equal((await adapter.search("old unique marker", 10)).length, 1);

    await adapter.reset();
    assert.deepEqual(await adapter.search("old unique marker", 10), []);
    assert.equal(await adapter.recall("shared-session", "old unique marker"), "");

    await adapter.store("shared-session", [
      { role: "user", content: "new unique marker" },
    ]);
    const currentResults = await adapter.search("new unique marker", 10);
    assert.equal(currentResults.length, 1);
    assert.equal(currentResults[0]?.sessionId, "shared-session");

    await adapter.destroy();
  } finally {
    await close(server);
  }
});

async function readRequestJson(req: http.IncomingMessage): Promise<{
  id?: unknown;
  method?: string;
  params?: unknown;
}> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
  }
  return JSON.parse(raw) as { id?: unknown; method?: string; params?: unknown };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
