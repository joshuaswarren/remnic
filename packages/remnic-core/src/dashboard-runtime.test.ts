import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GraphDashboardServer } from "./dashboard-runtime.js";

test("dashboard server rejects invalid constructor ports", () => {
  for (const port of [-1, 3.7, Number.NaN, Number.POSITIVE_INFINITY, 65536]) {
    assert.throws(
      () =>
        new GraphDashboardServer({
          memoryDir: "/tmp/remnic-dashboard-test",
          port,
        }),
      /dashboard port must be an integer from 0 to 65535/,
      `port ${String(port)} should be rejected`,
    );
  }
});

test("dashboard server accepts documented ephemeral and max ports", () => {
  assert.doesNotThrow(
    () =>
      new GraphDashboardServer({
        memoryDir: "/tmp/remnic-dashboard-test",
        port: 0,
      }),
  );
  assert.doesNotThrow(
    () =>
      new GraphDashboardServer({
        memoryDir: "/tmp/remnic-dashboard-test",
        port: 65535,
      }),
  );
});

test("dashboard WebSocket upgrade requires configured auth token", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "remnic-dashboard-"));
  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: 0,
    authToken: "secret-token",
  });
  try {
    const status = await server.start();
    const unauthorized = await rawWebSocketUpgrade(status.port, "/ws");
    assert.match(unauthorized, /^HTTP\/1\.1 401 Unauthorized/);

    const authorized = await rawWebSocketUpgrade(
      status.port,
      "/ws?token=secret-token",
    );
    assert.match(authorized, /^HTTP\/1\.1 101 Switching Protocols/);
  } finally {
    await server.stop();
    await rm(memoryDir, { recursive: true, force: true });
  }
});

async function rawWebSocketUpgrade(port: number, requestPath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          `Origin: http://127.0.0.1:${port}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on("error", reject);
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("timed out waiting for websocket upgrade response"));
    });
  });
}
