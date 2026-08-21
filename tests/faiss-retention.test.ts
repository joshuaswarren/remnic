import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { createConversationIndexBackend } from "../packages/remnic-core/src/conversation-index/backend.js";
import type { ConversationChunk } from "../packages/remnic-core/src/conversation-index/chunker.js";

function chunk(overrides: Partial<ConversationChunk> = {}): ConversationChunk {
  return {
    id: "chunk-1",
    sessionKey: "session-1",
    text: "new retained text",
    startTs: "2026-05-20T00:00:00.000Z",
    endTs: "2026-05-20T00:01:00.000Z",
    ...overrides,
  };
}

test("FAISS backend update forwards retention cutoff to upsert", async () => {
  let capturedCutoff: number | undefined;
  const backend = createConversationIndexBackend({
    enabled: true,
    backend: "faiss",
    collectionDir: "/unused",
    faiss: {
      async upsertChunks(_chunks: ConversationChunk[], options?: { retentionCutoffMs?: number }) {
        capturedCutoff = options?.retentionCutoffMs;
        return 1;
      },
      async searchChunks() {
        return [];
      },
      async rebuildChunks() {
        return 0;
      },
      async health() {
        return { ok: true, status: "ok", indexPath: "/unused" };
      },
      async inspect() {
        return {
          ok: true,
          status: "ok",
          indexPath: "/unused",
          metadata: {
            chunkCount: 0,
            hasIndex: false,
            hasMetadata: false,
            hasManifest: false,
          },
        };
      },
    } as any,
  });

  await backend?.update([chunk()], {
    embed: false,
    retentionCutoffMs: 1778371200000,
  });

  assert.equal(capturedCutoff, 1778371200000);
});

test("FAISS sidecar prunes metadata rows older than retention cutoff", () => {
  const cutoffMs = Date.parse("2026-05-10T12:00:00.000Z");
  for (const scriptPath of faissScriptPaths()) {
    const script = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("faiss_index", ${JSON.stringify(scriptPath)})`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "rows = [",
      '  {"id":"old","sessionKey":"s1","text":"old","startTs":"2026-05-01T10:00:00.000Z","endTs":"2026-05-01T10:01:00.000Z"},',
      '  {"id":"new","sessionKey":"s1","text":"new","startTs":"2026-05-20T10:00:00.000Z","endTs":"2026-05-20T10:01:00.000Z"}',
      "]",
      `print(json.dumps(module.prune_metadata_rows(rows, ${cutoffMs})))`,
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${scriptPath}: ${result.stderr}`);
    const rows = JSON.parse(result.stdout) as Array<{ id: string }>;
    assert.deepEqual(rows.map((row) => row.id), ["new"]);
  }
});

test("FAISS sidecar result paths include session identity for duplicate chunk ids", () => {
  for (const scriptPath of faissScriptPaths()) {
    const script = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location("faiss_index", ${JSON.stringify(scriptPath)})`,
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "rows = [",
      '  {"id":"2026-05-20T00-00-00-000Z-0","sessionKey":"session-a","text":"a"},',
      '  {"id":"2026-05-20T00-00-00-000Z-0","sessionKey":"session-b","text":"b"}',
      "]",
      "print(json.dumps([module.metadata_result_path(row) for row in rows]))",
    ].join("\n");
    const result = spawnSync("python3", ["-c", script], {
      cwd: path.resolve("."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `${scriptPath}: ${result.stderr}`);
    const paths = JSON.parse(result.stdout) as string[];
    assert.deepEqual(paths, [
      "session-a/2026-05-20T00-00-00-000Z-0",
      "session-b/2026-05-20T00-00-00-000Z-0",
    ]);
    assert.equal(new Set(paths).size, 2);
  }
});

function faissScriptPaths(): string[] {
  return [
    path.resolve("packages/remnic-core/scripts/faiss_index.py"),
    path.resolve("scripts/faiss_index.py"),
  ];
}
