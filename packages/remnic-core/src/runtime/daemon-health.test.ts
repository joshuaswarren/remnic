import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { checkDaemonHealth } from "./daemon-health.js";

test("checkDaemonHealth probes /live without waiting on diagnostic /health", { timeout: 30_000 }, async (t) => {
  // The synchronous probe blocks this thread, so HTTP must run on a worker.
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const { createServer } = require("node:http");
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      if (request.url === "/engram/v1/health") return;
      response.writeHead(request.headers.authorization === "Bearer test-token" ? 200 : 401).end();
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", () => parentPort.postMessage(paths));
  `, { eval: true });
  t.after(() => worker.terminate());
  let port = 0;
  [port] = await once(worker, "message");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.equal(checkDaemonHealth("127.0.0.1", port, "test-token"), true);
  assert.equal(checkDaemonHealth("127.0.0.1", port, "wrong-token"), false);
  const paths = once(worker, "message");
  worker.postMessage("paths");
  assert.deepEqual((await paths)[0], [
    "/engram/v1/live",
    "/engram/v1/live",
    "/engram/v1/live",
  ]);
  await worker.terminate();
  assert.equal(checkDaemonHealth("127.0.0.1", port, "test-token"), false);
});

test("checkDaemonHealth retries legacy /health only on 404 (#3257)", { timeout: 30_000 }, async (t) => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const { createServer } = require("node:http");
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      if (request.url === "/engram/v1/live") return response.writeHead(404).end();
      response.writeHead(200).end();
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", () => parentPort.postMessage(paths));
  `, { eval: true });
  t.after(() => worker.terminate());
  let port = 0;
  [port] = await once(worker, "message");
  assert.equal(checkDaemonHealth("127.0.0.1", port, "test-token"), true);
  const paths = once(worker, "message");
  worker.postMessage("paths");
  assert.deepEqual((await paths)[0], [
    "/engram/v1/live",
    "/engram/v1/health",
  ]);
  await worker.terminate();
});

test("checkDaemonHealth treats 503 as final with no legacy retry (#3257)", { timeout: 30_000 }, async (t) => {
  const worker = new Worker(`
    const { parentPort } = require("node:worker_threads");
    const { createServer } = require("node:http");
    const paths = [];
    const server = createServer((request, response) => {
      paths.push(request.url);
      if (request.url === "/engram/v1/live") return response.writeHead(503).end();
      response.writeHead(200).end();
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
    parentPort.on("message", () => parentPort.postMessage(paths));
  `, { eval: true });
  t.after(() => worker.terminate());
  let port = 0;
  [port] = await once(worker, "message");
  assert.equal(checkDaemonHealth("127.0.0.1", port, "test-token"), false);
  const paths = once(worker, "message");
  worker.postMessage("paths");
  assert.deepEqual((await paths)[0], ["/engram/v1/live"]);
  await worker.terminate();
});
