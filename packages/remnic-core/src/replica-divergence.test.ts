import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";

import { computeCorpusWatermark, type CorpusWatermark } from "./corpus-watermark.js";
import {
  MAX_PEER_RESPONSE_BYTES,
  ReplicaDivergenceMonitor,
  type FetchLike,
  type ReplicaDivergenceStatus,
  compareReplicaWatermarks,
  filterReplicaReportByCaps,
  gateReportByCensus,
  pollReplicaPeers,
  redactPeerUrl,
} from "./replica-divergence.js";
import { parseReplicaPeersConfig, resolveReplicaPeersConfig } from "./replica-peers-config.js";

// ---------------------------------------------------------------------------

const THRESHOLDS = { maxFileCountDelta: 100, maxWatermarkAgeDeltaMs: 900_000 } as const;

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

interface Peer {
  url: string;
  port: number;
  requests: { pathname: string; authorization: string | undefined }[];
  close: () => Promise<void>;
}

async function startPeer(handler: RequestListener): Promise<Peer> {
  const requests: Peer["requests"] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push({ pathname: new URL(req.url ?? "/", "http://127.0.0.1").pathname, authorization: req.headers.authorization });
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
    port: address.port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function corpusHandler(corpus: CorpusWatermark[], servedPath = "/engram/v1/health"): RequestListener {
  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === servedPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, corpus }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("parseReplicaPeersConfig: defaults are opt-out and match the documented values", () => {
  const config = parseReplicaPeersConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.peers.length, 0);
  assert.equal(config.pollIntervalMs, 300_000);
  assert.equal(config.requestTimeoutMs, 10_000);
  assert.equal(config.maxFileCountDelta, 100);
  assert.equal(config.maxWatermarkAgeDeltaMs, 900_000);
});

test("parseReplicaPeersConfig: string \"false\"/\"0\" are falsy (§24 CLI/JSON string coercion)", () => {
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: "false" } }).enabled, false);
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: "0" } }).enabled, false);
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: "true" } }).enabled, true);
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: "1" } }).enabled, true);
});

test("parseReplicaPeersConfig: string numbers coerce; interval floors are honored", () => {
  const config = parseReplicaPeersConfig({
    replicaPeers: { pollIntervalMs: "60000", requestTimeoutMs: "5000", maxFileCountDelta: "0" },
  });
  assert.equal(config.pollIntervalMs, 60_000);
  assert.equal(config.requestTimeoutMs, 5_000);
  assert.equal(config.maxFileCountDelta, 0, "0 is a valid strictest threshold (schema minimum 0, code accepts 0)");
});

test("parseReplicaPeersConfig: valid peers parse with url + token", () => {
  const config = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, peers: [{ url: "https://backup.example:4318", token: "tok" }] },
  });
  assert.equal(config.peers.length, 1);
  assert.equal(config.peers[0]?.url, "https://backup.example:4318");
  assert.equal(config.peers[0]?.token, "tok");
});

test("parseReplicaPeersConfig: rejects invalid inputs instead of silently defaulting (§39)", () => {
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "not a url" }] } }), /valid URL/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "ftp://host" }] } }), /http\(s\)/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: "nope" } }), /must be an array/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [42] } }), /must be an object/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{}] } }), /url must be a non-empty string/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "http://h", token: 5 }] } }), /token must be/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "http://h", token: "" }] } }), /non-empty string/, "an explicit empty token is a config error, not unauthenticated");
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "http://h", token: "   " }] } }), /non-empty string/, "a whitespace-only token is a config error too");
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: [] }), /must be a plain object/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "https://peer.example?tenant=x" }] } }), /clean base URL/, "a query component corrupts path concatenation and is rejected");
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "https://peer.example/#frag" }] } }), /clean base URL/, "a fragment component is rejected");
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "https://user:pass@peer.example" }] } }), /clean base URL/, "embedded credentials are rejected (Node fetch refuses them)");
});

test("parseReplicaPeersConfig: rejects fractional / non-positive intervals (§1/§17)", () => {
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { pollIntervalMs: 1.5 } }), /integer/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { pollIntervalMs: 0 } }), /greater than or equal to 1/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { requestTimeoutMs: -5 } }), /greater than or equal to 1/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { maxFileCountDelta: -1 } }), /greater than or equal to 0/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { maxWatermarkAgeDeltaMs: 2.5 } }), /integer/);
  assert.throws(() => parseReplicaPeersConfig({ replicaPeers: { requestTimeoutMs: 2_147_483_648 } }), /no greater than/, "a requestTimeoutMs above the Node timer ceiling is rejected, not silently clamped to 1ms");
});

test("resolveReplicaPeersConfig: the read boundary caps requestTimeoutMs at the timer ceiling (falls back, never throws)", () => {
  const resolved = resolveReplicaPeersConfig({ requestTimeoutMs: 2_147_483_648, enabled: true });
  assert.equal(resolved.requestTimeoutMs, 10_000, "an over-ceiling timeout falls back to the default at the read boundary");
});

test("parseReplicaPeersConfig: ${ENV} expansion in url and token, throws on unset", () => {
  process.env.REPLICA_TEST_HOST = "backup.example:4318";
  process.env.REPLICA_TEST_TOKEN = "env-token";
  try {
    const config = parseReplicaPeersConfig({
      replicaPeers: { peers: [{ url: "https://${REPLICA_TEST_HOST}", token: "${REPLICA_TEST_TOKEN}" }] },
    });
    assert.equal(config.peers[0]?.url, "https://backup.example:4318");
    assert.equal(config.peers[0]?.token, "env-token");
    assert.throws(
      () => parseReplicaPeersConfig({ replicaPeers: { peers: [{ url: "https://${REPLICA_TEST_UNSET_VAR}" }] } }),
      /is not set/,
    );
  } finally {
    delete process.env.REPLICA_TEST_HOST;
    delete process.env.REPLICA_TEST_TOKEN;
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("compareReplicaWatermarks: a one-sided null newest-write is divergence, not agreement (round 6, codex)", () => {
  const local = [watermark("default", { newestWriteAt: "2026-03-08T00:00:00.000Z" })];
  const peer = [watermark("default", { newestWriteAt: null })]; // same count+digest, but no dated write
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "diverged", "a missing measurement on one side cannot certify convergence");
  assert.ok(result.namespaces[0]?.reasons.includes("newest_write_presence_mismatch"));
  const bothNull = compareReplicaWatermarks(
    [watermark("default", { newestWriteAt: null })],
    [watermark("default", { newestWriteAt: null })],
    THRESHOLDS,
  );
  assert.equal(bothNull.state, "converged", "two undated but matching corpora agree");
});

test("compareReplicaWatermarks: identical corpora converge", () => {
  const local = [watermark("default")];
  const peer = [watermark("default")];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "converged");
  assert.equal(result.divergedNamespaceCount, 0);
  assert.equal(result.namespaces[0]?.digestMatch, true);
});

test("compareReplicaWatermarks: file-count delta beyond threshold diverges and reports the delta", () => {
  const local = [watermark("default", { memoryFileCount: 190_000, digest: "d" })];
  const peer = [watermark("default", { memoryFileCount: 340_000, digest: "d" })];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "diverged");
  const delta = result.namespaces[0];
  assert.equal(delta?.fileCountDelta, 150_000);
  assert.ok(delta?.reasons.includes("file_count_delta=150000"));
});

