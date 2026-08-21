/**
 * Local-LLM record/replay mock server (issue #566 slice 5).
 *
 * Spins up a tiny HTTP server that serves canned `/v1/chat/completions`
 * and `/v1/models` responses recorded from an OpenAI-compatible server
 * (llama.cpp / vLLM / LM Studio). Used by the local-llm CI smoke test
 * so that `remnic bench published --provider local-llm` exercises the
 * real fetch → JSON → usage-accounting path without a paid API call.
 *
 * Usage:
 *
 *   const server = await startLocalLlmMockServer();
 *   try {
 *     const provider = createLocalLlmProvider({
 *       provider: "local-llm",
 *       model: "local-llm-fixture-small",
 *       baseUrl: server.baseUrl,
 *     });
 *     await provider.complete("hello");
 *   } finally {
 *     await server.close();
 *   }
 *
 * The server also records each request's path + body on `server.requests`
 * so the smoke test can assert that the bench actually reached the mock
 * (rather than, say, silently falling through to api.openai.com).
 */

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface RecordedRequest {
  method: string;
  pathname: string;
  body: string;
}

export interface LocalLlmMockServer {
  /** Full base URL (e.g. `http://127.0.0.1:56789/v1`). */
  baseUrl: string;
  /** Observed requests, in order. Cleared by `reset()`. */
  requests: RecordedRequest[];
  /** Shut down the server. Idempotent. */
  close: () => Promise<void>;
  /** Clear `requests` between test cases without restarting. */
  reset: () => void;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start the mock server. Returns a handle whose `close()` must be
 * called to release the port. Listens on `127.0.0.1:<ephemeral>`.
 */
export async function startLocalLlmMockServer(): Promise<LocalLlmMockServer> {
  const chatFixture = await readFile(
    path.join(FIXTURE_DIR, "chat-completion.json"),
    "utf8",
  );
  const modelsFixture = await readFile(
    path.join(FIXTURE_DIR, "models.json"),
    "utf8",
  );

  const recorded: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    // Strip any query string so `?stream=false` etc. still route
    // correctly. Mirrors how llama.cpp/vLLM route ignore query params.
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?", 1)[0];

    void readBody(req).then((body) => {
      recorded.push({
        method: req.method ?? "GET",
        pathname,
        body,
      });

      // `/v1/chat/completions` — replay the canned completion.
      if (
        req.method === "POST" &&
        (pathname === "/v1/chat/completions" || pathname === "/chat/completions")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(chatFixture);
        return;
      }

      // `/v1/models` — replay the canned model list.
      if (
        req.method === "GET" &&
        (pathname === "/v1/models" || pathname === "/models")
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(modelsFixture);
        return;
      }

      // Any other route is a test bug, not a real local-llm request.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `local-llm mock: unknown route ${req.method} ${pathname}`,
        }),
      );
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local-llm mock: failed to bind an ephemeral port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    requests: recorded,
    reset: () => {
      recorded.length = 0;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
