import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildBenchmarkReproManifest } from "./repro-manifest.js";

test("repro manifest orders non-ASCII fixture names by codepoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "repro-codepoint-order-"));
  const resultsDir = path.join(root, "results");
  const datasetDir = path.join(root, "dataset");
  try {
    await mkdir(resultsDir, { recursive: true });
    await mkdir(datasetDir, { recursive: true });
    await writeFile(path.join(datasetDir, "ä-fixture.json"), "{}\n", "utf8");
    await writeFile(path.join(datasetDir, "z-fixture.json"), "{}\n", "utf8");
    const originalLocaleCompare = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not participate in deterministic repro manifests");
    };
    try {

      const manifest = await buildBenchmarkReproManifest(resultsDir, {
        resultPaths: [],
        selectedBenchmarks: ["h6-non-ascii"],
        datasetDirs: { "h6-non-ascii": datasetDir },
        command: { cwd: root, argv: ["bench", "run"] },
      });

      assert.deepEqual(
        manifest.datasets[0]?.files.map((file) => file.path),
        ["z-fixture.json", "ä-fixture.json"],
      );
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