test("compareReplicaWatermarks: file-count delta within threshold stays converged", () => {
  const local = [watermark("default", { memoryFileCount: 100, digest: "d" })];
  const peer = [watermark("default", { memoryFileCount: 150, digest: "d" })];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "converged", "delta 50 is within maxFileCountDelta 100");
});

test("compareReplicaWatermarks: equal counts but DIFFERENT digest diverges (split-brain)", () => {
  const local = [watermark("default", { memoryFileCount: 500, digest: "aaa" })];
  const peer = [watermark("default", { memoryFileCount: 500, digest: "bbb" })];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "diverged", "same size, different content must be caught by the digest");
  assert.equal(result.namespaces[0]?.digestMatch, false);
  assert.ok(result.namespaces[0]?.reasons.includes("digest_mismatch"));
});

test("compareReplicaWatermarks: stale peer watermark (age delta beyond threshold) diverges", () => {
  const local = [watermark("default", { newestWriteAt: "2026-03-08T12:00:00.000Z", digest: "d", memoryFileCount: 10 })];
  const peer = [watermark("default", { newestWriteAt: "2026-03-08T00:00:00.000Z", digest: "d", memoryFileCount: 10 })];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "diverged");
  assert.equal(result.namespaces[0]?.writeAgeDeltaMs, 12 * 3_600_000);
  assert.ok(result.namespaces[0]?.reasons.some((reason) => reason.startsWith("write_age_delta_ms=")));
});

test("compareReplicaWatermarks: a one-sided namespace is reported; local_only advisory, peer_only diverges", () => {
  const local = [watermark("default"), watermark("team-a")];
  const peer = [watermark("default"), watermark("team-b")];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  const byNamespace = new Map(result.namespaces.map((delta) => [delta.namespace, delta]));
  assert.equal(byNamespace.get("team-a")?.presence, "local_only");
  assert.equal(byNamespace.get("team-a")?.diverged, false);
  assert.equal(byNamespace.get("team-b")?.presence, "peer_only");
  assert.equal(byNamespace.get("team-b")?.diverged, true);
  assert.equal(byNamespace.get("default")?.diverged, false);
  assert.equal(result.state, "diverged", "peer_only still diverges the peer");
});

test("compareReplicaWatermarks: a local-only namespace is ambiguous, not converged (round 2, codex P1)", () => {
  const local = [watermark("default", { digest: "d" }), watermark("team-a", { digest: "d" })];
  const peer = [watermark("default", { digest: "d" })];
  const result = compareReplicaWatermarks(local, peer, THRESHOLDS);
  assert.equal(result.state, "unknown", "an ambiguous local-only namespace must not read as converged");
  assert.notEqual(result.state, "converged", "the round-1 contract would have hidden a peer that lost a namespace");
  assert.equal(result.divergedNamespaceCount, 0, "ambiguous is not divergence either");
  const teamA = result.namespaces.find((delta) => delta.namespace === "team-a");
  assert.equal(teamA?.presence, "local_only");
  assert.equal(teamA?.diverged, false);
});

test("compareReplicaWatermarks: no shared namespace is unknown, never converged (round 6, codex P1)", () => {
  const empty = compareReplicaWatermarks([], [], THRESHOLDS);
  assert.equal(empty.state, "unknown", "no shared namespace cannot be certified converged");
  assert.equal(empty.reason, "no_shared_namespaces");
  assert.notEqual(empty.state, "converged");

  const emptyDefault = watermark("default", {
    memoryFileCount: 0,
    newestWriteAt: null,
    newestPartition: null,
    digest: "empty",
  });
  const single = compareReplicaWatermarks([emptyDefault], [emptyDefault], THRESHOLDS);
  assert.equal(single.state, "converged", "an empty but SHARED namespace is still evidence of agreement");
});

test("compareReplicaWatermarks: real watermarks with equal count but different day distribution diverge", async () => {
  const baseDir = "/tmp/replica-fixture";
  const localPaths = ["facts/2026-03-01/a.md", "facts/2026-03-01/b.md"].map((rel) => `${baseDir}/${rel}`);
  const peerPaths = ["facts/2026-03-01/a.md", "facts/2026-03-02/b.md"].map((rel) => `${baseDir}/${rel}`);
  const now = new Date("2026-03-08T00:00:00.000Z");
  const local = await computeCorpusWatermark({ namespace: "default", paths: localPaths, baseDir, now });
  const peer = await computeCorpusWatermark({ namespace: "default", paths: peerPaths, baseDir, now });
  assert.equal(local.memoryFileCount, peer.memoryFileCount, "both have 2 files");
  assert.notEqual(local.digest, peer.digest, "different day distribution changes the census digest");
  const result = compareReplicaWatermarks([local], [peer], THRESHOLDS);
  assert.equal(result.state, "diverged");
  assert.equal(result.namespaces[0]?.digestMatch, false);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("pollReplicaPeers: converged peer over the engram prefix this server serves (no fallback needed)", async () => {
  const peer = await startPeer(corpusHandler([watermark("default")], "/engram/v1/health"));
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers.length, 1);
    assert.equal(report.peers[0]?.state, "converged");
    const paths = peer.requests.map((request) => request.pathname);
    assert.deepEqual(paths, ["/engram/v1/health"], "the served path is tried first, so remnic is never requested");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: falls back to the remnic prefix when engram 404s (round 6, codex P2)", async () => {
  const peer = await startPeer(corpusHandler([watermark("default")], "/remnic/v1/health"));
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "converged");
    const paths = peer.requests.map((request) => request.pathname);
    assert.deepEqual(paths, ["/engram/v1/health", "/remnic/v1/health"], "engram is tried first, remnic is the fallback");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: file-count divergence end to end reports concrete deltas", async () => {
  const peer = await startPeer(corpusHandler([watermark("default", { memoryFileCount: 340_000, digest: "x" })]));
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({
      config,
      localWatermarks: [watermark("default", { memoryFileCount: 190_000, digest: "x" })],
    });
    assert.equal(report.peers[0]?.state, "diverged");
    assert.equal(report.peers[0]?.namespaces[0]?.fileCountDelta, 150_000);
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: a 500 is reported unreachable and is NOT conflated with converged (§22)", async () => {
  const peer = await startPeer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "unreachable");
    assert.notEqual(report.peers[0]?.state, "converged");
    assert.equal(report.peers[0]?.reason, "http_500");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: a connection refused is unreachable, never converged (§22)", async () => {
  const dead = await startPeer(corpusHandler([watermark("default")]));
  const url = dead.url;
  await dead.close();
  const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url }] } });
  const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
  assert.equal(report.peers[0]?.state, "unreachable");
  assert.notEqual(report.peers[0]?.state, "converged");
});

