import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts", "faiss_index.py");
const pythonBin = process.env.PYTHON_BIN || "python3";

type FaissSidecarCommand = "upsert" | "rebuild" | "search" | "health" | "inspect";

function runSidecar(command: FaissSidecarCommand, payload: object, cwd?: string) {
  const proc = spawnSync(pythonBin, [scriptPath, command], {
    input: JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30_000,
    cwd,
  });

  assert.equal(proc.status, 0, `sidecar exited non-zero: ${proc.stderr || "<no stderr>"}`);
  assert.ok(proc.stdout.trim().length > 0, "sidecar returned empty stdout");

  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    assert.fail(`sidecar returned non-JSON stdout: ${proc.stdout}`);
  }

  return parsed as Record<string, unknown>;
}

function invalidIndexPathPayload(command: FaissSidecarCommand, indexPath: unknown): object {
  const payload: Record<string, unknown> = {
    modelId: "__hash__",
    indexPath,
  };
  if (command === "upsert" || command === "rebuild") {
    payload.chunks = [];
  }
  if (command === "search") {
    payload.query = "sidecar search";
    payload.topK = 1;
  }
  return payload;
}

function hasFaissDeps(): boolean {
  const probe = spawnSync(pythonBin, ["-c", "import faiss, numpy"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return probe.status === 0;
}

function manifestPath(indexPath: string): string {
  return path.join(indexPath, "manifest.json");
}

function metadataPath(indexPath: string): string {
  return path.join(indexPath, "metadata.jsonl");
}

test("faiss sidecar health command returns contract", () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-health-"));
  try {
    const response = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });

    assert.equal(response.ok, true);
    assert.ok(["ok", "degraded", "error"].includes(String(response.status)));
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar rejects malformed indexPath payload values before creating directories", () => {
  for (const command of ["upsert", "rebuild", "search", "health", "inspect"] as const) {
    for (const indexPath of [null, 42, true, ""]) {
      const cwd = mkdtempSync(path.join(tmpdir(), "engram-faiss-invalid-index-path-"));
      try {
        const response = runSidecar(command, invalidIndexPathPayload(command, indexPath), cwd);

        assert.equal(response.ok, false, `${command} should reject ${JSON.stringify(indexPath)}`);
        assert.match(String(response.error), /indexPath is required/);
        assert.deepEqual(readdirSync(cwd), []);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }
});

test("faiss sidecar health explains degraded status on a fresh install", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-health-empty-"));
  try {
    const response = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });

    assert.equal(response.ok, true);
    assert.equal(response.status, "degraded");
    assert.match(String(response.error), /artifacts missing/i);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar upsert/search smoke with hash model", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-smoke-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "OpenClaw memory and FAISS integration",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
        {
          id: "chunk-2",
          sessionKey: "session-1",
          text: "Conversation semantic retrieval with a sidecar",
          startTs: "2026-02-27T00:01:00.000Z",
          endTs: "2026-02-27T00:01:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);
    assert.equal(upsertResponse.upserted, 2);

    const searchResponse = runSidecar("search", {
      modelId: "__hash__",
      indexPath,
      query: "FAISS sidecar",
      topK: 2,
    });

    assert.equal(searchResponse.ok, true);
    assert.ok(Array.isArray(searchResponse.results));
    assert.ok((searchResponse.results as unknown[]).length > 0);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar health reports manifest metadata after successful upsert", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-health-manifest-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "manifest metadata smoke",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);

    const healthResponse = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });

    assert.equal(healthResponse.ok, true);
    assert.equal(healthResponse.status, "ok");
    assert.equal(typeof healthResponse.manifest, "object");
    assert.equal(healthResponse.manifest?.normalizedModelId, "__hash__");
    assert.equal(healthResponse.manifest?.dimension, 128);
    assert.equal(healthResponse.manifest?.chunkCount, 1);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar rebuild and inspect report deterministic metadata", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-rebuild-"));
  try {
    const rebuildResponse = runSidecar("rebuild", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "full rebuild smoke",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
      ],
    });

    assert.equal(rebuildResponse.ok, true);
    assert.equal(rebuildResponse.rebuilt, 1);

    const inspectResponse = runSidecar("inspect", {
      modelId: "__hash__",
      indexPath,
    });

    assert.equal(inspectResponse.ok, true);
    assert.equal(inspectResponse.status, "ok");
    assert.equal(inspectResponse.metadata?.chunkCount, 1);
    assert.equal(inspectResponse.metadata?.hasIndex, true);
    assert.equal(inspectResponse.metadata?.hasMetadata, true);
    assert.equal(inspectResponse.metadata?.hasManifest, true);
    assert.equal(inspectResponse.manifest?.chunkCount, 1);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar rejects stale manifest model mismatches instead of silently reusing the index", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-stale-model-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "stale manifest smoke",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);

    const manifest = JSON.parse(readFileSync(manifestPath(indexPath), "utf-8")) as Record<string, unknown>;
    manifest.normalizedModelId = "sentence-transformers/all-mpnet-base-v2";
    writeFileSync(manifestPath(indexPath), JSON.stringify(manifest), "utf-8");

    const searchResponse = runSidecar("search", {
      modelId: "__hash__",
      indexPath,
      query: "stale",
      topK: 1,
    });

    assert.equal(searchResponse.ok, false);
    assert.match(String(searchResponse.error), /model mismatch/i);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar upsert preserves lastSuccessfulRebuildAt across incremental updates", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-upsert-preserve-"));
  try {
    const rebuildResponse = runSidecar("rebuild", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "baseline rebuild",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
      ],
    });
    assert.equal(rebuildResponse.ok, true);

    const originalManifest = JSON.parse(readFileSync(manifestPath(indexPath), "utf-8")) as Record<string, unknown>;
    const originalRebuildAt = String(originalManifest.lastSuccessfulRebuildAt);
    assert.ok(originalRebuildAt.length > 0);

    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-2",
          sessionKey: "session-1",
          text: "incremental upsert",
          startTs: "2026-02-27T00:01:00.000Z",
          endTs: "2026-02-27T00:01:05.000Z",
        },
      ],
    });
    assert.equal(upsertResponse.ok, true);

    const updatedManifest = JSON.parse(readFileSync(manifestPath(indexPath), "utf-8")) as Record<string, unknown>;
    assert.equal(updatedManifest.lastSuccessfulRebuildAt, originalRebuildAt);
    assert.notEqual(updatedManifest.updatedAt, "");
    assert.equal(updatedManifest.chunkCount, 2);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar rejects manifest dimension mismatches instead of silently reusing the index", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-stale-dim-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "dimension mismatch smoke",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);

    const manifest = JSON.parse(readFileSync(manifestPath(indexPath), "utf-8")) as Record<string, unknown>;
    manifest.dimension = 64;
    writeFileSync(manifestPath(indexPath), JSON.stringify(manifest), "utf-8");

    const healthResponse = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });
    assert.equal(healthResponse.ok, true);
    assert.equal(healthResponse.status, "degraded");
    assert.match(String(healthResponse.error), /dimension mismatch/i);

    const searchResponse = runSidecar("search", {
      modelId: "__hash__",
      indexPath,
      query: "dimension",
      topK: 1,
    });

    assert.equal(searchResponse.ok, false);
    assert.match(String(searchResponse.error), /dimension mismatch/i);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});

