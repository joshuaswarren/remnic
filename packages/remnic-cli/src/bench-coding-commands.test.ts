import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  BENCH_CODING_USAGE,
  parseBenchCodingArgs,
  runBenchCodingCommand,
} from "./bench-coding-commands.js";

async function writeH6RunMetadata(directory: string): Promise<void> {
  await writeFile(
    path.join(directory, "run.json"),
    JSON.stringify({
      schemaVersion: 1,
      suiteVersion: "h6-failure-gate-v1-test",
      runId: "h6-test-run",
    }),
    "utf8",
  );
}

test("bench coding help documents the four H6 command forms and frozen task count", () => {
  assert.match(BENCH_CODING_USAGE, /repo-gen \[--count 30\]/);
  assert.match(BENCH_CODING_USAGE, /repo-gen verify-all \[DIR\]/);
  assert.match(BENCH_CODING_USAGE, /repeated-failure --seeds N/);
  assert.match(BENCH_CODING_USAGE, /repeated-failure stats --run DIR/);
  assert.match(BENCH_CODING_USAGE, /exactly 30/);
});

test("repo-gen parser accepts only the frozen 30-task suite", () => {
  assert.deepEqual(
    parseBenchCodingArgs(["repo-gen", "--count", "30", "--seed", "81", "--out", "./fixtures"]),
    {
      kind: "repo-generate",
      count: 30,
      seed: 81,
      outputDir: "./fixtures",
    },
  );

  assert.throws(
    () => parseBenchCodingArgs(["repo-gen", "--count", "29"]),
    /--count must be exactly 30/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repo-gen", "--seed", "4294967296"]),
    /--seed must be an integer between 0 and 4294967295/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repo-gen", "--seed", "82"]),
    /--seed must be exactly 81/,
  );
});

test("repo-gen verify-all rejects ambiguous arguments and unknown flags", () => {
  assert.deepEqual(parseBenchCodingArgs(["repo-gen", "verify-all"]), {
    kind: "repo-verify",
  });
  assert.deepEqual(parseBenchCodingArgs(["repo-gen", "verify-all", "./fixtures"]), {
    kind: "repo-verify",
    directory: "./fixtures",
  });
  assert.throws(
    () => parseBenchCodingArgs(["repo-gen", "verify-all", "./one", "./two"]),
    /accepts at most one directory/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repo-gen", "verify-all", "--json"]),
    /unknown option --json/,
  );
});

