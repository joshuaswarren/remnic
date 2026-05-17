import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type * as childProcess from "node:child_process";
import {
  FaissAdapterError,
  FaissConversationIndexAdapter,
  resolveDefaultFaissScriptPath,
  type FaissAdapterConfig,
} from "../src/conversation-index/faiss-adapter.js";
import { upsertConversationChunksFailOpen } from "../src/conversation-index/indexer.js";
import { searchConversationIndexFaissFailOpen } from "../src/conversation-index/search.js";
import type { ConversationChunk } from "../src/conversation-index/chunker.js";

class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];

  write(chunk: string) {
    this.writes.push(chunk);
    return true;
  }

  end() {}
}

class FakeProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin();
  killSignal: string | null = null;

  kill(signal: string) {
    this.killSignal = signal;
    this.emit("close", null, signal);
    return true;
  }
}

function baseConfig(spawnFn?: typeof childProcess.spawn): FaissAdapterConfig {
  return {
    memoryDir: "/tmp/memory",
    scriptPath: "/tmp/faiss_index.py",
    pythonBin: "python3.11",
    modelId: "text-embedding-3-small",
    indexDir: "state/conversation-index/faiss",
    upsertTimeoutMs: 500,
    searchTimeoutMs: 500,
    healthTimeoutMs: 500,
    maxBatchSize: 10,
    maxSearchK: 10,
    spawnFn,
  };
}

function sampleChunks(count: number = 1): ConversationChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `chunk-${index + 1}`,
    sessionKey: "session-A",
    startTs: "2026-02-27T00:00:00.000Z",
    endTs: "2026-02-27T00:01:00.000Z",
    text: `hello world ${index + 1}`,
  }));
}

