import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * GET /mcp SSE half of the MCP streamable-HTTP transport (issue #2718).
 *
 * Clients such as the Grok Build TUI open a GET stream after `initialize`;
 * that stream is reserved for server-initiated messages and this server has
 * none to push, so it carries only SSE comment heartbeats — never a
 * JSON-RPC payload. Header/heartbeat/cleanup shape mirrors
 * `handleGraphEventsSSE` in access-http.ts (25 s heartbeat, cleanup
 * registered in the server's `sseCleanupFns` set so `stop()` releases the
 * interval even if the client never disconnects), but it subscribes to no
 * event bus, resolves no namespace, and ignores `Last-Event-ID`.
 *
 * Lives in a sibling module rather than access-http.ts so the handler does
 * not push that file past its fileSizeGrandfather ceiling (issue #1995).
 */
export function handleMcpGetSse(
  req: IncomingMessage,
  res: ServerResponse,
  sseCleanupFns: Set<() => void>,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, must-revalidate",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "transfer-encoding": "chunked",
  });

  // Comment-only frames: `: ping\n\n` is a valid SSE comment that carries no
  // data and cannot be mistaken for a JSON-RPC message. One is written
  // immediately so clients and proxies see the stream is live without
  // waiting for the first 25 s tick.
  const heartbeat = (): void => {
    try { res.write(": ping\n\n"); } catch { /* client gone; cleanup fires via "close" */ }
  };
  heartbeat();
  const heartbeatInterval = setInterval(heartbeat, 25_000);

  const cleanup = (): void => {
    clearInterval(heartbeatInterval);
    sseCleanupFns.delete(cleanup);
    try { res.end(); } catch { /* ignore */ }
  };
  sseCleanupFns.add(cleanup);

  req.once("close", cleanup);
  req.once("error", cleanup);
}
