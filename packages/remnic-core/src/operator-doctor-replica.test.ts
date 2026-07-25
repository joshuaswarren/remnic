import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
/**
 * Replica-divergence doctor check (issue #2149).
 *
 * Verifies `summarizeReplicaDivergence` is ok when disabled / peerless /
 * converged, warns (never ok) when a peer diverges or cannot be polled, surfaces
 * concrete deltas, never leaks a token, and is wired into `runOperatorDoctor`.
 * The check takes a pre-computed local watermark set (kept DTS-light); a real
 * ephemeral 127.0.0.1 server stands in for the peer daemon.
 */
import { parseConfig } from "./config.js";
import type { CorpusWatermark } from "./corpus-watermark.js";
import { summarizeReplicaDivergence } from "./operator-doctor-replica.js";
import { type OperatorToolkitOrchestrator, runOperatorDoctor } from "./operator-toolkit.js";
import type { ReplicaDivergenceStatus } from "./replica-divergence.js";
import { type ReplicaPeersConfig, parseReplicaPeersConfig } from "./replica-peers-config.js";
import { StorageManager } from "./storage.js";
import type { PluginConfig } from "./types.js";

function watermark(namespace: string, overrides: Partial<CorpusWatermark> = {}): CorpusWatermark {
  return {
    namespace,
    memoryFileCount: 10,
    newestPartition: "2026-03-08",
    newestWriteAt: "2026-03-08T00:00:00.000Z",
    digest: `digest-${namespace}`,
    computedAt: new Date().toISOString(),
    ...overrides,
  };
}

function replicaConfig(block: Record<string, unknown>): ReplicaPeersConfig {
  return parseReplicaPeersConfig({ replicaPeers: block });
}

interface Peer {
  url: string;
  requests: { authorization: string | undefined }[];
  close: () => Promise<void>;
}

