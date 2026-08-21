import assert from "node:assert/strict";
import test from "node:test";
import { parsePeerManifestStream } from "./converge-peer-manifest.js";
import { fetchPeerManifestStream } from "./converge-peer-transport.js";

function streamedResponse(lines: string[], splitAt: number): Response {
  const encoded = new TextEncoder().encode(`${lines.join("\n")}\n`);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoded.slice(0, splitAt));
      controller.enqueue(encoded.slice(splitAt));
      controller.close();
    },
  }), { headers: { "content-type": "application/x-ndjson" } });
}

test("peer manifest parser preserves separate file and content hashes across streamed chunks", async () => {
  const fileSha = "a".repeat(64);
  const contentHash = "b".repeat(64);
  const response = streamedResponse([
    JSON.stringify({
      type: "manifest",
      namespace: "team",
      format: "remnic-reconcile-manifest",
      schemaVersion: 1,
    }),
    JSON.stringify({
      type: "file",
      file: {
        path: "facts/a.md",
        sha256: fileSha,
        bytes: 123,
        mtimeMs: 456,
        memory: {
          id: "fact-a",
          category: "fact",
          status: "active",
          contentHash,
        },
      },
    }),
    JSON.stringify({
      type: "file",
      file: {
        path: ".remnic\\state\\converge-cursors\\private.json",
        sha256: "c".repeat(64),
      },
    }),
  ], 37);

  const manifest = await parsePeerManifestStream(response, "team");

  assert.equal(manifest.files[0]?.sha256, fileSha);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0]?.memory?.contentHash, contentHash);
  assert.notEqual(manifest.files[0]?.sha256, manifest.files[0]?.memory?.contentHash);
  assert.equal(JSON.stringify(manifest).includes("memory body"), false);
});

test("peer manifest parser rejects malformed headers and raw body fields", async () => {
  await assert.rejects(
    parsePeerManifestStream(streamedResponse([
      JSON.stringify({ type: "manifest", namespace: "other", format: "remnic-reconcile-manifest", schemaVersion: 1 }),
    ], 10), "team"),
    /malformed header/,
  );
  await assert.rejects(
    parsePeerManifestStream(streamedResponse([
      JSON.stringify({ type: "manifest", namespace: "team", format: "remnic-reconcile-manifest", schemaVersion: 1 }),
      JSON.stringify({
        type: "file",
        file: { path: "facts/a.md", sha256: "a".repeat(64), content: "memory body" },
      }),
    ], 10), "team"),
    /raw body/,
  );
});

test("peer manifest transport falls back only when both route aliases are unsupported", async () => {
  let calls = 0;
  const unsupported: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: calls === 1 ? 404 : 405 });
  };
  assert.equal(
    await fetchPeerManifestStream("https://peer.example.test", "team", undefined, unsupported),
    null,
  );
  assert.equal(calls, 2);

  for (const status of [401, 500]) {
    let attempts = 0;
    await assert.rejects(
      fetchPeerManifestStream(
        "https://peer.example.test",
        "team",
        undefined,
        async () => {
          attempts += 1;
          return new Response(null, { status });
        },
      ),
      /peer manifest/,
    );
    assert.equal(attempts, 1);
  }

  let malformedAttempts = 0;
  await assert.rejects(
    fetchPeerManifestStream(
      "https://peer.example.test",
      "team",
      undefined,
      async () => {
        malformedAttempts += 1;
        return new Response("not json\n");
      },
    ),
    /row was not JSON/,
  );
  assert.equal(malformedAttempts, 1);

  let timeoutAttempts = 0;
  await assert.rejects(
    fetchPeerManifestStream(
      "https://peer.example.test",
      "team",
      undefined,
      async () => {
        timeoutAttempts += 1;
        throw new Error("request timed out");
      },
    ),
    /request timed out/,
  );
  assert.equal(timeoutAttempts, 1);
});