test("pollReplicaPeers: a stalled peer times out to unreachable, never converged (§22)", async () => {
  const peer = await startPeer(() => {
    // Never respond — the client's bounded timeout must abort.
  });
  try {
    const config = parseReplicaPeersConfig({
      replicaPeers: { enabled: true, requestTimeoutMs: 100, peers: [{ url: peer.url }] },
    });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "unreachable");
    assert.notEqual(report.peers[0]?.state, "converged");
    assert.equal(report.peers[0]?.reason, "timeout");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: a 2xx payload without corpus is unknown, not converged (§22)", async () => {
  const peer = await startPeer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, extraction: {} })); // no `corpus`
  });
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "unknown");
    assert.notEqual(report.peers[0]?.state, "converged");
    assert.equal(report.peers[0]?.reason, "missing_corpus");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: disabled config performs NO network I/O (peer receives zero requests)", async () => {
  const peer = await startPeer(corpusHandler([watermark("default")]));
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: false, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.enabled, false);
    assert.equal(report.polledAt, null);
    assert.equal(peer.requests.length, 0, "a disabled monitor must never touch the network");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: the peer token is sent as a Bearer header but never leaks to the report or logs", async () => {
  const secret = "SUPER-SECRET-PEER-TOKEN";
  const peer = await startPeer(corpusHandler([watermark("default", { digest: "different", memoryFileCount: 999_999 })]));
  const logs: string[] = [];
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url, token: secret }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")], log: (line) => logs.push(line) });
    const authHeaders = peer.requests.map((request) => request.authorization);
    assert.ok(authHeaders.includes(`Bearer ${secret}`), "the token IS sent (so the leak check is not vacuous)");
    assert.ok(!JSON.stringify(report).includes(secret), "the token must not appear in the report payload");
    assert.equal(report.peers[0]?.state, "diverged", "the peer diverged, so a warn line is emitted");
    assert.ok(logs.length > 0, "a divergence is logged");
    assert.ok(!logs.some((line) => line.includes(secret)), "the token must not appear in any log line");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: a corpus with a malformed entry is unknown, not converged (review round 1)", async () => {
  const peer = await startPeer((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/engram/v1/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, corpus: [watermark("default"), {}] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: peer.url }] } });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "unknown");
    assert.equal(report.peers[0]?.reason, "malformed_corpus");
    assert.notEqual(report.peers[0]?.state, "converged");
  } finally {
    await peer.close();
  }
});

test("pollReplicaPeers: a SecretRef token with no resolver degrades to unreachable, never throws (review round 1)", async () => {
  const peer = await startPeer(corpusHandler([watermark("default")]));
  try {
    const config = parseReplicaPeersConfig({
      replicaPeers: { enabled: true, peers: [{ url: peer.url, token: { source: "exec", provider: "kc_peer" } }] },
    });
    const report = await pollReplicaPeers({ config, localWatermarks: [watermark("default")] });
    assert.equal(report.peers[0]?.state, "unreachable");
    assert.equal(report.peers[0]?.reason, "token_error");
    assert.notEqual(report.peers[0]?.state, "converged");
    assert.equal(peer.requests.length, 0, "no request is sent when the token cannot be resolved");
  } finally {
    await peer.close();
  }
});

test("round 6 (codex P2): a stalling peer-token resolver times out instead of hanging the fetch", { timeout: 5000 }, async () => {
  const stall = () => Promise.withResolvers<string>().promise; // never settles
  const config = parseReplicaPeersConfig({
    replicaPeers: {
      enabled: true,
      requestTimeoutMs: 100,
      peers: [{ url: "http://127.0.0.1:4318", token: { source: "exec", provider: "kc_peer" } }],
    },
  });
  const report = await pollReplicaPeers({
    config,
    localWatermarks: [watermark("default")],
    resolveSecretRef: stall,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) }),
  });
  assert.equal(report.peers[0]?.state, "unreachable", "a stalled token resolver degrades to unreachable, not a hang");
  assert.equal(report.peers[0]?.reason, "timeout");
  assert.notEqual(report.peers[0]?.state, "converged");
});

