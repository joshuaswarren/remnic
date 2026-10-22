import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES } from "@remnic/core";
import { isPeerTransportCensusFailure } from "./converge-namespace-exclusions.js";
import {
  fetchPeerManifestStream,
  fetchPeerSnapshot,
  postPeerFileContent,
  postPeerFileDeletion,
  streamPeerFileContent,
} from "./converge-peer-transport.js";

test("peer transport canonicalizes request URLs without credentials or request-only parts", async () => {
  let requestedUrl = "";
  let requestSignal: AbortSignal | null | undefined;
  await fetchPeerSnapshot(
    " HTTPS://user:secret@PEER.EXAMPLE.COM:443/Memory/?token=abc#fragment ",
    "default",
    undefined,
    async (input, init) => {
      requestedUrl = String(input);
      requestSignal = init?.signal ?? undefined;
      return Response.json({ files: [], tombstones: [] });
    },
    50,
  );

  assert.equal(
    requestedUrl,
    "https://peer.example.com/Memory/remnic/v1/offline-sync/snapshot?namespace=default&include_transcripts=false&content=false",
  );
  assert.ok(requestSignal instanceof AbortSignal);
});

test("peer file pull resumes the staged stream on the alias route without buffering the file", async () => {
  const content = Buffer.from("abcdefgh");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const observedOffsets: number[] = [];
  const delivered: Buffer[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const request = JSON.parse(String(init?.body)) as { offset: number };
    observedOffsets.push(request.offset);
    if (url.pathname.includes("/remnic/") && request.offset === 4) {
      throw new Error("first route interrupted");
    }
    const chunk = content.subarray(request.offset, request.offset + 4);
    return new Response(chunk, {
      headers: {
        "x-remnic-chunk-offset": String(request.offset),
        "x-remnic-chunk-bytes": String(chunk.length),
        "x-remnic-file-bytes": String(content.length),
        "x-remnic-file-mtime-ms": "1234",
        "x-remnic-file-path": encodeURIComponent("facts/a.md"),
        "x-remnic-file-sha256": sha256,
      },
    });
  };

  const result = await streamPeerFileContent(
    "http://peer",
    "default",
    "facts/a.md",
    async (chunk) => {
      delivered.push(chunk.content);
    },
    undefined,
    fetchImpl,
  );

  assert.deepEqual(observedOffsets, [0, 4, 4]);
  assert.equal(Buffer.concat(delivered).toString(), content.toString());
  assert.deepEqual(result, { sha256, bytes: content.length, mtimeMs: 1234 });
});

test("peer file upload reads bounded chunks and resumes from the last acknowledged offset", async () => {
  const content = Buffer.alloc(OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES + 3, 7);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const readOffsets: number[] = [];
  const postedOffsets: number[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const offset = Number(new Headers(init?.headers).get("x-remnic-chunk-offset"));
    postedOffsets.push(offset);
    if (url.pathname.includes("/remnic/") && offset > 0) {
      throw new Error("first route interrupted");
    }
    const body = Buffer.from(await new Response(init?.body).arrayBuffer());
    return Response.json({
      done: offset + body.length === content.length,
      applied: offset + body.length === content.length,
      skipped: false,
    });
  };

  const result = await postPeerFileContent(
    "http://peer",
    "default",
    "facts/a.bin",
    {
      sha256,
      bytes: content.length,
      mtimeMs: 1234,
      readChunk: async (offset, length) => {
        readOffsets.push(offset);
        assert.ok(length <= OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES);
        assert.ok(length < content.length);
        return content.subarray(offset, offset + length);
      },
    },
    undefined,
    fetchImpl,
  );

  assert.equal(result, "applied");
  assert.deepEqual(postedOffsets, [
    0,
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
    OFFLINE_SYNC_FILE_CONTENT_TRANSFER_CHUNK_BYTES,
  ]);
  assert.deepEqual(readOffsets, postedOffsets);
});

test("peer transport rejects internal state paths before issuing a request", async () => {
  let requests = 0;
  let reads = 0;
  const internalPath = ".remnic/state/cursor.json";
  const fetchImpl: typeof fetch = async () => {
    requests += 1;
    throw new Error("must not fetch");
  };

  await assert.rejects(
    streamPeerFileContent("http://peer", "default", internalPath, async () => {}, undefined, fetchImpl),
    /internal Remnic state path/,
  );
  await assert.rejects(
    postPeerFileContent(
      "http://peer",
      "default",
      internalPath,
      {
        sha256: "a".repeat(64),
        bytes: 1,
        mtimeMs: 1,
        readChunk: async () => {
          reads += 1;
          return Buffer.from("x");
        },
      },
      undefined,
      fetchImpl,
    ),
    /internal Remnic state path/,
  );
  await assert.rejects(
    postPeerFileDeletion("http://peer", "default", internalPath, "a".repeat(64), undefined, fetchImpl),
    /internal Remnic state path/,
  );
  assert.equal(requests, 0);
  assert.equal(reads, 0);
});

