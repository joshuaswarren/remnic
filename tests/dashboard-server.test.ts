import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { GraphDashboardServer } from "../src/dashboard-runtime.js";

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 1_500,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met before timeout");
}

function waitForSocketChunk(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      cleanup();
      resolve(chunk.toString("utf-8"));
    };
    const onErr = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onErr);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onErr);
    socket.on("close", onClose);
  });
}

test("dashboard server serves health, graph, static assets, and websocket upgrade", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-"));
  const graphDir = path.join(memoryDir, "state", "graphs");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "entity.jsonl"),
    JSON.stringify({
      from: "facts/2026-02-28/a.md",
      to: "facts/2026-02-28/b.md",
      type: "entity",
      weight: 1,
      label: "project",
      ts: "2026-02-28T10:00:00.000Z",
    }) + "\n",
    "utf-8",
  );

  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });
  const started = await server.start();
  try {
    assert.equal(started.running, true);
    assert.equal(started.port > 0, true);

    const base = `http://${started.host}:${started.port}`;
    const healthRes = await fetch(`${base}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json() as { ok: boolean };
    assert.equal(health.ok, true);

    const graphRes = await fetch(`${base}/api/graph`);
    assert.equal(graphRes.status, 200);
    const graph = await graphRes.json() as { stats: { edges: number; nodes: number } };
    assert.equal(graph.stats.edges, 1);
    assert.equal(graph.stats.nodes, 2);

    const htmlRes = await fetch(`${base}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Remnic Graph Dashboard/);

    const socket = net.createConnection({ host: started.host, port: started.port });
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: ${started.host}:${started.port}`,
        "Upgrade: WebSocket",
        "Connection: Upgrade",
        `Origin: http://${started.host}:${started.port}`,
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const upgradeResponse = await waitForSocketChunk(socket);
    assert.match(upgradeResponse, /101 Switching Protocols/);
    socket.destroy();
  } finally {
    await server.stop();
  }
});

test("dashboard server rejects non-loopback binds without an auth token", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-bind-auth-"));
  const server = new GraphDashboardServer({
    memoryDir,
    host: "0.0.0.0",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });

  await assert.rejects(
    () => server.start(),
    /dashboard auth token is required when binding to a non-loopback host/,
  );
});

test("dashboard server requires bearer auth for API access when token is configured", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-http-auth-"));
  const graphDir = path.join(memoryDir, "state", "graphs");
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    path.join(graphDir, "entity.jsonl"),
    JSON.stringify({
      from: "facts/2026-02-28/a.md",
      to: "facts/2026-02-28/b.md",
      type: "entity",
      weight: 1,
      label: "project",
      ts: "2026-02-28T10:00:00.000Z",
    }) + "\n",
    "utf-8",
  );

  const server = new GraphDashboardServer({
    memoryDir,
    host: "0.0.0.0",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
    authToken: "secret-token",
  });
  const started = await server.start();
  try {
    const base = `http://127.0.0.1:${started.port}`;
    const unauthenticatedHealth = await fetch(`${base}/api/health`);
    assert.equal(unauthenticatedHealth.status, 401);
    const unauthenticatedGraph = await fetch(`${base}/api/graph`);
    assert.equal(unauthenticatedGraph.status, 401);

    const graphRes = await fetch(`${base}/api/graph`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    assert.equal(graphRes.status, 200);
    const graph = await graphRes.json() as { stats: { edges: number; nodes: number } };
    assert.equal(graph.stats.edges, 1);
    assert.equal(graph.stats.nodes, 2);
  } finally {
    await server.stop();
  }
});

test("dashboard server watches graph files created after startup", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-late-graphs-"));
  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
    watchDebounceMs: 50,
  });
  const started = await server.start();
  try {
    assert.equal(started.watching, true);
    const graphDir = path.join(memoryDir, "state", "graphs");
    await mkdir(graphDir, { recursive: true });
    await writeFile(
      path.join(graphDir, "entity.jsonl"),
      JSON.stringify({
        from: "facts/2026-02-28/a.md",
        to: "facts/2026-02-28/b.md",
        type: "entity",
        weight: 1,
        label: "project",
        ts: "2026-02-28T10:00:00.000Z",
      }) + "\n",
      "utf-8",
    );

    const base = `http://${started.host}:${started.port}`;
    await waitForCondition(async () => {
      const graphRes = await fetch(`${base}/api/graph`);
      const graph = await graphRes.json() as { stats: { edges: number } };
      return graph.stats.edges === 1;
    });
  } finally {
    await server.stop();
  }
});

test("dashboard origin check allows explicit and default http port 80", () => {
  const server = new GraphDashboardServer({
    memoryDir: "/tmp",
    host: "127.0.0.1",
    port: 80,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });
  (server as unknown as { boundPort: number }).boundPort = 80;

  const isAllowedOrigin = (server as unknown as { isAllowedOrigin: (origin: string) => boolean }).isAllowedOrigin.bind(server);

  assert.equal(isAllowedOrigin("http://127.0.0.1:80"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1"), true);
  assert.equal(isAllowedOrigin("http://localhost"), true);
});

test("dashboard origin check allows IPv6 loopback without brackets in hostname parsing", () => {
  const server = new GraphDashboardServer({
    memoryDir: "/tmp",
    host: "127.0.0.1",
    port: 8080,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });
  (server as unknown as { boundPort: number }).boundPort = 8080;

  const isAllowedOrigin = (server as unknown as { isAllowedOrigin: (origin: string) => boolean }).isAllowedOrigin.bind(server);

  assert.equal(isAllowedOrigin("http://[::1]:8080"), true);
});
test("dashboard websocket upgrade rejects non-loopback origin", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-ws-origin-"));
  await mkdir(path.join(memoryDir, "state", "graphs"), { recursive: true });

  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: 0,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });
  const started = await server.start();
  try {
    const socket = net.createConnection({ host: started.host, port: started.port });
    socket.write(
      [
        "GET / HTTP/1.1",
        `Host: ${started.host}:${started.port}`,
        "Upgrade: WebSocket",
        "Connection: Upgrade",
        "Origin: http://evil.example",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const upgradeResponse = await waitForSocketChunk(socket);
    assert.match(upgradeResponse, /403 Forbidden/);
    socket.destroy();
  } finally {
    await server.stop();
  }
});

test("dashboard server start recovers after listen failure", async () => {
  const memoryDir = await mkdtemp(path.join(os.tmpdir(), "engram-dashboard-server-start-failure-"));
  await mkdir(path.join(memoryDir, "state", "graphs"), { recursive: true });

  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
  const blockerAddr = blocker.address();
  assert.equal(typeof blockerAddr, "object");
  assert.ok(blockerAddr && typeof blockerAddr.port === "number");

  const server = new GraphDashboardServer({
    memoryDir,
    host: "127.0.0.1",
    port: blockerAddr.port,
    publicDir: path.join(process.cwd(), "dashboard", "public"),
  });

  await assert.rejects(() => server.start());
  const failedStatus = server.status();
  assert.equal(failedStatus.running, false);
  assert.equal(failedStatus.port, 0);

  await new Promise<void>((resolve, reject) => blocker.close((err) => (err ? reject(err) : resolve())));

  const started = await server.start();
  assert.equal(started.running, true);
  assert.equal(started.port > 0, true);
  await server.stop();
});