test("pollReplicaPeers: a provided resolveSecretRef resolves a SecretRef token and sends it as Bearer (review round 1)", async () => {
  const peer = await startPeer(corpusHandler([watermark("default")]));
  try {
    const config = parseReplicaPeersConfig({
      replicaPeers: { enabled: true, peers: [{ url: peer.url, token: { source: "exec", provider: "kc_peer" } }] },
    });
    const report = await pollReplicaPeers({
      config,
      localWatermarks: [watermark("default")],
      resolveSecretRef: async () => "RESOLVED-PEER-BEARER",
    });
    assert.equal(report.peers[0]?.state, "converged");
    assert.ok(
      peer.requests.some((request) => request.authorization === "Bearer RESOLVED-PEER-BEARER"),
      "the host-resolved SecretRef token is sent to the peer",
    );
  } finally {
    await peer.close();
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

function reportWithNamespaces(): ReplicaDivergenceStatus {
  const comparison = compareReplicaWatermarks(
    [watermark("default", { digest: "a" }), watermark("team-secret", { digest: "a" })],
    [watermark("default", { digest: "a" }), watermark("team-secret", { digest: "b" })], // team-secret diverges
    THRESHOLDS,
  );
  return {
    enabled: true,
    pending: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [{ peer: "127.0.0.1:4318", state: comparison.state, polledAt: "2026-03-08T00:00:00.000Z", namespaces: comparison.namespaces, divergedNamespaceCount: comparison.divergedNamespaceCount }],
  };
}

test("filterReplicaReportByCaps: a namespace-restricted token cannot see other namespaces' divergence", () => {
  const report = reportWithNamespaces();
  const restricted = filterReplicaReportByCaps(report, { version: 1, namespaces: ["default"] });
  const visibleNamespaces = restricted.peers[0]?.namespaces.map((delta) => delta.namespace) ?? [];
  assert.deepEqual(visibleNamespaces, ["default"], "only the permitted namespace is visible");
  assert.equal(restricted.peers[0]?.state, "converged", "divergence in a hidden namespace must not leak as a diverged verdict");
  assert.equal(restricted.peers[0]?.divergedNamespaceCount, 0);
});

test("filterReplicaReportByCaps: an unrestricted token sees the full report", () => {
  const report = reportWithNamespaces();
  const full = filterReplicaReportByCaps(report, { version: 1 });
  assert.equal(full.peers[0]?.namespaces.length, 2);
  assert.equal(full.peers[0]?.state, "diverged");
});

test("filterReplicaReportByCaps: an unreachable peer's state is preserved for a restricted token", () => {
  const report: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [{ peer: "127.0.0.1:4318", state: "unreachable", polledAt: "2026-03-08T00:00:00.000Z", namespaces: [], divergedNamespaceCount: 0, reason: "timeout" }],
  };
  const restricted = filterReplicaReportByCaps(report, { version: 1, namespaces: ["default"] });
  assert.equal(restricted.peers[0]?.state, "unreachable", "reachability is not namespace data and must survive filtering");
  assert.equal(restricted.peers[0]?.reason, "timeout");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("redactPeerUrl: strips userinfo, path, and query so an embedded credential cannot leak", () => {
  assert.equal(redactPeerUrl("https://user:s3cr3t@host.example:4318/health?token=abc"), "host.example:4318");
  assert.equal(redactPeerUrl("http://127.0.0.1:9999"), "127.0.0.1:9999");
  assert.ok(!redactPeerUrl("https://user:s3cr3t@host.example:4318/x").includes("s3cr3t"));
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("ReplicaDivergenceMonitor: disabled config never polls and reports disabled", () => {
  let computed = 0;
  const monitor = new ReplicaDivergenceMonitor();
  const config = parseReplicaPeersConfig({ replicaPeers: { enabled: false, peers: [{ url: "http://127.0.0.1:1" }] } });
  const report = monitor.getReport({ config, computeLocalWatermarks: async () => { computed += 1; return { watermarks: [], complete: true }; } });
  assert.equal(report.enabled, false);
  assert.equal(computed, 0, "a disabled monitor never computes local watermarks or polls");
});

test("ReplicaDivergenceMonitor: stale-while-revalidate serves cached state and single-flights the poll", async () => {
  let clock = 1_000;
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [watermark("default", { memoryFileCount: 999, digest: "z" })] }) });
  let computeCalls = 0;
  const computeLocalWatermarks = async () => {
    computeCalls += 1;
    return { watermarks: [watermark("default", { memoryFileCount: 1, digest: "a" })], complete: true };
  };
  const monitor = new ReplicaDivergenceMonitor({ clock: () => clock, fetchImpl });
  const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, pollIntervalMs: 60_000, peers: [{ url: "http://127.0.0.1:4318" }] } });

  const cold = monitor.getReport({ config, computeLocalWatermarks });
  assert.equal(cold.polledAt, null);
  await monitor.whenIdle();

  const warm = monitor.getReport({ config, computeLocalWatermarks });
  assert.equal(warm.peers[0]?.state, "diverged");
  assert.equal(computeCalls, 1, "single-flight: exactly one poll within the TTL");
  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(computeCalls, 1, "still one — the cached report is fresh");

  clock += 60_001;
  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(computeCalls, 2, "a probe past the poll interval re-polls");
});

test("ReplicaDivergenceMonitor: applies capability filtering at read time", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default", { digest: "a" }), watermark("team-secret", { digest: "b" })] }),
  });
  const computeLocalWatermarks = async () => ({
    watermarks: [watermark("default", { digest: "a" }), watermark("team-secret", { digest: "a" })],
    complete: true,
  });
  const monitor = new ReplicaDivergenceMonitor({ fetchImpl });
  const config = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } });
  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  const restricted = monitor.getReport({ config, computeLocalWatermarks, caps: { version: 1, namespaces: ["default"] } });
  assert.deepEqual(restricted.peers[0]?.namespaces.map((delta) => delta.namespace), ["default"]);
  assert.equal(restricted.peers[0]?.state, "converged", "the hidden team-secret divergence must not leak");
});

test("ReplicaDivergenceMonitor: warming state is distinguishable from no-peers configured (review round 1)", async () => {
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) });
  const computeLocalWatermarks = async () => ({ watermarks: [watermark("default")], complete: true });
  const monitor = new ReplicaDivergenceMonitor({ fetchImpl });
  const withPeers = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } });
  const noPeers = parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [] } });

  const warming = monitor.getReport({ config: withPeers, computeLocalWatermarks });
  assert.equal(warming.pending, true);
  assert.equal(warming.peers.length, 0);

  assert.equal(monitor.getReport({ config: noPeers, computeLocalWatermarks }).pending, false);

  await monitor.whenIdle();
  const polled = monitor.getReport({ config: withPeers, computeLocalWatermarks });
  assert.equal(polled.pending, false);
  assert.equal(polled.peers[0]?.state, "converged");
});