test("peer snapshot error detail reads a bounded prefix and cancels the rest", { timeout: 2_000 }, async () => {
  let pulls = 0;
  let cancels = 0;
  const snapshot = await fetchPeerSnapshot(
    "http://peer",
    "blocked",
    undefined,
    async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          const chunk = Buffer.alloc(64 * 1024, 0x20);
          Buffer.from('{"error":"namespace is not readable: blocked"}').copy(chunk);
          controller.enqueue(new Uint8Array(chunk));
        },
        cancel() {
          cancels += 1;
        },
      });
      return new Response(body, { status: 400, headers: { "content-type": "application/json" } });
    },
    1_000
  ).catch((error: unknown) => error);
  assert.ok(snapshot instanceof Error);
  assert.match(snapshot.message, /HTTP 400 namespace is not readable: blocked/);
  // Two routes, and each stream refills its queue once after the capped read.
  // response.text() would pull this unending body until the test times out.
  assert.equal(pulls, 4);
  assert.ok(cancels >= 2);
});

test("peer snapshot error detail drops terminal control characters", async () => {
  const snapshot = await fetchPeerSnapshot(
    "http://peer",
    "blocked",
    undefined,
    async () =>
      Response.json(
        { error: "namespace is not readable: \u001b[31mblocked\u001b[0m \u001b]0;forged\u0007" },
        { status: 400 }
      ),
    1_000
  ).catch((error: unknown) => error);
  assert.ok(snapshot instanceof Error);
  assert.equal(snapshot.message.includes("\u001b"), false);
  assert.equal(snapshot.message.includes("\u0007"), false);
  assert.match(snapshot.message, /HTTP 400 namespace is not readable: \[31mblocked\[0m/);
});

test("peer transport aborts a stalled request at the configured timeout", async () => {
  const fetchImpl: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();

  try {
    await assert.rejects(
      fetchPeerSnapshot("http://peer", "default", undefined, fetchImpl, 1),
      /timeout|abort/i,
    );
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("peer snapshot keeps a timeout when the fallback route returns HTTP 404", async () => {
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/engram/")) return Promise.resolve(new Response(null, { status: 404 }));
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      const fail = () => reject(signal.reason);
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  try {
    await assert.rejects(fetchPeerSnapshot("http://peer", "alpha", undefined, fetchImpl, 30), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timeout|aborted/i);
      assert.equal(error.message.includes("HTTP"), false);
      return true;
    });
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("peer snapshot keeps a timeout when the fallback body is not JSON", async () => {
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/engram/")) {
      return Promise.resolve(
        new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      const fail = () => reject(signal?.reason ?? new Error("aborted"));
      if (!signal) {
        reject(new Error("missing signal"));
        return;
      }
      if (signal.aborted) {
        fail();
        return;
      }
      signal.addEventListener("abort", fail, { once: true });
    });
  };
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  try {
    await assert.rejects(fetchPeerSnapshot("http://peer", "alpha", undefined, fetchImpl, 30), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timeout|aborted/i);
      assert.equal(error.message.includes("not JSON"), false);
      assert.equal(error.message.includes("invalid peer snapshot"), false);
      assert.equal(isPeerTransportCensusFailure(error), true);
      return true;
    });
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("peer snapshot reports invalid JSON when no earlier timeout was recorded", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    fetchPeerSnapshot("http://peer", "alpha", undefined, fetchImpl, 1_000),
    /invalid peer snapshot for namespace alpha: response was not JSON/
  );
});

test("peer snapshot uses a later alias that succeeds after a timeout", async () => {
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/remnic/")) {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const fail = () => reject(signal?.reason ?? new Error("aborted"));
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
    }
    return Promise.resolve(Response.json({ files: [], tombstones: [] }));
  };
  const keepAlive = new MessageChannel();
  keepAlive.port1.ref();
  keepAlive.port2.ref();
  try {
    const snapshot = await fetchPeerSnapshot("http://peer", "alpha", undefined, fetchImpl, 30);
    assert.deepEqual(snapshot.files, []);
  } finally {
    keepAlive.port1.close();
    keepAlive.port2.close();
  }
});

test("peer snapshot body timeout is not rewritten as invalid JSON", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/engram/")) return new Response(null, { status: 404 });
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(fetchPeerSnapshot("http://peer", "alpha", undefined, fetchImpl, 1_000), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("not JSON"), false);
    assert.equal(isPeerTransportCensusFailure(error), true);
    return true;
  });
});

test("peer snapshot fetch threads the abort signal and does not retry the fallback route (#2954)", async () => {
  const controller = new AbortController();
  controller.abort();
  const requestedPaths: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requestedPaths.push(new URL(String(input)).pathname);
    if (!init?.signal?.aborted) throw new Error("expected a pre-aborted request signal");
    throw init.signal.reason;
  };
  await assert.rejects(
    fetchPeerSnapshot("http://peer", "default", undefined, fetchImpl, 5_000, controller.signal),
    (error: unknown) => (error as Error)?.name === "AbortError"
  );
  assert.equal(requestedPaths.length, 1);
  assert.ok(requestedPaths[0]!.includes("/remnic/"));
});

test("peer manifest stream fetch carries the abort signal (#2954)", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestSignal = init?.signal ?? undefined;
    controller.abort();
    throw init?.signal?.reason ?? new Error("aborted");
  };
  await assert.rejects(
    fetchPeerManifestStream("http://peer", "default", undefined, fetchImpl, 5_000, controller.signal),
    (error: unknown) => (error as Error)?.name === "AbortError"
  );
  assert.ok(requestSignal instanceof AbortSignal);
  assert.ok(requestSignal.aborted);
});