test("faiss sidecar rejects mismatched index artifact counts", { skip: !hasFaissDeps() }, () => {
  const indexPath = mkdtempSync(path.join(tmpdir(), "engram-faiss-stale-counts-"));
  try {
    const upsertResponse = runSidecar("upsert", {
      modelId: "__hash__",
      indexPath,
      chunks: [
        {
          id: "chunk-1",
          sessionKey: "session-1",
          text: "count mismatch first chunk",
          startTs: "2026-02-27T00:00:00.000Z",
          endTs: "2026-02-27T00:00:05.000Z",
        },
        {
          id: "chunk-2",
          sessionKey: "session-1",
          text: "count mismatch second chunk",
          startTs: "2026-02-27T00:01:00.000Z",
          endTs: "2026-02-27T00:01:05.000Z",
        },
      ],
    });

    assert.equal(upsertResponse.ok, true);

    const metadataLines = readFileSync(metadataPath(indexPath), "utf-8").trim().split(/\r?\n/);
    writeFileSync(metadataPath(indexPath), `${metadataLines[0]}\n`, "utf-8");

    const healthResponse = runSidecar("health", {
      modelId: "__hash__",
      indexPath,
    });
    assert.equal(healthResponse.ok, true);
    assert.equal(healthResponse.status, "degraded");
    assert.match(String(healthResponse.error), /artifact count mismatch/i);

    const searchResponse = runSidecar("search", {
      modelId: "__hash__",
      indexPath,
      query: "count mismatch",
      topK: 2,
    });

    assert.equal(searchResponse.ok, false);
    assert.match(String(searchResponse.error), /artifact count mismatch/i);
  } finally {
    rmSync(indexPath, { recursive: true, force: true });
  }
});