function resolvePythonBin(): string | undefined {
  for (const candidate of ["python3", "python"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

test("resolveDefaultFaissScriptPath handles src and dist module locations", () => {
  const rootSrcUrl = pathToFileURL("/tmp/repo/src/conversation-index/faiss-adapter.ts").toString();
  const packageSrcUrl = pathToFileURL(
    "/tmp/repo/packages/remnic-core/src/conversation-index/faiss-adapter.ts",
  ).toString();
  const distUrl = pathToFileURL("/tmp/repo/packages/remnic-core/dist/index.js").toString();
  const pluginDistUrl = pathToFileURL("/tmp/repo/packages/plugin-openclaw/dist/index.js").toString();

  assert.equal(resolveDefaultFaissScriptPath(rootSrcUrl), path.resolve("/tmp/repo/scripts/faiss_index.py"));
  assert.equal(
    resolveDefaultFaissScriptPath(packageSrcUrl),
    path.resolve("/tmp/repo/packages/remnic-core/scripts/faiss_index.py"),
  );
  assert.equal(
    resolveDefaultFaissScriptPath(distUrl),
    path.resolve("/tmp/repo/packages/remnic-core/scripts/faiss_index.py"),
  );
  assert.equal(
    resolveDefaultFaissScriptPath(pluginDistUrl),
    path.resolve("/tmp/repo/packages/plugin-openclaw/scripts/faiss_index.py"),
  );
});

test("@remnic/core package ships the default FAISS sidecar", () => {
  const packageJson = JSON.parse(readFileSync("packages/remnic-core/package.json", "utf-8")) as {
    files?: string[];
  };
  const rootSidecar = readFileSync("scripts/faiss_index.py", "utf-8");
  const packagedSidecar = readFileSync("packages/remnic-core/scripts/faiss_index.py", "utf-8");

  assert.ok(packageJson.files?.includes("scripts/faiss_index.py"));
  assert.ok(packageJson.files?.includes("scripts/faiss_requirements.txt"));
  assert.ok(existsSync("packages/remnic-core/scripts/faiss_index.py"));
  assert.ok(existsSync("packages/remnic-core/scripts/faiss_requirements.txt"));
  assert.equal(packagedSidecar, rootSidecar);
  assert.match(packagedSidecar, /"REMNIC_FAISS_ENABLE_ST" in os\.environ/);
  assert.ok(
    packagedSidecar.indexOf('"REMNIC_FAISS_ENABLE_ST"') <
      packagedSidecar.indexOf('"ENGRAM_FAISS_ENABLE_ST"'),
  );
});

test("@remnic/plugin-openclaw package ships the default FAISS sidecar", () => {
  const packageJson = JSON.parse(readFileSync("packages/plugin-openclaw/package.json", "utf-8")) as {
    files?: string[];
  };
  const rootSidecar = readFileSync("scripts/faiss_index.py", "utf-8");
  const packagedSidecar = readFileSync("packages/plugin-openclaw/scripts/faiss_index.py", "utf-8");

  assert.ok(packageJson.files?.includes("scripts/faiss_index.py"));
  assert.ok(packageJson.files?.includes("scripts/faiss_requirements.txt"));
  assert.ok(existsSync("packages/plugin-openclaw/scripts/faiss_index.py"));
  assert.ok(existsSync("packages/plugin-openclaw/scripts/faiss_requirements.txt"));
  assert.equal(packagedSidecar, rootSidecar);
  assert.match(packagedSidecar, /"REMNIC_FAISS_ENABLE_ST" in os\.environ/);
  assert.ok(
    packagedSidecar.indexOf('"REMNIC_FAISS_ENABLE_ST"') <
      packagedSidecar.indexOf('"ENGRAM_FAISS_ENABLE_ST"'),
  );
});

test("FAISS sidecar treats an explicitly empty REMNIC sentence-transformer flag as disabled", {
  skip: resolvePythonBin() === undefined,
}, () => {
  const pythonBin = resolvePythonBin();
  assert.ok(pythonBin);
  const modulePath = path.resolve("packages/remnic-core/scripts/faiss_index.py");
  const script = [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("faiss_index", ${JSON.stringify(modulePath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    'print(json.dumps([module.sentence_transformers_enabled(), module.normalize_model_id("text-embedding-3-small")], separators=(",", ":")))',
  ].join("\n");

  const result = spawnSync(pythonBin, ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      REMNIC_FAISS_ENABLE_ST: "",
      ENGRAM_FAISS_ENABLE_ST: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [false, "__hash__"]);
});

test("FAISS sidecar merge_rows keeps same chunk ids from different sessions", { skip: resolvePythonBin() === undefined }, () => {
  const pythonBin = resolvePythonBin();
  assert.ok(pythonBin);
  const modulePath = path.resolve("packages/remnic-core/scripts/faiss_index.py");
  const script = [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("faiss_index", ${JSON.stringify(modulePath)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "existing = [{'id':'same-start-0','sessionKey':'session-A','text':'old','startTs':'2026-02-27T00:00:00.000Z','endTs':'2026-02-27T00:01:00.000Z'}]",
    "updates = [{'id':'same-start-0','sessionKey':'session-B','text':'new','startTs':'2026-02-27T00:00:00.000Z','endTs':'2026-02-27T00:01:00.000Z'}]",
    "print(json.dumps(module.merge_rows(existing, updates), separators=(',', ':')))",
  ].join("\n");

  const result = spawnSync(pythonBin, ["-c", script], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);

  const rows = JSON.parse(result.stdout) as Array<{ sessionKey: string; text: string }>;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.sessionKey), ["session-A", "session-B"]);
  assert.deepEqual(rows.map((row) => row.text), ["old", "new"]);
});

test("faiss adapter upsertChunks success path parses JSON output", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, upserted: 1 }));
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const upserted = await adapter.upsertChunks(sampleChunks());
  assert.equal(upserted, 1);

  const payload = JSON.parse(proc.stdin.writes.join(""));
  assert.equal(payload.modelId, "text-embedding-3-small");
  assert.equal(payload.chunks.length, 1);
});

test("faiss adapter short-circuits upsert when maxBatchSize is zero", async () => {
  let spawnCalls = 0;
  const spawnFn: typeof childProcess.spawn = () => {
    spawnCalls += 1;
    return new FakeProcess() as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    maxBatchSize: 0,
  });

  const upserted = await adapter.upsertChunks(sampleChunks());
  assert.equal(upserted, 0);
  assert.equal(spawnCalls, 0);
});

test("faiss adapter upserts all chunks by batching across maxBatchSize", async () => {
  const stdinWrites: string[] = [];
  let spawnCalls = 0;
  const spawnFn: typeof childProcess.spawn = () => {
    spawnCalls += 1;
    const proc = new FakeProcess();
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: string) => {
      stdinWrites.push(chunk);
      return originalWrite(chunk);
    };

    process.nextTick(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, upserted: 2 }));
      proc.emit("close", 0);
    });

    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    maxBatchSize: 2,
  });

  const upserted = await adapter.upsertChunks(sampleChunks(4));
  assert.equal(upserted, 4);
  assert.equal(spawnCalls, 2);

  const payloads = stdinWrites.map((chunk) => JSON.parse(chunk));
  assert.equal(payloads[0].chunks.length, 2);
  assert.equal(payloads[1].chunks.length, 2);
});