test("repeated-failure parser requires immutable profiles and exact registered draws and seeds", () => {
  assert.deepEqual(
    parseBenchCodingArgs([
      "repeated-failure",
      "--seeds",
      "5",
      "--profile",
      "./profiles/model-a.json",
      "--profile",
      "./profiles/model-b.json",
      "--out",
      "./run",
      "--fixture",
      "./fixtures",
      "--draws",
      "10000",
      "--statistics-seed",
      "19",
      "--max-steps",
      "12",
      "--max-tool-calls",
      "8",
      "--max-output-chars",
      "16384",
    ]),
    {
      kind: "repeated-run",
      phase: "pilot",
      seedCount: 5,
      profilePaths: ["./profiles/model-a.json", "./profiles/model-b.json"],
      outputDir: "./run",
      fixtureDir: "./fixtures",
      statisticsDraws: 10000,
      statisticsSeed: 19,
      maxSteps: 12,
      maxToolCalls: 8,
      maxOutputChars: 16384,
    },
  );

  assert.throws(
    () => parseBenchCodingArgs(["repeated-failure", "--seeds", "4", "--profile", "./profile.json"]),
    /--seeds must be an integer between 5 and 5/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repeated-failure", "--seeds", "5"]),
    /exactly two --profile files/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repeated-failure", "--seeds", "5", "--profile"]),
    /missing value for --profile/,
  );

  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--phase",
        "main",
        "--seeds",
        "5",
        "--profile",
        "./profile.json",
      ]),
    /registered repeated-failure runs require exactly two --profile files/,
  );
  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--phase",
        "main",
        "--seeds",
        "5",
        "--profile",
        "./p1.json",
        "--profile",
        "./p2.json",
      ]),
    /--phase main requires --pilot-run DIR/,
  );

  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--phase",
        "pilot",
        "--seeds",
        "5",
        "--profile",
        "./p1.json",
        "--profile",
        "./p2.json",
        "--pilot-run",
        "./pilot-dir",
      ]),
    /--pilot-run is only valid when --phase is main/,
  );

  assert.deepEqual(
    parseBenchCodingArgs([
      "repeated-failure",
      "--phase",
      "main",
      "--seeds",
      "5",
      "--profile",
      "./p1.json",
      "--profile",
      "./p2.json",
      "--pilot-run",
      "./pilot-dir",
    ]),
    {
      kind: "repeated-run",
      phase: "main",
      seedCount: 5,
      profilePaths: ["./p1.json", "./p2.json"],
      outputDir: "./h6-repeated-failure",
      pilotRunDir: "./pilot-dir",
    },
  );
  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        "./profile.json",
        "--memory-dir",
        "./memories",
      ]),
    /unknown option --memory-dir/,
  );
  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        "./profile.json",
        "--draws",
        "9999",
      ]),
    /--draws must be an integer between 10000 and 10000/,
  );
  assert.throws(
    () =>
      parseBenchCodingArgs([
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        "./p1.json",
        "--profile",
        "./p2.json",
        "--max-steps",
        "11",
      ]),
    /--max-steps must be an integer between 12 and 12/,
  );

});

test("repeated-failure stats accepts only --run for offline replay", () => {
  assert.deepEqual(
    parseBenchCodingArgs(["repeated-failure", "stats", "--run", "./run"]),
    {
      kind: "repeated-stats",
      runDir: "./run",
    },
  );
  assert.throws(
    () => parseBenchCodingArgs(["repeated-failure", "stats", "--seeds", "5", "--run", "./run"]),
    /unknown option --seeds/,
  );
  assert.throws(
    () => parseBenchCodingArgs(["repeated-failure", "stats", "--run", "./run", "--draws", "1000"]),
    /unknown option --draws/,
  );
});

test("help and invalid input never load the optional bench package", async () => {
  let loads = 0;
  const loadBenchModule = async () => {
    loads += 1;
    throw new Error("must not load");
  };

  const help = await runBenchCodingCommand(["--help"], { loadBenchModule });
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /Usage: remnic bench coding/);

  const invalid = await runBenchCodingCommand(["repeated-failure", "--seeds", "0"], {
    loadBenchModule,
  });
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.output, /--seeds must be an integer/);
  assert.match(invalid.output, /Usage: remnic bench coding/);
  assert.equal(loads, 0);
});