test("ReplicaDivergenceMonitor: a partial config with no replicaPeers block reads as disabled, never crashes (review round 1)", () => {
  const monitor = new ReplicaDivergenceMonitor();
  const report = monitor.getReport({ config: undefined, computeLocalWatermarks: async () => ({ watermarks: [], complete: true }) });
  assert.equal(report.enabled, false);
  assert.equal(report.pending, false);
  assert.equal(report.peers.length, 0);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

test("round 2 (cursor): poll TTL runs from completion, so a slow poll cannot self-expire", async () => {
  let now = 1_000_000;
  let polls = 0;
  const fetchImpl: FetchLike = async () => {
    polls += 1;
    now += 60_000; // the poll itself outlasts the 30s interval below
    return { ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) };
  };
  const monitor = new ReplicaDivergenceMonitor({ fetchImpl, clock: () => now });
  const config = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, pollIntervalMs: 30_000, peers: [{ url: "http://127.0.0.1:4318" }] },
  });
  const computeLocalWatermarks = async () => ({ watermarks: [watermark("default")], complete: true });

  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(polls, 1, "first probe triggers exactly one poll");

  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(polls, 1, "a poll slower than the interval must not be born expired");

  now += 31_000; // now past the interval measured from completion
  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(polls, 2, "the cache still expires once the interval genuinely elapses");
});

test("round 6 (coderabbit): a persistently failing poll backs off one interval, not one scan per probe", async () => {
  let clock = 1_000_000;
  let computeCalls = 0;
  const computeLocalWatermarks = async () => {
    computeCalls += 1;
    throw new Error("local corpus unreadable");
  };
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) });
  const monitor = new ReplicaDivergenceMonitor({ clock: () => clock, fetchImpl });
  const config = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, pollIntervalMs: 60_000, peers: [{ url: "http://127.0.0.1:4318" }] },
  });

  const first = monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(computeCalls, 1, "the first probe triggers exactly one scan");
  assert.equal(first.pending, true, "a never-completed poll reports pending, never converged");

  for (let i = 0; i < 5; i += 1) {
    const during = monitor.getReport({ config, computeLocalWatermarks });
    await monitor.whenIdle();
    assert.equal(during.pending, true, "probes during backoff stay pending, never converged");
  }
  assert.equal(computeCalls, 1, "sequential probes within one interval must NOT reschedule the scan");

  clock += 61_000;
  monitor.getReport({ config, computeLocalWatermarks });
  await monitor.whenIdle();
  assert.equal(computeCalls, 2, "the backoff releases after pollIntervalMs elapses");
});

test("round 2 (codex P2): the file-count threshold tolerates a real sub-threshold delta", async () => {
  const baseDir = "/tmp/replica-threshold-fixture";
  const localPaths = ["facts/2026-03-01/a.md", "facts/2026-03-01/b.md"].map((rel) => `${baseDir}/${rel}`);
  const peerPaths = [...localPaths, `${baseDir}/facts/2026-03-01/c.md`];
  const now = new Date("2026-03-08T00:00:00.000Z");
  const local = await computeCorpusWatermark({ namespace: "default", paths: localPaths, baseDir, now });
  const peer = await computeCorpusWatermark({ namespace: "default", paths: peerPaths, baseDir, now });
  assert.notEqual(local.digest, peer.digest, "a real count delta necessarily changes the digest");

  const tolerant = compareReplicaWatermarks([local], [peer], THRESHOLDS);
  assert.equal(tolerant.state, "converged", "a delta of 1 is within maxFileCountDelta=100 and must be tolerated");

  const strict = compareReplicaWatermarks([local], [peer], { maxFileCountDelta: 0, maxWatermarkAgeDeltaMs: 900_000 });
  assert.equal(strict.state, "diverged", "the same pair still diverges once the threshold is tightened");
});

test("round 2 (codex P2): semantically malformed peer watermarks read as unknown, never converged", async () => {
  const cases: Array<[string, unknown]> = [
    ["negative count", { ...watermark("default"), memoryFileCount: -1 }],
    ["fractional count", { ...watermark("default"), memoryFileCount: 1.5 }],
    ["unparseable timestamp", { ...watermark("default"), newestWriteAt: "not-a-date" }],
    ["non-string digest", { ...watermark("default"), digest: 42 }],
  ];
  for (const [label, corpus] of cases) {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [corpus] }) });
    const status = await pollReplicaPeers({
      config: parseReplicaPeersConfig({
        replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] },
      }),
      localWatermarks: [watermark("default")],
      fetchImpl,
    });
    assert.equal(status.peers[0]?.state, "unknown", `${label} must resolve to unknown`);
    assert.notEqual(status.peers[0]?.state, "converged", `${label} must never be certified converged`);
  }
});

test("round 6 (codex P1): a stale peer census reads as unknown, never converged", async () => {
  const now = Date.parse("2026-03-08T12:00:00.000Z");
  const staleAt = new Date(now - 20 * 60_000).toISOString(); // 20 min > default 15 min bound
  const staleImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default", { computedAt: staleAt })] }),
  });
  const stale = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    now: new Date(now),
    fetchImpl: staleImpl,
  });
  assert.equal(stale.peers[0]?.state, "unknown", "a stale peer census must not be certified converged");
  assert.equal(stale.peers[0]?.reason, "peer_census_stale");
  assert.notEqual(stale.peers[0]?.state, "converged");

  const freshImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) });
  const fresh = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl: freshImpl,
  });
  assert.equal(fresh.peers[0]?.state, "converged", "a fresh peer census still converges");
});

test("round 6 (codex P2): a peer census computed during a slow poll is fresh, not future-stale", { timeout: 5000 }, async () => {
  const fetchImpl: FetchLike = async () => {
    const gate = Promise.withResolvers<void>();
    setTimeout(() => gate.resolve(), 120); // push the response well past polledAt
    await gate.promise;
    return { ok: true, status: 200, json: async () => ({ corpus: [watermark("default", { computedAt: new Date().toISOString() })] }) };
  };
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, maxWatermarkAgeDeltaMs: 50, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl,
  });
  assert.equal(status.peers[0]?.state, "converged", "a census computed during the request is fresh at response time, not future-stale");
  assert.notEqual(status.peers[0]?.reason, "peer_census_stale");
});