test("faiss adapter searchChunks returns typed results", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit(
        "data",
        JSON.stringify({
          ok: true,
          results: [{ path: "/a.md", snippet: "hi", score: 0.9 }],
        }),
      );
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const results = await adapter.searchChunks("query", 3);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, "/a.md");
  assert.equal(results[0]?.score, 0.9);
});

test("faiss adapter searchChunks short-circuits NaN topK", async () => {
  let spawnCalls = 0;
  const spawnFn: typeof childProcess.spawn = () => {
    spawnCalls += 1;
    return new FakeProcess() as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const results = await adapter.searchChunks("query", Number.NaN);
  assert.deepEqual(results, []);
  assert.equal(spawnCalls, 0);
});

test("faiss adapter throws timeout error and kills process", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => proc as unknown as childProcess.ChildProcess;

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    healthTimeoutMs: 10,
  });

  await assert.rejects(async () => {
    await adapter.health();
  }, (err: unknown) => {
    assert.ok(err instanceof FaissAdapterError);
    assert.equal(err.code, "timeout");
    return true;
  });
  assert.equal(proc.killSignal, "SIGKILL");
});

test("faiss adapter honors zero timeout as no timeout", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    setTimeout(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, status: "ok" }));
      proc.emit("close", 0);
    }, 20);
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    healthTimeoutMs: 0,
  });

  const health = await adapter.health();
  assert.equal(health.status, "ok");
});

test("faiss adapter health preserves manifest metadata for diagnostics", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit(
        "data",
        JSON.stringify({
          ok: true,
          status: "ok",
          manifest: {
            version: 1,
            modelId: "text-embedding-3-small",
            normalizedModelId: "__hash__",
            dimension: 128,
            chunkCount: 3,
            updatedAt: "2026-03-09T14:30:00Z",
            lastSuccessfulRebuildAt: "2026-03-09T14:30:00Z",
          },
        }),
      );
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const health = await adapter.health();
  assert.equal(health.manifest?.version, 1);
  assert.equal(health.manifest?.dimension, 128);
  assert.equal(health.manifest?.chunkCount, 3);
  assert.equal(health.manifest?.normalizedModelId, "__hash__");
});

test("faiss adapter inspect reports artifact metadata", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit(
        "data",
        JSON.stringify({
          ok: true,
          status: "degraded",
          error: "missing manifest",
          manifest: {
            version: 1,
            modelId: "text-embedding-3-small",
            normalizedModelId: "__hash__",
            dimension: 128,
            chunkCount: 2,
            updatedAt: "2026-03-09T14:30:00Z",
            lastSuccessfulRebuildAt: "2026-03-09T14:30:00Z",
          },
          metadata: {
            chunkCount: 2,
            hasIndex: true,
            hasMetadata: true,
            hasManifest: false,
          },
        }),
      );
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const inspection = await adapter.inspect();
  assert.equal(inspection.status, "degraded");
  assert.equal(inspection.metadata.chunkCount, 2);
  assert.equal(inspection.metadata.hasIndex, true);
  assert.equal(inspection.metadata.hasManifest, false);
  assert.equal(inspection.manifest?.dimension, 128);
});

test("faiss adapter rebuildChunks parses rebuild count", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, rebuilt: 3 }));
      proc.emit("close", 0);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  const rebuilt = await adapter.rebuildChunks(sampleChunks(3));
  assert.equal(rebuilt, 3);
});

test("faiss adapter rebuildChunks batches rebuild payloads via rebuild then incremental upserts", async () => {
  const stdinWrites: string[] = [];
  const commands: string[] = [];
  const spawnFn: typeof childProcess.spawn = (_bin, args) => {
    commands.push(String(args?.[1] ?? ""));
    const proc = new FakeProcess();
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: string) => {
      stdinWrites.push(chunk);
      return originalWrite(chunk);
    };

    process.nextTick(() => {
      const command = String(args?.[1] ?? "");
      proc.stdout.emit("data", JSON.stringify(command === "rebuild" ? { ok: true, rebuilt: 2 } : { ok: true, upserted: 2 }));
      proc.emit("close", 0);
    });

    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    maxBatchSize: 2,
  });

  const rebuilt = await adapter.rebuildChunks(sampleChunks(4));
  assert.equal(rebuilt, 4);
  assert.deepEqual(commands, ["rebuild", "upsert"]);

  const payloads = stdinWrites.map((chunk) => JSON.parse(chunk));
  assert.equal(payloads[0].chunks.length, 2);
  assert.equal(payloads[1].chunks.length, 2);
});

