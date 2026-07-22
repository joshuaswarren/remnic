import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test from "node:test";

import { ActivityHttpSourceClient } from "./source-client.js";

async function withServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close((error) => (error ? closed.reject(error) : closed.resolve()));
    await closed.promise;
  }
}

test("ActivityHttpSourceClient authenticates and maps a snapshot page", async () => {
  await withServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    assert.equal(request.url, "/v1/snapshots?date=2026-07-22&timezone=America%2FChicago&cursor=next%20cursor");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        snapshots: [
          {
            capturedAtUtc: "2026-07-22T14:00:00.000Z",
            app: "Browser",
            windowTitle: "Fixture",
            text: "synthetic text",
            textSource: "ax",
            contentHash: "abc123",
          },
        ],
        nextCursor: "cursor-2",
      }),
    );
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl, token: "fixture-token" });
    const page = await client.fetchSnapshots({ date: "2026-07-22", timezone: "America/Chicago", cursor: "next cursor" });

    assert.deepEqual(page, {
      snapshots: [
        {
          machine: "fixture-machine",
          capturedAtUtc: "2026-07-22T14:00:00.000Z",
          app: "Browser",
          windowTitle: "Fixture",
          text: "synthetic text",
          textSource: "ax",
          contentHash: "abc123",
        },
      ],
      nextCursor: "cursor-2",
    });
  });
});

test("ActivityHttpSourceClient reports an unreachable health probe without treating it as an empty source", async () => {
  await withServer((_request, response) => {
    response.statusCode = 503;
    response.end("temporarily unavailable");
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
    assert.deepEqual(await client.verify(), { ok: false, detail: "HTTP 503" });
    await assert.rejects(
      client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC" }),
      /HTTP 503/,
    );
  });
});

test("ActivityHttpSourceClient aborts a stalled request via the default timeout", async () => {
  await withServer((request) => {
    // Never respond: hold the request open so only the client-side timeout can
    // end it. The socket is destroyed when fetch aborts, so teardown proceeds.
    request.resume();
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl, timeoutMs: 50 });
    assert.deepEqual((await client.verify()).ok, false);
    await assert.rejects(client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC" }));
  });
});

test("ActivityHttpSourceClient honors a caller-supplied abort signal", async () => {
  await withServer((request) => {
    request.resume();
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
    await assert.rejects(client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC", signal: AbortSignal.abort() }));
  });
});

test("ActivityHttpSourceClient rejects a non-positive timeout", () => {
  assert.throws(
    () => new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl: "http://127.0.0.1:4319", timeoutMs: 0 }),
    /timeoutMs must be a positive number/,
  );
});
