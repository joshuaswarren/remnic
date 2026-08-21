import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { EngramAccessService } from "@remnic/core";
import { checkRegression, loadBaseline, runBenchSuite } from "./benchmark.js";

describe("loadBaseline", () => {
  it("returns undefined only when the baseline file is missing", () => {
    const missingPath = path.join(os.tmpdir(), `missing-baseline-${Date.now()}.json`);
    assert.equal(loadBaseline(missingPath), undefined);
  });

  it("throws for malformed baseline JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-"));
    try {
      const baselinePath = path.join(tempDir, "baseline.json");
      await writeFile(baselinePath, "{", "utf8");

      assert.throws(
        () => loadBaseline(baselinePath),
        /Failed to parse benchmark baseline/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws for invalid baseline shape", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-baseline-shape-"));
    try {
      const baselinePath = path.join(tempDir, "baseline.json");
      await writeFile(baselinePath, JSON.stringify({ version: 1, timestamp: "now", metrics: [] }), "utf8");

      assert.throws(
        () => loadBaseline(baselinePath),
        /Invalid benchmark baseline shape/,
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("runBenchSuite", () => {
  it("does not overwrite malformed baseline files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-suite-baseline-"));
    try {
      await mkdir(path.join(tempDir, "benchmarks"));
      const baselinePath = path.join(tempDir, "benchmarks", "baseline.json");
      const reportPath = path.join(tempDir, "benchmarks", "report.json");
      const originalBaseline = "{";
      await writeFile(baselinePath, originalBaseline, "utf8");

      await assert.rejects(
        () => runBenchSuite(fakeService(), {
          queries: ["missing memory"],
          baselinePath,
          reportPath,
        }),
        /Failed to parse benchmark baseline/,
      );

      assert.equal(await readFile(baselinePath, "utf8"), originalBaseline);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses end-to-end latency for explain-mode suite metrics", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-explain-latency-"));
    try {
      const baselinePath = path.join(tempDir, "baseline.json");
      const reportPath = path.join(tempDir, "report.json");
      let recallCalls = 0;
      const service = {
        recall: async () => {
          recallCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return recallCalls === 1
            ? { results: [{ preview: "unrelated", tags: [] }] }
            : { results: [{ preview: "alpha", tags: [] }] };
        },
      } as unknown as EngramAccessService;

      const result = await runBenchSuite(service, {
        queries: ["alpha beta"],
        baselinePath,
        reportPath,
        explain: true,
      });

      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]?.latencyMs, result.results[0]?.totalDurationMs);
      assert.equal(result.report.queries[0]?.durationMs, result.results[0]?.totalDurationMs);
      assert.deepEqual(result.results[0]?.tiersUsed, ["category_match"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("checkRegression", () => {
  it("fails positive latency regressions against zero baselines", () => {
    const result = checkRegression(
      { "query latency": 3 },
      {
        version: 1,
        timestamp: "2026-05-22T00:00:00.000Z",
        metrics: { "query latency": 0 },
      },
      10,
    );

    assert.equal(result.passed, false);
    assert.equal(result.regressions[0]?.passed, false);
  });

  it("passes zero current values against zero baselines", () => {
    const result = checkRegression(
      { "query latency": 0 },
      {
        version: 1,
        timestamp: "2026-05-22T00:00:00.000Z",
        metrics: { "query latency": 0 },
      },
      10,
    );

    assert.equal(result.passed, true);
    assert.equal(result.regressions[0]?.passed, true);
  });
});

function fakeService(): EngramAccessService {
  return {
    recall: async () => ({ results: [] }),
  } as unknown as EngramAccessService;
}
