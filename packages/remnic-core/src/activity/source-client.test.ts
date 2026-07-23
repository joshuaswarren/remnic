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

test("ActivityHttpSourceClient treats an omitted nextCursor as end-of-pagination", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    // Daemon omits nextCursor entirely (not JSON null) on the final page.
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
      }),
    );
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
    const page = await client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC" });
    assert.equal(page.nextCursor, null, "a missing nextCursor is normal completion, not an error");
    assert.equal(page.snapshots.length, 1);
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

async function closedLoopbackBaseUrl(): Promise<string> {
  // Reserve an ephemeral loopback port, then close it so the connection is
  // deterministically refused (no reliance on a fixed low port being free).
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
  return `http://127.0.0.1:${port}`;
}

test("ActivityHttpSourceClient.verify returns a sanitized detail for network errors", async () => {
  const baseUrl = await closedLoopbackBaseUrl();
  const port = new URL(baseUrl).port;
  const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
  const check = await client.verify();
  assert.equal(check.ok, false);
  assert.ok(check.detail && check.detail.length > 0, "a failure carries some detail");
  assert.ok(!check.detail?.includes("127.0.0.1"), "detail does not echo the host");
  assert.ok(!check.detail?.includes(port), "detail does not echo the port");
});

test("ActivityHttpSourceClient accepts an empty window title and text (untitled/blank window)", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        snapshots: [
          {
            capturedAtUtc: "2026-07-22T14:00:00.000Z",
            app: "",
            windowTitle: "",
            text: "",
            textSource: "ocr",
            contentHash: "abc123",
          },
        ],
        nextCursor: null,
      }),
    );
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
    const page = await client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC" });
    // A legitimate no-text/untitled foreground window must parse, not throw —
    // else the runner errors the day and the cursor never advances past it.
    assert.equal(page.snapshots.length, 1);
    assert.equal(page.snapshots[0]?.windowTitle, "");
    assert.equal(page.snapshots[0]?.text, "");
    assert.equal(page.snapshots[0]?.app, "");
  });
});

test("ActivityHttpSourceClient still rejects a missing contentHash identifier", async () => {
  await withServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        snapshots: [
          { capturedAtUtc: "2026-07-22T14:00:00.000Z", app: "Browser", windowTitle: "T", text: "x", textSource: "ax" },
        ],
        nextCursor: null,
      }),
    );
  }, async (baseUrl) => {
    const client = new ActivityHttpSourceClient({ machineLabel: "fixture-machine", baseUrl });
    // Identity/dedup fields are still required and non-empty.
    await assert.rejects(client.fetchSnapshots({ date: "2026-07-22", timezone: "UTC" }), /contentHash/);
  });
});