test("optional bench package failure keeps the install hint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-optional-"));
  try {
    const result = await runBenchCodingCommand(["repo-gen", "--out", path.join(root, "output")], {
      loadBenchModule: async () => {
        throw new Error(
          "The `remnic bench` commands require the optional @remnic/bench package.\n" +
            "Install it alongside the CLI.",
        );
      },
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.output, /optional @remnic\/bench package/);
    assert.match(result.output, /Install it alongside the CLI/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification rejects a file where a directory is required before loading bench", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-cli-"));
  const file = path.join(root, "not-a-directory.json");
  await writeFile(file, "{}", "utf8");
  let loads = 0;
  try {
    const result = await runBenchCodingCommand(["repo-gen", "verify-all", file], {
      loadBenchModule: async () => {
        loads += 1;
        throw new Error("must not load");
      },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /verify-all input must be a directory/);
    assert.equal(loads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output preflight rejects recognizable memory stores before load or write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-memory-root-"));
  const memoryRoot = path.join(root, "memory");
  const sentinel = path.join(memoryRoot, "sentinel.txt");
  const profile = path.join(root, "model-profile.json");
  await mkdir(path.join(memoryRoot, "facts"), { recursive: true });
  await writeFile(path.join(memoryRoot, "profile.md"), "# Profile\n", "utf8");
  await writeFile(sentinel, "unchanged", "utf8");
  await writeFile(profile, "{}", "utf8");
  let loads = 0;
  const loadBenchModule = async () => {
    loads += 1;
    throw new Error("must not load");
  };

  try {
    for (const argv of [
      ["repo-gen", "--out", path.join(memoryRoot, "fixtures")],
      [
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        profile,
        "--profile",
        profile,
        "--out",
        path.join(memoryRoot, "run"),
      ],
    ]) {
      const result = await runBenchCodingCommand(argv, { loadBenchModule });
      assert.equal(result.exitCode, 1);
      assert.match(result.output, /^refusing benchmark output inside a Remnic memory store/);
      assert.doesNotMatch(result.output, new RegExp(memoryRoot));
    }
    assert.equal(loads, 0);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    await assert.rejects(
      readFile(path.join(memoryRoot, "fixtures", "dataset.json"), "utf8"),
      /ENOENT/,
    );
    await assert.rejects(readFile(path.join(memoryRoot, "run", "run.json"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit memory-dir environment roots protect resume targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-memory-env-"));
  const profile = path.join(root, "profile.json");
  const runDir = path.join(root, "memory", "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(profile, "{}", "utf8");
  const previous = process.env.REMNIC_MEMORY_DIR;
  process.env.REMNIC_MEMORY_DIR = path.join(root, "memory");
  let loads = 0;
  try {
    const result = await runBenchCodingCommand(
      [
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        profile,
        "--profile",
        profile,
        "--run",
        runDir,
      ],
      {
        loadBenchModule: async () => {
          loads += 1;
          throw new Error("must not load");
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^refusing benchmark output inside a Remnic memory store/);
    assert.equal(loads, 0);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "REMNIC_MEMORY_DIR");
    else process.env.REMNIC_MEMORY_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("stats rejects a directory without H6 run metadata before loading bench", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-not-run-"));
  await writeFile(path.join(root, "run.json"), "{\"schemaVersion\":1}", "utf8");
  let loads = 0;
  try {
    const result = await runBenchCodingCommand(
      ["repeated-failure", "stats", "--run", root],
      {
        loadBenchModule: async () => {
          loads += 1;
          throw new Error("must not load");
        },
      },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^stats requires existing H6 run metadata/);
    assert.equal(loads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo generation and verification emit exact bounded summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-repo-gen-"));
  const outputDir = path.join(root, "generated");
  const validReport = {
    valid: true,
    issues: [],
    metrics: {
      totalTasks: 30,
      totalVariants: 90,
      maxPairwiseSimilarity: 0.2,
      devTaskCount: 6,
      pilotTaskCount: 6,
      mainTaskCount: 18,
    },
  };
  try {
    const generated = await runBenchCodingCommand(
      ["repo-gen", "--seed", "81", "--out", outputDir],
      {
        loadBenchModule: async () => ({
          generateH6BenchmarkDataset: async () => ({ version: 1 }),
          validateH6Dataset: async () => validReport,
          writeH6FixtureBundle: async (directory: string, dataset: never) => {
            await mkdir(directory, { recursive: true });
            await writeFile(path.join(directory, "dataset.json"), JSON.stringify(dataset), "utf8");
            await writeFile(path.join(directory, "decision-rule.json"), "complete-bundle", "utf8");
            return path.join(directory, "dataset.json");
          },
        }),
      },
    );
    assert.deepEqual(generated, {
      exitCode: 0,
      output: "Generated H6 repo fixtures: 30 tasks, 90 variants, seed 81.",
    });
    assert.equal(
      await readFile(path.join(outputDir, "decision-rule.json"), "utf8"),
      "complete-bundle",
    );

    const verified = await runBenchCodingCommand(["repo-gen", "verify-all", outputDir], {
      loadBenchModule: async () => ({
        validateH6FixtureBundle: async () => validReport,
      }),
    });
    assert.deepEqual(verified, {
      exitCode: 0,
      output: "H6 repo fixtures valid: 30 tasks, 90 variants (dev=6, pilot=6, main=18).",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repo verification returns nonzero with stable issue codes for invalid fixtures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-invalid-"));
  await writeFile(path.join(root, "dataset.json"), "{}", "utf8");
  try {
    const result = await runBenchCodingCommand(["repo-gen", "verify-all", root], {
      loadBenchModule: async () => ({
        validateH6FixtureBundle: async () => ({
          valid: false,
          issues: [
            { code: "INVENTORY_HASH_MISMATCH", message: "private details omitted" },
            { code: "INVALID_SCHEMA", message: "private details omitted" },
          ],
          metrics: {
            totalTasks: 0,
            totalVariants: 0,
            maxPairwiseSimilarity: 1,
            devTaskCount: 0,
            pilotTaskCount: 0,
            mainTaskCount: 0,
          },
        }),
      }),
    });
    assert.deepEqual(result, {
      exitCode: 1,
      output:
        "H6 repo fixtures invalid: 2 issue(s) [INVALID_SCHEMA, INVENTORY_HASH_MISMATCH].",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stats dispatch is model-free", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-stats-"));
  await writeH6RunMetadata(root);
  let liveRunnerCalls = 0;
  try {
    const result = await runBenchCodingCommand(
      ["repeated-failure", "stats", "--run", root],
      {
        loadBenchModule: async () => ({
          replayRepeatedFailureStatistics: async (options: unknown) => {
            assert.deepEqual(options, { runDir: root });
            return {
              exitCode: 0,
              output: "H6 repeated-failure statistics replayed: 30 tasks, 0 invalid rows.",
            };
          },
          runRepeatedFailureCliCommand: async () => {
            liveRunnerCalls += 1;
            throw new Error("stats must not create a driver");
          },
        }),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "H6 repeated-failure statistics replayed: 30 tasks, 0 invalid rows.");
    assert.equal(liveRunnerCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live dispatch passes profile paths to the bench façade without constructing models", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-live-"));
  const firstProfile = path.join(root, "profile-a.json");
  const secondProfile = path.join(root, "profile-b.json");
  await Promise.all([
    writeFile(firstProfile, "{}", "utf8"),
    writeFile(secondProfile, "{}", "utf8"),
  ]);
  try {
    const result = await runBenchCodingCommand(
      [
        "repeated-failure",
        "--seeds",
        "5",
        "--profile",
        firstProfile,
        "--profile",
        secondProfile,
        "--out",
        path.join(root, "run"),
      ],
      {
        loadBenchModule: async () => ({
          runRepeatedFailureCliCommand: async (options: unknown) => {
            assert.deepEqual(options, {
              phase: "pilot",
              seedCount: 5,
              profilePaths: [firstProfile, secondProfile],
              outputDir: path.join(root, "run"),
            });
            return { exitCode: 0, output: "H6 repeated-failure run complete: 300 rows." };
          },
          replayRepeatedFailureStatistics: async () => {
            throw new Error("live run must not replay stats");
          },
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "H6 repeated-failure run complete: 300 rows.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bench coding output redacts the home path and remains bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remnic-h6-output-"));
  await writeH6RunMetadata(root);
  try {
    const result = await runBenchCodingCommand(
      ["repeated-failure", "stats", "--run", root],
      {
        loadBenchModule: async () => ({
          replayRepeatedFailureStatistics: async () => ({
            exitCode: 0,
            output: `${os.homedir()}/private-run\n${"x".repeat(20_000)}`,
          }),
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.doesNotMatch(result.output, new RegExp(os.homedir()));
    assert.match(result.output, /^~\/private-run/);
    assert.match(result.output, /\[output truncated\]$/);
    assert.ok(Buffer.byteLength(result.output, "utf8") <= 16_384);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