test("round 6 (cursor): maxWatermarkAgeDeltaMs=0 (any-gap divergence mode) does NOT gate census staleness", async () => {
  const now = Date.parse("2026-03-08T12:00:00.000Z");
  const oldButMatching = watermark("default", { computedAt: new Date(now - 60 * 60_000).toISOString() });
  const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ corpus: [oldButMatching] }) });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({
      replicaPeers: { enabled: true, maxWatermarkAgeDeltaMs: 0, peers: [{ url: "http://127.0.0.1:4318" }] },
    }),
    localWatermarks: [watermark("default", { computedAt: new Date(now).toISOString() })],
    now: new Date(now),
    fetchImpl,
  });
  assert.equal(status.peers[0]?.state, "converged", "a 0 age bound must not certify every peer as peer_census_stale");
  assert.notEqual(status.peers[0]?.reason, "peer_census_stale");
});

test("round 6 (codex P2): a future-dated peer census is rejected, never indefinitely fresh", async () => {
  const now = Date.parse("2026-03-08T12:00:00.000Z");
  const futureImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default", { computedAt: "9999-01-01T00:00:00.000Z" })] }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    now: new Date(now),
    fetchImpl: futureImpl,
  });
  assert.equal(status.peers[0]?.state, "unknown", "a future-dated census must not be certified converged");
  assert.equal(status.peers[0]?.reason, "peer_census_stale");
  assert.notEqual(status.peers[0]?.state, "converged");
});

test("round 3 (codex P2): a peer repeating a namespace is malformed, not converged", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      corpus: [
        { ...watermark("default"), digest: "does-not-match", memoryFileCount: 9_999 },
        watermark("default"),
      ],
    }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl,
  });
  assert.equal(status.peers[0]?.state, "unknown", "a duplicated namespace must read as malformed");
  assert.notEqual(status.peers[0]?.state, "converged", "the shadowed mismatch must not be certified healthy");
  assert.equal(status.peers[0]?.reason, "malformed_corpus");
});

