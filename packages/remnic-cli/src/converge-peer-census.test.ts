import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { isPeerTransportCensusFailure } from "./converge-namespace-exclusions.js";
import { planPeerNamespaceCensus } from "./converge-peer-census.js";

function chunkResponse(content: Buffer, filePath: string): Response {
  return new Response(new Uint8Array(content), {
    headers: {
      "x-remnic-chunk-offset": "0",
      "x-remnic-chunk-bytes": String(content.length),
      "x-remnic-file-bytes": String(content.length),
      "x-remnic-file-mtime-ms": "1",
      "x-remnic-file-path": encodeURIComponent(filePath),
      "x-remnic-file-sha256": createHash("sha256").update(content).digest("hex"),
    },
  });
}

test("peer census threads the abort signal into snapshot, per-file, and tombstone fetches (#2954)", async () => {
  const controller = new AbortController();
  const memoryContent = Buffer.from("---\nid: census-abort\n---\nbody\n");
  const memorySha = createHash("sha256").update(memoryContent).digest("hex");
  const tombstonePath = "state/tombstones.jsonl";
  const signals: { snapshot?: AbortSignal; perFile?: AbortSignal; tombstone?: AbortSignal } = {};

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/snapshot")) {
      signals.snapshot = init?.signal ?? undefined;
      return Response.json({
        files: [
          { path: "facts/census-abort.md", sha256: memorySha, bytes: memoryContent.length },
          { path: tombstonePath, sha256: "a".repeat(64), bytes: 0 },
        ],
        tombstones: [],
      });
    }
    if (url.pathname.endsWith("/offline-sync/file-content")) {
      const request = JSON.parse(String(init?.body)) as { path: string };
      if (request.path === "facts/census-abort.md") {
        signals.perFile = init?.signal ?? undefined;
        return chunkResponse(memoryContent, request.path);
      }
      // The operator hits Ctrl+C while the tombstone-evidence fetch is in
      // flight: the request must reject, not hang or silently retry forever.
      signals.tombstone = init?.signal ?? undefined;
      controller.abort();
      throw init?.signal?.reason ?? new Error("aborted");
    }
    throw new Error(`unexpected peer route: ${url.pathname}`);
  };

  await assert.rejects(
    planPeerNamespaceCensus({
      peerUrl: "http://peer",
      namespace: "default",
      index: 1,
      total: 1,
      resolvedToken: undefined,
      fetchFn: fetchImpl,
      timeoutMs: 5_000,
      manifestStream: false,
      peerManifestRevision: undefined,
      localManifestFiles: undefined,
      cache: null,
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /tombstone evidence/);
      assert.equal(isPeerTransportCensusFailure(error), true);
      return true;
    }
  );

  // Every captured request signal descends from the controller, so the abort
  // fired during the tombstone fetch flips all three. An unthreaded fetch
  // carries only its per-request timeout signal, which stays live.
  assert.ok(signals.snapshot?.aborted, "snapshot fetch must carry the abort signal");
  assert.ok(signals.perFile?.aborted, "per-file fetch must carry the abort signal");
  assert.ok(signals.tombstone?.aborted, "tombstone fetch must carry the abort signal");
});

test("peer census does not start the next manifest batch after a transport failure", async () => {
  const requested: string[] = [];
  const files = Array.from({ length: 51 }, (_unused, index) => ({
    path: `facts/file-${index}.md`,
    sha256: "ab".repeat(32),
    bytes: 1,
  }));
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/offline-sync/snapshot")) {
      return Response.json({ files, tombstones: [] });
    }
    const body = JSON.parse(String(init?.body)) as { path?: string };
    requested.push(body.path ?? "");
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
  };
  try {
    await assert.rejects(
      planPeerNamespaceCensus({
        peerUrl: "http://peer",
        namespace: "default",
        index: 1,
        total: 1,
        resolvedToken: undefined,
        fetchFn: fetchImpl,
        timeoutMs: 30,
        manifestStream: false,
        peerManifestRevision: undefined,
        localManifestFiles: undefined,
        cache: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /timeout|aborted/i);
        assert.equal(error.message.includes("failed to read peer reconciliation"), false);
        return true;
      }
    );
    assert.equal(requested.includes("facts/file-50.md"), false);
    assert.ok(requested.includes("facts/file-0.md"));
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});