async function startPeer(handler: RequestListener): Promise<Peer> {
  const requests: Peer["requests"] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push({ authorization: req.headers.authorization });
    handler(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function healthHandler(corpus: CorpusWatermark[]): RequestListener {
  return (req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/engram/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, corpus }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
}

test("summarizeReplicaDivergence: disabled resolves ok and performs no network I/O", async () => {
  const peer = await startPeer(healthHandler([]));
  try {
    const check = await summarizeReplicaDivergence(
      replicaConfig({ enabled: false, peers: [{ url: peer.url }] }),
      [watermark("global")],
    );
    assert.equal(check.key, "replica_divergence");
    assert.equal(check.status, "ok");
    assert.match(check.summary, /disabled/i);
    assert.equal(peer.requests.length, 0, "a disabled check must not poll");
  } finally {
    await peer.close();
  }
});

test("summarizeReplicaDivergence: enabled with no peers resolves ok", async () => {
  const check = await summarizeReplicaDivergence(replicaConfig({ enabled: true, peers: [] }), [watermark("global")]);
  assert.equal(check.status, "ok");
  assert.match(check.summary, /no peers/i);
});

test("summarizeReplicaDivergence: a converged peer resolves ok", async () => {
  const local = [watermark("global")];
  const peer = await startPeer(healthHandler(local));
  try {
    const check = await summarizeReplicaDivergence(replicaConfig({ enabled: true, peers: [{ url: peer.url }] }), local);
    assert.equal(check.status, "ok");
    assert.match(check.summary, /converged/i);
  } finally {
    await peer.close();
  }
});

test("summarizeReplicaDivergence: an incomplete local census downgrades a converged peer AND warns (round 6)", async () => {
  // /health downgrades a would-be-converged peer to unknown/local_census_incomplete
  // when the local census is partial; the doctor must derive the SAME peer state
  // through the shared gate, not render `peer: converged` with converged details.
  const local = [watermark("global")];
  const peer = await startPeer(healthHandler(local));
  try {
    const check = await summarizeReplicaDivergence(
      replicaConfig({ enabled: true, peers: [{ url: peer.url }] }),
      local,
      { localCensusComplete: false },
    );
    assert.equal(check.status, "warn", "an incomplete local census cannot certify convergence");
    assert.match(check.summary, /local census incomplete/i);
    const report = check.details as ReplicaDivergenceStatus;
    assert.equal(report.censusComplete, false);
    assert.equal(report.peers[0]?.state, "unknown", "the peer detail is downgraded, not left converged");
    assert.equal(report.peers[0]?.reason, "local_census_incomplete");
    assert.notEqual(report.peers[0]?.state, "converged");
  } finally {
    await peer.close();
  }
});

test("summarizeReplicaDivergence: a diverged peer warns with the concrete delta", async () => {
  const peer = await startPeer(healthHandler([watermark("global", { memoryFileCount: 340_000, digest: "peer" })]));
  try {
    const check = await summarizeReplicaDivergence(
      replicaConfig({ enabled: true, peers: [{ url: peer.url }] }),
      [watermark("global", { memoryFileCount: 190_000, digest: "local" })],
    );
    assert.equal(check.status, "warn", "a divergence must warn, never ok");
    assert.match(check.summary, /diverged/);
    assert.match(check.summary, /file_count_delta=150000/, "the operator sees the concrete delta");
  } finally {
    await peer.close();
  }
});

test("summarizeReplicaDivergence: an unreachable peer warns and is not conflated with ok (§22)", async () => {
  const peer = await startPeer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const check = await summarizeReplicaDivergence(
      replicaConfig({ enabled: true, peers: [{ url: peer.url }] }),
      [watermark("global")],
    );
    assert.equal(check.status, "warn");
    assert.match(check.summary, /unreachable/);
    assert.match(check.summary, /http_500/);
  } finally {
    await peer.close();
  }
});

test("summarizeReplicaDivergence: the peer token never appears in the doctor check output", async () => {
  const secret = "DOCTOR-SECRET-TOKEN";
  const peer = await startPeer(healthHandler([watermark("global", { memoryFileCount: 999_999, digest: "x" })]));
  try {
    const check = await summarizeReplicaDivergence(
      replicaConfig({ enabled: true, peers: [{ url: peer.url, token: secret }] }),
      [watermark("global")],
    );
    assert.ok(peer.requests.some((request) => request.authorization === `Bearer ${secret}`), "token IS used (non-vacuous)");
    assert.ok(!JSON.stringify(check).includes(secret), "token must never appear in the doctor output");
  } finally {
    await peer.close();
  }
});

async function writeMemory(memoryDir: string, rel: string): Promise<void> {
  const full = path.join(memoryDir, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, `---\nid: ${path.basename(rel, ".md")}\n---\n\nbody\n`, "utf-8");
}

async function makeFixture(): Promise<{
  root: string;
  memoryDir: string;
  configPath: string;
  orchestrator: OperatorToolkitOrchestrator;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-replica-doctor-"));
  const memoryDir = path.join(root, "memory");
  await mkdir(memoryDir, { recursive: true });
  const rawConfig = {
    openaiApiKey: "sk-test",
    memoryDir,
    qmdEnabled: false,
    namespacesEnabled: false,
    defaultNamespace: "global",
  };
  const config: PluginConfig = parseConfig(rawConfig);
  const configPath = path.join(root, "openclaw.json");
  await writeFile(
    configPath,
    JSON.stringify({ plugins: { entries: { "openclaw-remnic": { config: rawConfig } } } }, null, 2),
    "utf-8",
  );
  const orchestrator: OperatorToolkitOrchestrator = {
    config,
    storage: new StorageManager(memoryDir),
    qmd: {
      async probe() {
        return false;
      },
      isAvailable() {
        return false;
      },
      async ensureCollection() {
        return "skipped";
      },
      debugStatus() {
        return "disabled";
      },
    },
    conversationIndexCoordinator: {
      async getHealth() {
        return { enabled: false, backend: "qmd" as const, status: "disabled" as const, chunkDocCount: 0, lastUpdateAt: null };
      },
      async rebuild() {
        return { chunks: 0, skipped: true, reason: "disabled", embedded: false, rebuilt: false };
      },
    },
  };
  return { root, memoryDir, configPath, orchestrator };
}

test("runOperatorDoctor: includes the replica_divergence check (disabled -> ok)", async () => {
  const { root, memoryDir, configPath, orchestrator } = await makeFixture();
  try {
    await writeMemory(memoryDir, "facts/2026-03-08/a.md");
    const report = await runOperatorDoctor({ configPath, orchestrator });
    const check = report.checks.find((entry) => entry.key === "replica_divergence");
    assert.ok(check, "expected a replica_divergence check");
    assert.equal(check?.status, "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