test("round 3 (codex P2): a present-but-invalid replicaPeers.enabled is rejected, not read as false", () => {
  for (const bad of [1, 0, "yes-please", {}]) {
    assert.throws(
      () => parseReplicaPeersConfig({ replicaPeers: { enabled: bad, peers: [] } }),
      /replicaPeers\.enabled must be a boolean/,
      `enabled: ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: "false", peers: [] } }).enabled, false);
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [] } }).enabled, true);
  assert.equal(parseReplicaPeersConfig({ replicaPeers: { peers: [] } }).enabled, false, "absent -> default");
});

test("round 4 (cursor): an incomplete local census cannot certify a peer converged", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default")] }),
  });
  const config = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] },
  });

  const complete = new ReplicaDivergenceMonitor({ fetchImpl });
  complete.getReport({ config, computeLocalWatermarks: async () => ({ watermarks: [watermark("default")], complete: true }) });
  await complete.whenIdle();
  const ok = complete.getReport({ config, computeLocalWatermarks: async () => ({ watermarks: [watermark("default")], complete: true }) });
  assert.equal(ok.peers[0]?.state, "converged", "a complete census still certifies convergence");
  assert.equal(ok.censusComplete, true);

  const partial = new ReplicaDivergenceMonitor({ fetchImpl });
  const incomplete = async () => ({ watermarks: [watermark("default")], complete: false });
  partial.getReport({ config, computeLocalWatermarks: incomplete });
  await partial.whenIdle();
  const gated = partial.getReport({ config, computeLocalWatermarks: incomplete });
  assert.equal(gated.censusComplete, false);
  assert.equal(gated.peers[0]?.state, "unknown", "an incomplete census downgrades converged to unknown");
  assert.equal(gated.peers[0]?.reason, "local_census_incomplete");
});

test("round 4 (codex P2): a present null peer token is rejected, not silently unauthenticated", () => {
  assert.throws(
    () =>
      parseReplicaPeersConfig({
        replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318", token: null }] },
      }),
    /token must be a string or a SecretRef object/,
  );
  const omitted = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] },
  });
  assert.equal(omitted.peers[0]?.token, undefined);
});

function delta(namespace: string) {
  return {
    namespace,
    presence: "both" as const,
    fileCountDelta: 0,
    writeAgeDeltaMs: 0,
    digestMatch: true,
    diverged: false,
    reasons: [] as string[],
    localFileCount: 10,
    peerFileCount: 10,
    localNewestWriteAt: "2026-03-08T00:00:00.000Z",
    peerNewestWriteAt: "2026-03-08T00:00:00.000Z",
  };
}

test("round 5 (cursor/codex): a capability filter cannot clear a census-level unknown", () => {
  const report: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    censusComplete: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "unknown",
        reason: "local_census_incomplete",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 0,
        namespaces: [
          delta("default"),
          delta("team-secret"),
        ],
      },
    ],
  };
  const filtered = filterReplicaReportByCaps(report, { namespaces: ["default"] } as never);
  assert.equal(filtered.peers[0]?.state, "unknown", "an incomplete census must not be filtered into converged");
  assert.equal(filtered.peers[0]?.reason, "local_census_incomplete", "and its reason must survive");
  assert.equal(filtered.peers[0]?.namespaces.length, 1, "hidden namespaces are still filtered out");
});

test("round 6 (coderabbit): a cap filter that hides every namespace yields unknown, not converged", async () => {
  const report: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    censusComplete: true,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "converged",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 0,
        namespaces: [delta("team-secret")],
      },
    ],
  };
  const filtered = filterReplicaReportByCaps(report, { namespaces: ["default"] } as never);
  assert.equal(filtered.peers[0]?.state, "unknown", "hiding every namespace cannot leave a converged verdict");
  assert.equal(filtered.peers[0]?.reason, "no_shared_namespaces");
  assert.equal(filtered.peers[0]?.namespaces.length, 0, "the hidden namespace is filtered out");
});

test("round 6 (codex P2): capability filtering re-applies the census gate (no false split-brain for a restricted caller)", () => {
  const report: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    censusComplete: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "diverged",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 2,
        namespaces: [
          { ...delta("team-secret"), diverged: true, digestMatch: false, reasons: ["digest_mismatch"] },
          {
            namespace: "team-a",
            presence: "peer_only",
            localFileCount: null,
            peerFileCount: 5,
            fileCountDelta: null,
            localNewestWriteAt: null,
            peerNewestWriteAt: null,
            writeAgeDeltaMs: null,
            digestMatch: null,
            diverged: true,
            reasons: ["namespace_absent_locally"],
          },
        ],
      },
    ],
  };
  const filtered = filterReplicaReportByCaps(report, { namespaces: ["team-a"] } as never);
  assert.equal(filtered.peers[0]?.state, "unknown", "a hidden shared divergence must not leave the visible peer_only as a false split-brain");
  assert.equal(filtered.peers[0]?.reason, "local_census_incomplete");
  assert.notEqual(filtered.peers[0]?.state, "diverged");
  assert.equal(filtered.peers[0]?.namespaces.length, 1, "only the visible namespace remains");
});

test("round 6 (codex P2): an incomplete census downgrades peer-only divergence but keeps real shared divergence", () => {
  const peerOnly: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "diverged",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 1,
        namespaces: [
          {
            namespace: "team-a",
            presence: "peer_only",
            localFileCount: null,
            peerFileCount: 5,
            fileCountDelta: null,
            localNewestWriteAt: null,
            peerNewestWriteAt: null,
            writeAgeDeltaMs: null,
            digestMatch: null,
            diverged: true,
            reasons: ["namespace_absent_locally"],
          },
        ],
      },
    ],
  };
  const gatedPeerOnly = gateReportByCensus(peerOnly, false);
  assert.equal(gatedPeerOnly.peers[0]?.state, "unknown", "peer-only divergence is unsafe against a partial local census");
  assert.equal(gatedPeerOnly.peers[0]?.reason, "local_census_incomplete");
  assert.notEqual(gatedPeerOnly.peers[0]?.state, "diverged");

  const shared: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "diverged",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 1,
        namespaces: [{ ...delta("default"), diverged: true, digestMatch: false, reasons: ["digest_mismatch"] }],
      },
    ],
  };
  const gatedShared = gateReportByCensus(shared, false);
  assert.equal(gatedShared.peers[0]?.state, "diverged", "a real shared-namespace divergence stands regardless of census completeness");
  assert.equal(gatedShared.censusComplete, false);
});

test("round 6 (codex P2): a mixed incomplete census keeps shared divergence but neutralizes peer-only deltas", () => {
  const report: ReplicaDivergenceStatus = {
    enabled: true,
    pending: false,
    censusComplete: false,
    polledAt: "2026-03-08T00:00:00.000Z",
    peers: [
      {
        peer: "127.0.0.1:4318",
        state: "diverged",
        polledAt: "2026-03-08T00:00:00.000Z",
        divergedNamespaceCount: 2,
        namespaces: [
          { ...delta("default"), diverged: true, digestMatch: false, reasons: ["digest_mismatch"] },
          {
            namespace: "team-b",
            presence: "peer_only",
            localFileCount: null,
            peerFileCount: 7,
            fileCountDelta: null,
            localNewestWriteAt: null,
            peerNewestWriteAt: null,
            writeAgeDeltaMs: null,
            digestMatch: null,
            diverged: true,
            reasons: ["namespace_absent_locally"],
          },
        ],
      },
    ],
  };
  const peer = gateReportByCensus(report, false).peers[0];
  assert.equal(peer?.state, "diverged", "the real shared divergence keeps the peer diverged");
  assert.equal(peer?.divergedNamespaceCount, 1, "only the shared divergence counts; the peer_only delta is neutralized");
  assert.equal(peer?.namespaces.find((d) => d.namespace === "team-b")?.diverged, false, "the untrusted peer_only delta must not read as divergence");
  assert.equal(peer?.namespaces.find((d) => d.namespace === "default")?.diverged, true, "the shared divergence delta is preserved");
});

test("round 6 (coderabbit): the dual-prefix fallback inherits the REMAINING shared deadline", async () => {
  //
  let fallbackSignalAborted: boolean | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    if (String(url).includes("/engram/v1/")) {
      const burned = Promise.withResolvers<void>();
      setTimeout(() => burned.resolve(), 220);
      await burned.promise;
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const waited = Promise.withResolvers<void>();
    setTimeout(() => waited.resolve(), 150);
    await waited.promise;
    fallbackSignalAborted = init?.signal?.aborted;
    return { ok: true, status: 200, json: async () => ({ corpus: [watermark("default")] }) };
  };
  await pollReplicaPeers({
    config: parseReplicaPeersConfig({
      replicaPeers: { enabled: true, requestTimeoutMs: 300, peers: [{ url: "http://127.0.0.1:4318" }] },
    }),
    localWatermarks: [watermark("default")],
    fetchImpl,
  });
  assert.equal(
    fallbackSignalAborted,
    true,
    "the fallback's signal is bounded by the REMAINING shared budget (aborted <150ms in), not a fresh 300ms one",
  );
});

test("round 7 (codex P2): an oversized peer body is refused, not buffered", async () => {
  let delivered = 0;
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [] }),
    body: {
      getReader: () => ({
        read: async () => {
          delivered += chunk.byteLength;
          return delivered > MAX_PEER_RESPONSE_BYTES * 4
            ? { done: true, value: undefined }
            : { done: false, value: chunk };
        },
        cancel: async () => undefined,
      }),
    },
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl,
  });
  assert.equal(status.peers[0]?.state, "unknown");
  assert.equal(status.peers[0]?.reason, "response_too_large");
  assert.ok(
    delivered <= MAX_PEER_RESPONSE_BYTES + chunk.byteLength,
    `must stop at the cap, buffered ${delivered} bytes`,
  );
});

test("round 7 (codex P2): a noncanonical peer namespace key is malformed", async () => {
  for (const bad of ["default ", "../escape", "team\u0000a"]) {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ corpus: [{ ...watermark("default"), namespace: bad }] }),
    });
    const status = await pollReplicaPeers({
      config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
      localWatermarks: [watermark("default")],
      fetchImpl,
    });
    assert.equal(status.peers[0]?.state, "unknown", `${JSON.stringify(bad)} must not be accepted`);
    assert.equal(status.peers[0]?.reason, "malformed_corpus");
  }
});

test("round 7 (codex P1): a peer advertising an incomplete census cannot converge", async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default")], replica: { censusComplete: false } }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl,
  });
  assert.equal(status.peers[0]?.state, "unknown");
  assert.equal(status.peers[0]?.reason, "peer_census_incomplete");

  const healthy: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ corpus: [watermark("default")], replica: { censusComplete: true } }),
  });
  const ok = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl: healthy,
  });
  assert.equal(ok.peers[0]?.state, "converged");
});

test("round 8 (codex P1): corpusComplete describing THIS response wins over the replica block", async () => {
  const mixed: FetchLike = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      corpus: [watermark("default")],
      corpusComplete: false, // the array we were actually given is partial
      replica: { censusComplete: true }, // the peer's separate monitor scan was fine
    }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl: mixed,
  });
  assert.equal(status.peers[0]?.state, "unknown", "a partial corpus must not converge on a stale complete flag");
  assert.equal(status.peers[0]?.reason, "peer_census_incomplete");
});

test("round 8 (codex P2): an unterminated env placeholder in a peer token is rejected", () => {
  assert.throws(
    () =>
      parseReplicaPeersConfig({
        replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318", token: "${PEER_TOKEN" }] },
      }),
    /unterminated environment variable placeholder/,
    "a typo'd placeholder must fail at parse, not be sent literally as a bearer token",
  );
});

test("round 9 (cursor): a cached poll is re-gated by the census shipped with THIS response", async () => {
  let now = 0;
  const monitor = new ReplicaDivergenceMonitor({ clock: () => now, fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ corpus: [watermark("default")], corpusComplete: true }),
  }) });
  const config = parseReplicaPeersConfig({
    replicaPeers: { enabled: true, pollIntervalMs: 60_000, peers: [{ url: "http://127.0.0.1:4318" }] },
  });
  const complete = async () => ({ watermarks: [watermark("default")], complete: true });
  monitor.getReport({ config, computeLocalWatermarks: complete });
  await monitor.whenIdle();
  const fresh = monitor.getReport({ config, computeLocalWatermarks: complete });
  assert.equal(fresh.peers[0]?.state, "converged", "baseline: a complete census can certify convergence");

  now += 1_000; // still inside the poll TTL, so the cache is served
  const degraded = monitor.getReport({ config, computeLocalWatermarks: complete, localCensusComplete: false });
  assert.notEqual(degraded.peers[0]?.state, "converged", "an incomplete census cannot certify a cached verdict");
  assert.equal(degraded.censusComplete, false);
});

test("round 9 (codex P2): a present but non-boolean corpusComplete is malformed telemetry", async () => {
  const bad: FetchLike = async () => ({
    ok: true, status: 200,
    json: async () => ({ corpus: [watermark("default")], corpusComplete: "false" }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl: bad,
  });
  assert.equal(status.peers[0]?.state, "unknown");
  assert.equal(status.peers[0]?.reason, "malformed_corpus", "a corrupt flag must not fall through to a weaker signal");
});

test("round 9 (codex P2): a token expanding to whitespace is rejected, not silently unauthenticated", () => {
  process.env.REMNIC_TEST_BLANK_PEER_TOKEN = "   ";
  try {
    assert.throws(
      () =>
        parseReplicaPeersConfig({
          replicaPeers: {
            enabled: true,
            peers: [{ url: "http://127.0.0.1:4318", token: "${REMNIC_TEST_BLANK_PEER_TOKEN}" }],
          },
        }),
      /expanded to an empty value/,
    );
  } finally {
    delete process.env.REMNIC_TEST_BLANK_PEER_TOKEN;
  }
});

test("round 10 (codex P2): a malformed LEGACY completeness flag is rejected too", async () => {
  const bad: FetchLike = async () => ({
    ok: true, status: 200,
    json: async () => ({ corpus: [watermark("default")], replica: { censusComplete: "false" } }),
  });
  const status = await pollReplicaPeers({
    config: parseReplicaPeersConfig({ replicaPeers: { enabled: true, peers: [{ url: "http://127.0.0.1:4318" }] } }),
    localWatermarks: [watermark("default")],
    fetchImpl: bad,
  });
  assert.equal(status.peers[0]?.state, "unknown");
  assert.equal(status.peers[0]?.reason, "malformed_corpus");
});

test("round 10 (codex P2): an expanded peer URL is stored canonically", () => {
  process.env.REMNIC_TEST_PEER_URL = "  http://127.0.0.1:4318  ";
  try {
    const config = parseReplicaPeersConfig({
      replicaPeers: { enabled: true, peers: [{ url: "${REMNIC_TEST_PEER_URL}" }] },
    });
    assert.equal(config.peers[0]?.url, "http://127.0.0.1:4318");
  } finally {
    delete process.env.REMNIC_TEST_PEER_URL;
  }
});

test("round 10 (codex P2): a cached verdict cannot outlive the census freshness bound", async () => {
  let now = 0;
  const monitor = new ReplicaDivergenceMonitor({ clock: () => now, fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ corpus: [watermark("default")], corpusComplete: true }),
  }) });
  const config = parseReplicaPeersConfig({
    replicaPeers: {
      enabled: true, pollIntervalMs: 86_400_000, maxWatermarkAgeDeltaMs: 900_000,
      peers: [{ url: "http://127.0.0.1:4318" }],
    },
  });
  const census = async () => ({ watermarks: [watermark("default")], complete: true });
  monitor.getReport({ config, computeLocalWatermarks: census });
  await monitor.whenIdle();
  let polls = 0;
  const counting = async () => { polls += 1; return { watermarks: [watermark("default")], complete: true }; };
  now += 900_001; // past the freshness bound, far short of the poll interval
  monitor.getReport({ config, computeLocalWatermarks: counting });
  await monitor.whenIdle();
  assert.equal(polls, 1, "the cache must expire at the freshness bound, not the poll interval");
});

test("round 11: maxWatermarkAgeDeltaMs=0 disables the freshness cap, it does not zero the cache", async () => {
  let now = 0;
  const monitor = new ReplicaDivergenceMonitor({ clock: () => now, fetchImpl: async () => ({
    ok: true, status: 200,
    json: async () => ({ corpus: [watermark("default")], corpusComplete: true }),
  }) });
  const config = parseReplicaPeersConfig({
    replicaPeers: {
      enabled: true, pollIntervalMs: 300_000, maxWatermarkAgeDeltaMs: 0,
      peers: [{ url: "http://127.0.0.1:4318" }],
    },
  });
  let polls = 0;
  const census = async () => { polls += 1; return { watermarks: [watermark("default")], complete: true }; };
  monitor.getReport({ config, computeLocalWatermarks: census });
  await monitor.whenIdle();
  now += 1_000; // well inside pollIntervalMs
  monitor.getReport({ config, computeLocalWatermarks: census });
  await monitor.whenIdle();
  assert.equal(polls, 1, "the cache must still honor pollIntervalMs when the freshness gate is disabled");
});
