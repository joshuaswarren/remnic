import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("importing @remnic/bench does not generate or materialize H6 fixtures", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "h6-import-side-effect-"));
  const moduleUrl = new URL("../../index.js", import.meta.url).href;
  const childScript = `
    const bench = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write(JSON.stringify({
      hasDefaultDataset: "DEFAULT_H6_BENCHMARK_DATASET" in bench,
      hasLoader: typeof bench.loadCommittedH6BenchmarkDataset === "function",
      hasGenerator: typeof bench.generateH6BenchmarkDataset === "function",
    }));
  `;

  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: sandbox,
          TEMP: sandbox,
          TMP: sandbox,
        },
      },
    );
    const sandboxEntries = await readdir(sandbox);

    assert.deepEqual(
      sandboxEntries.filter((entry) => entry.startsWith("h6-")),
      [],
    );
    assert.deepEqual(JSON.parse(stdout), {
      hasDefaultDataset: false,
      hasLoader: true,
      hasGenerator: true,
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
