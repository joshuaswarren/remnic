import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchResultsApi,
  createBenchResultsHandler,
  resolveResultsDir,
} from "./vite.config";

test("resolveResultsDir expands exact home-relative bench results paths", () => {
  const home = path.join(path.sep, "tmp", "remnic-home");

  assert.equal(
    resolveResultsDir({ REMNIC_BENCH_RESULTS_DIR: "~/.remnic/bench/results" }, home),
    path.join(home, ".remnic", "bench", "results"),
  );
  assert.equal(
    resolveResultsDir({ REMNIC_BENCH_RESULTS_DIR: "~" }, home),
    home,
  );
});

test("resolveResultsDir preserves relative, absolute, and unsupported tilde-user paths", () => {
  const home = path.join(path.sep, "tmp", "remnic-home");
  const absolute = path.join(path.sep, "tmp", "bench-results");

  assert.equal(
    resolveResultsDir({ REMNIC_BENCH_RESULTS_DIR: "local-results" }, home),
    path.resolve("local-results"),
  );
  assert.equal(
    resolveResultsDir({ REMNIC_BENCH_RESULTS_DIR: absolute }, home),
    absolute,
  );
  assert.equal(
    resolveResultsDir({ REMNIC_BENCH_RESULTS_DIR: "~other/results" }, home),
    path.resolve("~other/results"),
  );
});

test("bench results handler serves JSON for dev and preview middleware", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-vite-"));
  const resultsDir = path.join(tempRoot, "results");
  try {
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, "run.json"),
      JSON.stringify({
        meta: {
          id: "run-1",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
        },
        results: { aggregates: {} },
      }),
      "utf8",
    );

    const handler = createBenchResultsHandler({ REMNIC_BENCH_RESULTS_DIR: resultsDir }, tempRoot);
    const response = await invokeHandler(handler, "GET");

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Type"], "application/json");
    const payload = JSON.parse(response.body) as { summaries?: Array<{ id?: string }> };
    assert.equal(payload.summaries?.[0]?.id, "run-1");

    const plugin = benchResultsApi();
    const devRoutes: string[] = [];
    const previewRoutes: string[] = [];
    plugin.configureServer({
      middlewares: { use: (route) => devRoutes.push(route) },
    });
    plugin.configurePreviewServer({
      middlewares: { use: (route) => previewRoutes.push(route) },
    });
    assert.deepEqual(devRoutes, ["/api/results"]);
    assert.deepEqual(previewRoutes, ["/api/results"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("bench results plugin emits static /api/results asset during build", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ui-static-"));
  const resultsDir = path.join(tempRoot, "results");
  const outDir = path.join(tempRoot, "dist");
  try {
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      path.join(resultsDir, "run.json"),
      JSON.stringify({
        meta: {
          id: "run-static",
          benchmark: "locomo",
          timestamp: "2026-05-21T00:00:00.000Z",
        },
        results: { aggregates: {} },
      }),
      "utf8",
    );

    const previousResultsDir = process.env.REMNIC_BENCH_RESULTS_DIR;
    process.env.REMNIC_BENCH_RESULTS_DIR = resultsDir;
    try {
      const plugin = benchResultsApi();
      await plugin.writeBundle({ dir: outDir });
    } finally {
      if (previousResultsDir === undefined) delete process.env.REMNIC_BENCH_RESULTS_DIR;
      else process.env.REMNIC_BENCH_RESULTS_DIR = previousResultsDir;
    }

    const payload = JSON.parse(await readFile(path.join(outDir, "api", "results"), "utf8")) as {
      summaries?: Array<{ id?: string }>;
    };
    assert.equal(payload.summaries?.[0]?.id, "run-static");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function invokeHandler(
  handler: ReturnType<typeof createBenchResultsHandler>,
  method: string,
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const response = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(body: string) {
      this.body = body;
    },
  };
  await handler({ method }, response);
  return response;
}