test("faiss adapter rebuildChunks still calls rebuild for empty chunk sets", async () => {
  const stdinWrites: string[] = [];
  const commands: string[] = [];
  const spawnFn: typeof childProcess.spawn = (_bin, args) => {
    commands.push(String(args?.[1] ?? ""));
    const proc = new FakeProcess();
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: string) => {
      stdinWrites.push(chunk);
      return originalWrite(chunk);
    };

    process.nextTick(() => {
      proc.stdout.emit("data", JSON.stringify({ ok: true, rebuilt: 0 }));
      proc.emit("close", 0);
    });

    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter({
    ...baseConfig(spawnFn),
    maxBatchSize: 2,
  });

  const rebuilt = await adapter.rebuildChunks([]);
  assert.equal(rebuilt, 0);
  assert.deepEqual(commands, ["rebuild"]);

  const payload = JSON.parse(stdinWrites[0] ?? "");
  assert.deepEqual(payload.chunks, []);
});

test("faiss adapter throws non-zero exit with stderr context", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stderr.emit("data", "boom");
      proc.emit("close", 7);
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  const adapter = new FaissConversationIndexAdapter(baseConfig(spawnFn));
  await assert.rejects(async () => {
    await adapter.health();
  }, (err: unknown) => {
    assert.ok(err instanceof FaissAdapterError);
    assert.equal(err.code, "non_zero_exit");
    assert.match(err.message, /boom/);
    return true;
  });
});

test("faiss adapter throws malformed output for invalid or empty payloads", async () => {
  const invalid = new FakeProcess();
  const invalidSpawn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      invalid.stdout.emit("data", "not-json");
      invalid.emit("close", 0);
    });
    return invalid as unknown as childProcess.ChildProcess;
  };

  const empty = new FakeProcess();
  const emptySpawn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      empty.emit("close", 0);
    });
    return empty as unknown as childProcess.ChildProcess;
  };

  const malformedSuccess = new FakeProcess();
  const malformedSuccessSpawn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      malformedSuccess.stdout.emit("data", JSON.stringify({}));
      malformedSuccess.emit("close", 0);
    });
    return malformedSuccess as unknown as childProcess.ChildProcess;
  };

  await assert.rejects(
    () => new FaissConversationIndexAdapter(baseConfig(invalidSpawn)).health(),
    (err: unknown) => err instanceof FaissAdapterError && err.code === "malformed_output",
  );

  await assert.rejects(
    () => new FaissConversationIndexAdapter(baseConfig(emptySpawn)).health(),
    (err: unknown) => err instanceof FaissAdapterError && err.code === "malformed_output",
  );

  await assert.rejects(
    () => new FaissConversationIndexAdapter(baseConfig(malformedSuccessSpawn)).health(),
    (err: unknown) => err instanceof FaissAdapterError && err.code === "malformed_output",
  );
});

test("faiss adapter converts stdin stream errors into adapter failures", async () => {
  const proc = new FakeProcess();
  const spawnFn: typeof childProcess.spawn = () => {
    process.nextTick(() => {
      proc.stdin.emit("error", new Error("EPIPE"));
    });
    return proc as unknown as childProcess.ChildProcess;
  };

  await assert.rejects(
    () => new FaissConversationIndexAdapter(baseConfig(spawnFn)).health(),
    (err: unknown) => {
      assert.ok(err instanceof FaissAdapterError);
      assert.equal(err.code, "non_zero_exit");
      assert.match(err.message, /EPIPE/);
      return true;
    },
  );
});

test("fail-open wrappers return safe defaults on adapter errors", async () => {
  const throwingAdapter = {
    async upsertChunks() {
      throw new Error("upsert broke");
    },
    async searchChunks() {
      throw new Error("search broke");
    },
  } as unknown as FaissConversationIndexAdapter;

  const upsertResult = await upsertConversationChunksFailOpen(throwingAdapter, sampleChunks());
  assert.equal(upsertResult.skipped, true);
  assert.equal(upsertResult.reason, "adapter-error");

  const searchResults = await searchConversationIndexFaissFailOpen(throwingAdapter, "query", 3);
  assert.deepEqual(searchResults, []);

  const unavailable = await upsertConversationChunksFailOpen(undefined, sampleChunks());
  assert.equal(unavailable.reason, "adapter-unavailable");
});
