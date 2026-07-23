import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

import {
  createDesktopConnector,
  daemonConversationToWearable,
  DesktopDaemonError,
  resolveCaptureAudioToken,
} from "./connector.js";
import type { WearableConnectorFactoryOptions, WearableSourceConnector } from "@remnic/core";

interface MockDaemon {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ path: string; auth: string | undefined }>;
}

async function startMockDaemon(handler: (url: URL, res: http.ServerResponse) => void): Promise<MockDaemon> {
  const requests: MockDaemon["requests"] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ path: url.pathname, auth: req.headers.authorization });
    handler(url, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function connectorFor(baseUrl: string, apiKey = "tok"): WearableSourceConnector {
  const options: WearableConnectorFactoryOptions = {
    settings: {
      enabled: true,
      baseUrl,
      apiKey,
      memoryMode: "smart",
      sourceTrust: 0.85,
      autoApproveTrust: 0.9,
      reviewTrust: 0.5,
      minConfidence: 0,
      minImportance: "low",
      maxMemoriesPerDay: 0,
      importNativeMemories: "off",
      cleanup: {} as never,
    },
    timezone: "UTC",
  };
  return createDesktopConnector(options);
}

test("daemonConversationToWearable maps daemon shape to the wearable contract", () => {
  const wc = daemonConversationToWearable({
    id: "conv_1",
    startedAtUtc: "2026-07-20T15:00:00.000Z",
    endedAtUtc: "2026-07-20T15:05:00.000Z",
    state: "final",
    segmentCount: 2,
    segments: [
      { textRaw: "hi there", speakerKey: "spk_1", isWearer: false, channel: "system", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:02.000Z" },
      { textRaw: "hello", speakerKey: null, isWearer: true, channel: "mic", startUtc: "2026-07-20T15:00:03.000Z", endUtc: "2026-07-20T15:00:04.000Z" },
    ],
  });
  assert.equal(wc.id, "conv_1");
  assert.equal(wc.source, "desktop");
  assert.equal(wc.startIso, "2026-07-20T15:00:00.000Z");
  assert.equal(wc.endIso, "2026-07-20T15:05:00.000Z");
  assert.deepEqual(wc.segments[0], { text: "hi there", speakerKey: "spk_1", isWearer: false, startIso: "2026-07-20T15:00:00.000Z", endIso: "2026-07-20T15:00:02.000Z" });
  assert.equal(wc.segments[1].speakerKey, "unknown"); // null -> "unknown"
  assert.equal(wc.segments[1].isWearer, true);
});

test("resolveCaptureAudioToken prefers config, then env; skips the local file for non-loopback", () => {
  assert.equal(resolveCaptureAudioToken("cfg", "http://192.0.2.9:4340", { REMNIC_CAPTURE_AUDIO_TOKEN: "env" }), "cfg");
  assert.equal(resolveCaptureAudioToken(undefined, "http://192.0.2.9:4340", { REMNIC_CAPTURE_AUDIO_TOKEN: "env" }), "env");
  // Non-loopback + no config/env -> never reads the local token file.
  assert.equal(resolveCaptureAudioToken(undefined, "http://192.0.2.9:4340", {}), undefined);
});

test("verifyAuth: ok on 200, unauthorized on 401, unreachable never throws", async () => {
  const daemon = await startMockDaemon((url, res) => {
    if (url.pathname === "/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "9.14.0" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    const okCheck = await connectorFor(daemon.url).verifyAuth();
    assert.equal(okCheck.ok, true);
    assert.match(okCheck.detail ?? "", /capture-audio/);
  } finally {
    await daemon.close();
  }

  const unauth = await startMockDaemon((_url, res) => {
    res.writeHead(401);
    res.end();
  });
  try {
    assert.deepEqual(await connectorFor(unauth.url).verifyAuth(), { ok: false, detail: "unauthorized" });
  } finally {
    await unauth.close();
  }

  // Closed port -> unreachable, not a throw (AC2).
  const check = await connectorFor("http://127.0.0.1:1").verifyAuth();
  assert.deepEqual(check, { ok: false, detail: "unreachable" });
});

test("fetchConversations maps a page, sends the bearer token, and treats an empty day as an empty page", async () => {
  const daemon = await startMockDaemon((url, res) => {
    if (url.pathname !== "/v1/conversations") {
      res.writeHead(404);
      res.end();
      return;
    }
    const empty = url.searchParams.get("date") === "2026-07-21";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        empty
          ? { conversations: [], nextCursor: null }
          : {
              conversations: [
                { id: "conv_1", startedAtUtc: "2026-07-20T15:00:00.000Z", endedAtUtc: null, state: "final", segmentCount: 1, segments: [{ textRaw: "hi", speakerKey: "spk_1", isWearer: false, channel: "mic", startUtc: "2026-07-20T15:00:00.000Z", endUtc: "2026-07-20T15:00:01.000Z" }] },
              ],
              nextCursor: "c2",
            },
      ),
    );
  });
  try {
    const page = await connectorFor(daemon.url).fetchConversations({ date: "2026-07-20", timezone: "UTC" });
    assert.equal(page.conversations.length, 1);
    assert.equal(page.conversations[0].source, "desktop");
    assert.equal(page.nextCursor, "c2");
    assert.ok(daemon.requests.some((r) => r.auth === "Bearer tok"));

    const emptyPage = await connectorFor(daemon.url).fetchConversations({ date: "2026-07-21", timezone: "UTC" });
    assert.deepEqual(emptyPage, { conversations: [], nextCursor: null });
  } finally {
    await daemon.close();
  }
});

test("fetchConversations throws (not empty) on a backend 500 — empty vs failure are distinct", async () => {
  const daemon = await startMockDaemon((_url, res) => {
    res.writeHead(500);
    res.end();
  });
  try {
    await assert.rejects(
      connectorFor(daemon.url).fetchConversations({ date: "2026-07-20", timezone: "UTC" }),
      DesktopDaemonError,
    );
  } finally {
    await daemon.close();
  }
});

test("fetchConversations throws (not empty) when a 200 body is not valid JSON", async () => {
  const daemon = await startMockDaemon((url, res) => {
    if (url.pathname !== "/v1/conversations") {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("not json <<<");
  });
  try {
    await assert.rejects(
      connectorFor(daemon.url).fetchConversations({ date: "2026-07-20", timezone: "UTC" }),
      DesktopDaemonError,
    );
  } finally {
    await daemon.close();
  }
});

test("the bearer token is resolved per request, so env rotation applies without a rebuild", async () => {
  const daemon = await startMockDaemon((url, res) => {
    res.writeHead(url.pathname === "/v1/health" ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "9.14.0" }));
  });
  const previousToken = process.env.REMNIC_CAPTURE_AUDIO_TOKEN;
  try {
    // No config apiKey + non-loopback would skip the token file; use a
    // loopback daemon but resolve the token from env, rotating between calls.
    const opts: WearableConnectorFactoryOptions = {
      settings: {
        enabled: true,
        baseUrl: daemon.url,
        memoryMode: "smart",
        sourceTrust: 0.85,
        autoApproveTrust: 0.9,
        reviewTrust: 0.5,
        minConfidence: 0,
        minImportance: "low",
        maxMemoriesPerDay: 0,
        importNativeMemories: "off",
        cleanup: {} as never,
      },
      timezone: "UTC",
    };
    const connector = createDesktopConnector(opts);
    process.env.REMNIC_CAPTURE_AUDIO_TOKEN = "first";
    await connector.verifyAuth();
    process.env.REMNIC_CAPTURE_AUDIO_TOKEN = "second";
    await connector.verifyAuth();
    const auths = daemon.requests.filter((r) => r.path === "/v1/health").map((r) => r.auth);
    assert.deepEqual(auths, ["Bearer first", "Bearer second"]);
  } finally {
    if (previousToken === undefined) delete process.env.REMNIC_CAPTURE_AUDIO_TOKEN;
    else process.env.REMNIC_CAPTURE_AUDIO_TOKEN = previousToken;
    await daemon.close();
  }
});

test("fetchConversations honors caller cancellation instead of reporting unreachable", async () => {
  const daemon = await startMockDaemon((_url, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ conversations: [], nextCursor: null }));
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      connectorFor(daemon.url).fetchConversations({ date: "2026-07-20", timezone: "UTC", signal: controller.signal }),
      (err: Error) => err.name === "AbortError",
    );
  } finally {
    await daemon.close();
  }
});

test("fetchConversations rejects a malformed baseUrl as a daemon error, not a raw TypeError", async () => {
  await assert.rejects(
    connectorFor("notaurl").fetchConversations({ date: "2026-07-20", timezone: "UTC" }),
    DesktopDaemonError,
  );
});
