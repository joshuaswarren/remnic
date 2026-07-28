import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createBenchWorkItems,
  deriveRuntimeProfilesFromBenchWorkItems,
  filterBenchWorkItemsForPreviousStatus,
  parseBenchArgs,
} from "./bench-args.js";

test("parseBenchArgs accepts the packaged MCP demo path", () => {
  const parsed = parseBenchArgs(["run", "longmemeval", "--quick", "--adapter", "mcp", "--mcp-demo"]);
  assert.equal(parsed.adapter, "mcp");
  assert.equal(parsed.mcpDemo, true);
});

test("parseBenchArgs accepts stdio MCP config and explicit tool mapping", () => {
  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--adapter",
    "mcp",
    "--mcp-command",
    "node",
    "--mcp-args",
    '["server.js","--stdio"]',
    "--mcp-tool-map",
    '{"store":"remember","recall":"find","correct":"revise","reset":"forget"}',
  ]);
  assert.deepEqual(parsed.mcpArgs, ["server.js", "--stdio"]);
  assert.equal(parsed.mcpToolMap?.store, "remember");
});

test("parseBenchArgs rejects ambiguous or unscoped MCP config", () => {
  assert.throws(() => parseBenchArgs(["run", "longmemeval", "--mcp-demo"]), /MCP options require --adapter mcp/);
  assert.throws(
    () =>
      parseBenchArgs(["run", "longmemeval", "--adapter", "mcp", "--mcp-demo", "--mcp-url", "https://example.test/mcp"]),
    /requires exactly one/
  );
});

test("parseBenchArgs rejects malformed MCP tool mappings completely", () => {
  const invalidMappings = [
    [{ surprise: "tool" }, /unknown operation surprise/],
    [{ store: 42 }, /store must be a tool-name string or mapping object/],
    [{ store: { name: "remember", extra: true } }, /unknown field extra/],
    [{ store: { name: "remember", arguments: { global: "all" } } }, /unknown semantic global/],
    [{ store: { name: "remember", arguments: { sessionId: 7 } } }, /sessionId must be a non-empty string/],
    [{ recall: { name: "find", resultPath: "__proto__.hits" } }, /safe dot path/],
  ] as const;
  for (const [mapping, expected] of invalidMappings) {
    assert.throws(
      () =>
        parseBenchArgs([
          "run",
          "longmemeval",
          "--adapter",
          "mcp",
          "--mcp-demo",
          "--mcp-tool-map",
          JSON.stringify(mapping),
        ]),
      expected
    );
  }
});

test("parseBenchArgs keeps validated matrix profiles typed and ordered", () => {
  const parsed = parseBenchArgs(["run", "assistant-morning-brief", "--matrix", "baseline,real,openclaw-chain"]);

  assert.deepEqual(parsed.matrixProfiles, ["baseline", "real", "openclaw-chain"]);
});

test("parseBenchArgs rejects unknown bench flags", () => {
  assert.throws(() => parseBenchArgs(["run", "locomo", "--jsoon"]), /unknown bench option --jsoon/);
});

test("parseBenchArgs rejects action-incompatible bench flags", () => {
  assert.throws(() => parseBenchArgs(["run", "locomo", "--dry-run"]), /--dry-run is not supported for bench run/);
  assert.throws(() => parseBenchArgs(["run", "locomo", "--format", "json"]), /--format is not supported for bench run/);
});

test("parseBenchArgs treats action help flags as help requests", () => {
  assert.equal(parseBenchArgs(["run", "--help"]).action, "help");
  assert.equal(parseBenchArgs(["datasets", "--help"]).action, "help");
});

test("parseBenchArgs rejects empty legacy benchmark equals paths", () => {
  assert.throws(() => parseBenchArgs(["check", "--baseline="]), /--baseline requires a value/);
  assert.throws(() => parseBenchArgs(["report", "--report=   "]), /--report requires a value/);
});

test("parseBenchArgs accepts non-empty legacy benchmark equals paths", () => {
  assert.equal(parseBenchArgs(["check", "--baseline=/tmp/baseline.json"]).action, "check");
  assert.equal(parseBenchArgs(["report", "--report=/tmp/report.json"]).action, "report");
});

test("parseBenchArgs recognizes bench attribute action and requires --run", () => {
  assert.throws(() => parseBenchArgs(["attribute"]), /attribute requires --run/);
  const parsed = parseBenchArgs(["attribute", "--run", "run-123", "--threshold", "0.2"]);
  assert.equal(parsed.action, "attribute");
  assert.equal(parsed.runRef, "run-123");
  assert.equal(parsed.threshold, 0.2);
});

test("parseBenchArgs recognizes bench drift-gen action and subcommands", () => {
  const genDefault = parseBenchArgs([
    "drift-gen",
    "--users", "5",
    "--epochs", "3",
    "--seed", "17",
    "--out", "/tmp/drift-out",
  ]);
  assert.equal(genDefault.action, "drift-gen");
  assert.equal(genDefault.driftGenAction, "generate");
  assert.equal(genDefault.users, 5);
  assert.equal(genDefault.epochs, 3);
  assert.equal(genDefault.seed, 17);
  assert.equal(genDefault.out, path.resolve("/tmp/drift-out"));

  const genExplicit = parseBenchArgs(["drift-gen", "generate", "--facts-per-epoch", "2"]);
  assert.equal(genExplicit.action, "drift-gen");
  assert.equal(genExplicit.driftGenAction, "generate");
  assert.equal(genExplicit.factsPerEpoch, 2);

  const val = parseBenchArgs(["drift-gen", "validate", "/tmp/corpus"]);
  assert.equal(val.action, "drift-gen");
  assert.equal(val.driftGenAction, "validate");
  assert.equal(val.driftGenDir, path.resolve("/tmp/corpus"));

  assert.throws(
    () => parseBenchArgs(["drift-gen", "unknown-subcommand"]),
    /drift-gen subcommand must be "generate" or "validate"/
  );
});

test("parseBenchArgs validates integer flags for drift-gen", () => {
  assert.throws(() => parseBenchArgs(["drift-gen", "--users", "abc"]), /--users must be a positive safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--users", "3.7"]), /--users must be a positive safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--users", "0"]), /--users must be a positive safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--epochs", "-1"]), /--epochs must be a positive safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--facts-per-epoch", "0"]), /--facts-per-epoch must be a positive safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--seed", "-1"]), /--seed must be a non-negative safe integer/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--seed", "1.5"]), /--seed must be a non-negative safe integer/);
});

test("parseBenchArgs validates ratio flags for drift-gen and attribute threshold", () => {
  assert.throws(() => parseBenchArgs(["drift-gen", "--drifting-ratio", "1.5"]), /--drifting-ratio must be a number between 0 and 1/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--drifting-ratio", "-0.1"]), /--drifting-ratio must be a number between 0 and 1/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--contradicted-ratio", "abc"]), /--contradicted-ratio must be a number between 0 and 1/);
  assert.throws(() => parseBenchArgs(["attribute", "--run", "run-1", "--threshold", "2.0"]), /--threshold must be a number between 0 and 1/);
});

test("parseBenchArgs throws when value flags are missing values", () => {
  assert.throws(() => parseBenchArgs(["attribute", "--run"]), /--run requires a value/);
  assert.throws(() => parseBenchArgs(["drift-gen", "--users"]), /--users requires a value/);
});

test("retry-failed filters matrix work at profile granularity", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline", "real"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(
    workItems,
    [
      { id: "locomo [baseline]", status: "complete" },
      { id: "locomo [real]", status: "failed" },
    ],
    "retry-failed"
  );

  assert.deepEqual(filtered, [{ benchmarkId: "locomo", runtimeProfile: "real" }]);
});

test("retry-failed preserves prior matrix status for single-profile reruns", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(
    workItems,
    [
      { id: "locomo [baseline]", status: "failed" },
      { id: "locomo", status: "complete" },
    ],
    "retry-failed"
  );

  assert.deepEqual(filtered, [{ benchmarkId: "locomo", runtimeProfile: "baseline" }]);
});

test("resume skips only completed matrix profile work", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline", "real"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(
    workItems,
    [
      { id: "locomo [baseline]", status: "complete" },
      { id: "locomo [real]", status: "failed" },
    ],
    "resume"
  );

  assert.deepEqual(filtered, [{ benchmarkId: "locomo", runtimeProfile: "real" }]);
});

test("runtime profiles for repro manifests follow filtered matrix work", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline", "real"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(
    workItems,
    [
      { id: "locomo [baseline]", status: "complete" },
      { id: "locomo [real]", status: "failed" },
    ],
    "resume"
  );

  assert.deepEqual(deriveRuntimeProfilesFromBenchWorkItems(filtered), ["real"]);
});

test("resume treats new matrix profiles as unrun when only bare status exists", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline", "real"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(workItems, [{ id: "locomo", status: "complete" }], "resume");

  assert.deepEqual(filtered, workItems);
});

test("retry-failed expands bare failed status across matrix profiles", () => {
  const workItems = createBenchWorkItems(["locomo"], ["baseline", "real"]);
  const filtered = filterBenchWorkItemsForPreviousStatus(
    workItems,
    [{ id: "locomo", status: "failed" }],
    "retry-failed"
  );

  assert.deepEqual(filtered, workItems);
});

// ---------- `bench published` (issue #566 PR 4/7) ----------

test("parseBenchArgs accepts published action with --name, --dataset, --model", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "longmemeval",
    "--dataset",
    "/tmp/bench-datasets/longmemeval",
    "--model",
    "gpt-4o-mini",
    "--seed",
    "42",
    "--limit",
    "100",
    "--out",
    "/tmp/out",
  ]);

  assert.equal(parsed.action, "published");
  assert.equal(parsed.publishedName, "longmemeval");
  // `--dataset` aliases to `--dataset-dir`.
  assert.equal(parsed.datasetDir, "/tmp/bench-datasets/longmemeval");
  assert.equal(parsed.systemModel, "gpt-4o-mini");
  assert.equal(parsed.publishedSeed, 42);
  assert.equal(parsed.publishedLimit, 100);
  assert.equal(parsed.publishedOut, "/tmp/out");
});

test("parseBenchArgs rejects unknown published --name", () => {
  assert.throws(
    () => parseBenchArgs(["published", "--name", "not-a-benchmark", "--dataset", "/tmp", "--model", "m"]),
    /--name must be one of ama-bench, memory-arena, amemgym, longmemeval, locomo, beam, personamem, memoryagentbench, membench/
  );
});

test("parseBenchArgs accepts every public benchmark for published runs", () => {
  for (const benchmarkId of [
    "ama-bench",
    "memory-arena",
    "amemgym",
    "longmemeval",
    "locomo",
    "beam",
    "personamem",
    "memoryagentbench",
    "membench",
  ] as const) {
    const parsed = parseBenchArgs([
      "published",
      "--name",
      benchmarkId,
      "--dataset",
      `/tmp/bench-datasets/${benchmarkId}`,
      "--model",
      "gpt-5.5",
    ]);

    assert.equal(parsed.action, "published");
    assert.equal(parsed.publishedName, benchmarkId);
    assert.equal(parsed.datasetDir, `/tmp/bench-datasets/${benchmarkId}`);
    assert.equal(parsed.systemModel, "gpt-5.5");
  }
});

test("parseBenchArgs rejects non-integer --limit", () => {
  assert.throws(
    () => parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "m", "--limit", "3.14"]),
    /--limit must be a non-negative integer/
  );
});

test("parseBenchArgs accepts published --trial-limit", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "locomo",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--trial-limit",
    "25",
  ]);

  assert.equal(parsed.publishedTrialLimit, 25);
});

test("parseBenchArgs accepts published --trial-concurrency for LoCoMo", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "locomo",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--trial-concurrency",
    "8",
  ]);

  assert.equal(parsed.publishedTrialConcurrency, 8);
});

test("parseBenchArgs accepts published --trial-concurrency for AMA-Bench", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "ama-bench",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--trial-concurrency",
    "8",
  ]);

  assert.equal(parsed.publishedTrialConcurrency, 8);
});

test("parseBenchArgs accepts published --ingest-concurrency for LoCoMo", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "locomo",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--ingest-concurrency",
    "6",
  ]);

  assert.equal(parsed.publishedIngestConcurrency, 6);
});

test("parseBenchArgs rejects invalid or unsupported --trial-concurrency", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--trial-concurrency",
        "0",
      ]),
    /--trial-concurrency must be an integer from 1 to 64/
  );
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "longmemeval",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--trial-concurrency",
        "2",
      ]),
    /--trial-concurrency is currently supported only for LoCoMo and AMA-Bench/
  );
});

test("parseBenchArgs rejects invalid or unsupported --ingest-concurrency", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--ingest-concurrency",
        "0",
      ]),
    /--ingest-concurrency must be an integer from 1 to 64/
  );
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "longmemeval",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--ingest-concurrency",
        "2",
      ]),
    /--ingest-concurrency is currently supported only for LoCoMo/
  );
});

test("parseBenchArgs accepts independent provider and drain timeouts", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--request-timeout", "120000", "--drain-timeout", "600000"]);

  assert.deepEqual(parsed.benchmarks, ["locomo"]);
  assert.equal(parsed.requestTimeout, 120000);
  assert.equal(parsed.drainTimeout, 600000);
});

test("parseBenchArgs validates judge-calibration pinning and independent timeouts", () => {
  const parsed = parseBenchArgs([
    "judge-calibrate", "--benchmark", "locomo",
    "--source-result-id", "run-1",
    "--expected-answer-set-sha256", "a".repeat(64),
    "--expected-question-id-list-sha256", "b".repeat(64),
    "--local-judge-request-timeout", "120000",
    "--frontier-judge-request-timeout", "240000",
    "--max-429-wait", "30000",
    "--disable-thinking",
    "--calibration-dir", "./private-calibration",
  ]);
  assert.equal(parsed.sourceResultId, "run-1");
  assert.equal(parsed.expectedAnswerSetSha256, "a".repeat(64));
  assert.equal(parsed.expectedQuestionIdListSha256, "b".repeat(64));
  assert.equal(parsed.localJudgeRequestTimeout, 120000);
  assert.equal(parsed.frontierJudgeRequestTimeout, 240000);
  assert.equal(parsed.max429WaitMs, 30000);
  assert.equal(parsed.disableThinking, true);
  assert.equal(parsed.calibrationDir, path.resolve("private-calibration"));
  assert.throws(() => parseBenchArgs([
    "judge-calibrate", "--expected-answer-set-sha256", "short",
  ]), /lowercase SHA-256/);
  assert.throws(() => parseBenchArgs([
    "judge-calibrate", "--frontier-judge-request-timeout", "0",
  ]), /positive integer/);
  assert.throws(() => parseBenchArgs([
    "judge-calibrate", "--max-429-wait", "1.5",
  ]), /non-negative integer/);
  assert.throws(() => parseBenchArgs([
    "judge-calibrate", "--source-result-id",
  ]), /requires a value/);
});

test("parseBenchArgs binds later runs to an exact calibration directory and judge configs", () => {
  const parsed = parseBenchArgs([
    "run", "locomo",
    "--calibration-dir", "./private-calibration",
    "--calibration-local-config-sha256", "c".repeat(64),
    "--calibration-frontier-config-sha256", "d".repeat(64),
  ]);
  assert.equal(parsed.calibrationDir, path.resolve("private-calibration"));
  assert.equal(parsed.calibrationLocalConfigSha256, "c".repeat(64));
  assert.equal(parsed.calibrationFrontierConfigSha256, "d".repeat(64));
  assert.throws(() => parseBenchArgs([
    "run", "locomo", "--calibration-local-config-sha256", "not-a-digest",
  ]), /lowercase SHA-256/);
});

test("parseBenchArgs rejects invalid --drain-timeout", () => {
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--drain-timeout", "0"]),
    /--drain-timeout must be a positive integer/
  );
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--drain-timeout", "1.5"]),
    /--drain-timeout must be a positive integer/
  );
});

test("parseBenchArgs accepts published --trial-limit for MemoryAgentBench", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "memoryagentbench",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--trial-limit",
    "4",
  ]);

  assert.equal(parsed.publishedTrialLimit, 4);
});

test("parseBenchArgs accepts --trial-limit for bench run locomo", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--trial-limit", "3"]);

  assert.equal(parsed.publishedTrialLimit, 3);
});

test("parseBenchArgs accepts hash-pinned task selection for one full LoCoMo run", () => {
  const digest = "a".repeat(64);
  const parsed = parseBenchArgs([
    "run",
    "locomo",
    "--task-ids-file",
    "./private/task-ids.json",
    "--expected-task-id-list-sha256",
    digest,
  ]);

  assert.equal(parsed.taskIdsFile, path.resolve("private/task-ids.json"));
  assert.equal(parsed.expectedTaskIdListSha256, digest);
});

test("parseBenchArgs requires both hash-pinned task-selection flags", () => {
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--task-ids-file", "task-ids.json"]),
    /must be supplied together/,
  );
  assert.throws(
    () => parseBenchArgs([
      "run",
      "locomo",
      "--expected-task-id-list-sha256",
      "a".repeat(64),
    ]),
    /must be supplied together/,
  );
});

test("parseBenchArgs rejects invalid task-selection hashes", () => {
  assert.throws(
    () => parseBenchArgs([
      "run",
      "locomo",
      "--task-ids-file",
      "task-ids.json",
      "--expected-task-id-list-sha256",
      "ABC",
    ]),
    /--expected-task-id-list-sha256 must be a lowercase SHA-256 hex digest/,
  );
});

test("parseBenchArgs scopes explicit task selection to an uncapped full LoCoMo run", () => {
  const selectorFlags = [
    "--task-ids-file",
    "task-ids.json",
    "--expected-task-id-list-sha256",
    "a".repeat(64),
  ];

  for (const argv of [
    ["run", "longmemeval", ...selectorFlags],
    ["run", "locomo", "longmemeval", ...selectorFlags],
    ["run", "--all", ...selectorFlags],
  ]) {
    assert.throws(() => parseBenchArgs(argv), /only for a single LoCoMo run/);
  }
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--quick", ...selectorFlags]),
    /requires a full LoCoMo run/,
  );
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--limit", "10", ...selectorFlags]),
    /cannot be combined with --limit or --trial-limit/,
  );
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "--trial-limit", "10", ...selectorFlags]),
    /cannot be combined with --limit or --trial-limit/,
  );
});

test("parseBenchArgs accepts --trial-limit for bench run memoryagentbench", () => {
  const parsed = parseBenchArgs(["run", "memoryagentbench", "--trial-limit", "2"]);

  assert.equal(parsed.publishedTrialLimit, 2);
});

test("parseBenchArgs rejects non-integer --trial-limit", () => {
  assert.throws(
    () =>
      parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "m", "--trial-limit", "2.5"]),
    /--trial-limit must be a non-negative integer/
  );
});

test("parseBenchArgs rejects published --trial-limit for unsupported benchmarks", () => {
  assert.throws(
    () =>
      parseBenchArgs(["published", "--name", "longmemeval", "--dataset", "/tmp", "--model", "m", "--trial-limit", "1"]),
    /--trial-limit is currently supported only for LoCoMo and MemoryAgentBench/
  );
  assert.throws(
    () => parseBenchArgs(["published", "--name", "beam", "--dataset", "/tmp", "--model", "m", "--trial-limit", "1"]),
    /--trial-limit is currently supported only for LoCoMo and MemoryAgentBench/
  );
});

test("parseBenchArgs rejects --trial-limit when a supported benchmark is not the only selected benchmark", () => {
  assert.throws(
    () => parseBenchArgs(["run", "locomo", "longmemeval", "--trial-limit", "1"]),
    /--trial-limit is currently supported only for LoCoMo and MemoryAgentBench/
  );
});

test("parseBenchArgs rejects non-integer --seed", () => {
  assert.throws(
    () => parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "m", "--seed", "1.5"]),
    /--seed must be a non-negative integer/
  );
});

test("parseBenchArgs rejects --model without value (CLAUDE.md rule 14)", () => {
  assert.throws(
    () => parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model"]),
    /--model requires a value/
  );
});

test("parseBenchArgs rejects empty --model string", () => {
  // Feeding an empty string via `--model=` is not our flag syntax
  // (we don't support =), but an explicitly empty next-token is tested.
  // We use `" "` to make this robust: `trim().length === 0`.
  assert.throws(
    () => parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "   "]),
    /--model must not be empty/
  );
});

test("parseBenchArgs accepts --provider shorthand", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "longmemeval",
    "--dataset",
    "/tmp",
    "--model",
    "gpt-4o-mini",
    "--provider",
    "openai",
    "--base-url",
    "https://api.openai.com",
  ]);
  assert.equal(parsed.systemProvider, "openai");
  assert.equal(parsed.systemBaseUrl, "https://api.openai.com");
});

test("parseBenchArgs accepts codex-cli as a system and judge provider", () => {
  const parsed = parseBenchArgs([
    "run",
    "longmemeval",
    "--system-provider",
    "codex-cli",
    "--system-model",
    "gpt-5.5",
    "--system-codex-reasoning-effort",
    "high",
    "--judge-provider",
    "codex-cli",
    "--judge-model",
    "gpt-5.5",
    "--judge-codex-reasoning-effort",
    "medium",
  ]);

  assert.equal(parsed.systemProvider, "codex-cli");
  assert.equal(parsed.systemModel, "gpt-5.5");
  assert.equal(parsed.systemCodexReasoningEffort, "high");
  assert.equal(parsed.judgeProvider, "codex-cli");
  assert.equal(parsed.judgeModel, "gpt-5.5");
  assert.equal(parsed.judgeCodexReasoningEffort, "medium");
});

test("parseBenchArgs accepts direct responder context budgeting", () => {
  const parsed = parseBenchArgs([
    "run",
    "ama-bench",
    "--system-provider",
    "codex-cli",
    "--system-model",
    "gpt-5.5",
    "--system-responder-context-budget-chars",
    "8000",
  ]);

  assert.equal(parsed.systemResponderContextBudgetChars, 8000);
});

test("parseBenchArgs accepts direct responder prompt budgeting", () => {
  const parsed = parseBenchArgs([
    "run",
    "ama-bench",
    "--system-provider",
    "codex-cli",
    "--system-model",
    "gpt-5.5",
    "--system-responder-prompt-budget-chars",
    "2000",
  ]);

  assert.equal(parsed.systemResponderPromptBudgetChars, 2000);
});

test("parseBenchArgs rejects responder context budget without a direct responder", () => {
  assert.throws(
    () => parseBenchArgs(["run", "ama-bench", "--system-responder-context-budget-chars", "8000"]),
    /--system-responder-context-budget-chars requires --system-provider/
  );
});

test("parseBenchArgs rejects responder prompt budget without a direct responder", () => {
  assert.throws(
    () => parseBenchArgs(["run", "ama-bench", "--system-responder-prompt-budget-chars", "2000"]),
    /--system-responder-prompt-budget-chars requires --system-provider/
  );
});

test("parseBenchArgs rejects invalid responder context budgets", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--system-provider",
        "codex-cli",
        "--system-model",
        "gpt-5.5",
        "--system-responder-context-budget-chars",
        "0",
      ]),
    /--system-responder-context-budget-chars must be a positive integer/
  );
});

test("parseBenchArgs rejects invalid responder prompt budgets", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--system-provider",
        "codex-cli",
        "--system-model",
        "gpt-5.5",
        "--system-responder-prompt-budget-chars",
        "3.14",
      ]),
    /--system-responder-prompt-budget-chars must be a positive integer/
  );
});

test("parseBenchArgs rejects system Codex reasoning effort for non-Codex providers", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--system-provider",
        "openai",
        "--system-model",
        "gpt-5.5",
        "--system-codex-reasoning-effort",
        "xhigh",
      ]),
    /--system-codex-reasoning-effort requires --system-provider codex-cli/
  );
});

test("parseBenchArgs accepts internal Remnic LLM provider flags", () => {
  const parsed = parseBenchArgs([
    "run",
    "ama-bench",
    "--internal-provider",
    "codex-cli",
    "--internal-model",
    "gpt-5.5",
    "--internal-disable-thinking",
    "--internal-codex-reasoning-effort",
    "xhigh",
  ]);

  assert.equal(parsed.internalProvider, "codex-cli");
  assert.equal(parsed.internalModel, "gpt-5.5");
  assert.equal(parsed.internalDisableThinking, true);
  assert.equal(parsed.internalCodexReasoningEffort, "xhigh");
});

test("parseBenchArgs rejects --internal-provider claude-cli (no @remnic/core gateway wiring, PR #1735 review)", () => {
  assert.throws(
    () => parseBenchArgs(["run", "ama-bench", "--internal-provider", "claude-cli", "--internal-model", "opus"]),
    /--internal-provider does not support "claude-cli"/
  );
});

test("parseBenchArgs still accepts claude-cli for --judge-provider and --system-provider (responder/judge path only)", () => {
  const parsed = parseBenchArgs([
    "run",
    "ama-bench",
    "--system-provider",
    "claude-cli",
    "--system-model",
    "opus",
    "--judge-provider",
    "claude-cli",
    "--judge-model",
    "opus",
  ]);

  assert.equal(parsed.systemProvider, "claude-cli");
  assert.equal(parsed.judgeProvider, "claude-cli");
});

test("parseBenchArgs rejects internal Codex reasoning effort for non-Codex providers", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--internal-provider",
        "ollama",
        "--internal-model",
        "gemma4:31b-cloud",
        "--internal-codex-reasoning-effort",
        "xhigh",
      ]),
    /--internal-codex-reasoning-effort requires --internal-provider codex-cli/
  );
});

test("parseBenchArgs accepts AMA-Bench recommended judge and cross-judge flags", () => {
  const parsed = parseBenchArgs([
    "run",
    "ama-bench",
    "--judge-provider",
    "codex-cli",
    "--judge-model",
    "gpt-5.5",
    "--ama-bench-judge-protocol",
    "recommended",
    "--ama-bench-cross-judge-model",
    "gpt-5.5",
    "--ama-bench-cross-judge-codex-reasoning-effort",
    "low",
  ]);

  assert.equal(parsed.amaBenchJudgeProtocol, "recommended");
  assert.equal(parsed.amaBenchCrossJudgeModel, "gpt-5.5");
  assert.equal(parsed.amaBenchCrossJudgeProvider, undefined);
  assert.equal(parsed.amaBenchCrossJudgeCodexReasoningEffort, "low");
});

test("parseBenchArgs rejects unknown AMA-Bench judge protocol", () => {
  assert.throws(
    () => parseBenchArgs(["run", "ama-bench", "--ama-bench-judge-protocol", "paperish"]),
    /--ama-bench-judge-protocol must be "default" or "recommended"/
  );
});

test("parseBenchArgs requires cross-judge model when cross-judge provider is configured", () => {
  assert.throws(
    () => parseBenchArgs(["run", "ama-bench", "--ama-bench-cross-judge-provider", "ollama"]),
    /--ama-bench-cross-judge-model is required/
  );
});

test("parseBenchArgs requires cross-judge model when only cross-judge Codex effort is configured", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--judge-provider",
        "codex-cli",
        "--judge-model",
        "gpt-5.5",
        "--ama-bench-cross-judge-codex-reasoning-effort",
        "low",
      ]),
    /--ama-bench-cross-judge-model is required/
  );
});

test("parseBenchArgs rejects cross-judge Codex reasoning effort for non-Codex providers", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--judge-provider",
        "ollama",
        "--judge-model",
        "qwen3:32b",
        "--judge-base-url",
        "https://ollama.com/api",
        "--ama-bench-cross-judge-model",
        "gemma4:31b-cloud",
        "--ama-bench-cross-judge-codex-reasoning-effort",
        "xhigh",
      ]),
    /--ama-bench-cross-judge-codex-reasoning-effort requires/
  );
});

test("parseBenchArgs rejects unknown --provider", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--provider",
        "not-a-provider",
      ]),
    /--provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", "codex-cli", or "claude-cli"/
  );
});

test("parseBenchArgs honors --dataset-dir over --dataset when both are set", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "longmemeval",
    "--dataset",
    "/alias",
    "--dataset-dir",
    "/canonical",
    "--model",
    "gpt-4o-mini",
  ]);
  assert.equal(parsed.datasetDir, "/canonical");
});

test("parseBenchArgs --dry-run sets publishedDryRun = true", () => {
  const parsed = parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "m", "--dry-run"]);
  assert.equal(parsed.publishedDryRun, true);
});

test("parseBenchArgs accepts BEAM diagnostic --task-filter", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "beam",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--task-filter",
    "instruction_following",
  ]);
  assert.equal(parsed.publishedTaskFilter, "instruction_following");
  assert.deepEqual(parsed.benchmarks, []);
});

test("parseBenchArgs accepts --task-filter for bench run beam", () => {
  const parsed = parseBenchArgs(["run", "beam", "--task-filter", "instruction_following"]);

  assert.equal(parsed.publishedTaskFilter, "instruction_following");
  assert.deepEqual(parsed.benchmarks, ["beam"]);
});

test("parseBenchArgs rejects --task-filter for non-BEAM benchmarks", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--task-filter",
        "instruction_following",
      ]),
    /--task-filter is currently supported only for BEAM/
  );
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "longmemeval",
        "--dataset",
        "/tmp",
        "--model",
        "m",
        "--task-filter",
        "instruction_following",
      ]),
    /--task-filter is currently supported only for BEAM/
  );
});

test("parseBenchArgs rejects --task-filter when BEAM is not the only selected benchmark", () => {
  assert.throws(
    () => parseBenchArgs(["run", "beam", "locomo", "--task-filter", "instruction_following"]),
    /--task-filter is currently supported only for BEAM/
  );
});

test("parseBenchArgs rejects empty --task-filter", () => {
  assert.throws(
    () => parseBenchArgs(["published", "--name", "beam", "--dataset", "/tmp", "--model", "m", "--task-filter", " "]),
    /--task-filter must not be empty/
  );
});

test("parseBenchArgs --limit 0 preserved (CLAUDE.md rule 27 slice-negative-zero)", () => {
  const parsed = parseBenchArgs(["published", "--name", "locomo", "--dataset", "/tmp", "--model", "m", "--limit", "0"]);
  assert.equal(parsed.publishedLimit, 0);
});

test("parseBenchArgs resolves --local-lab-manifest into localLabManifestPath (cursor review: #1573 PR2)", () => {
  // Regression: --runtime-profile accepted "local-lab" but there was no flag
  // to supply localLabManifestPath, so every CLI local-lab resolution failed
  // with the manifest-path error. --local-lab-manifest closes that gap and
  // resolves tildes + relative paths identically to other filesystem flags.
  const parsed = parseBenchArgs([
    "run",
    "locomo",
    "--runtime-profile",
    "local-lab",
    "--local-lab-manifest",
    "~/bench/local-lab.json",
  ]);

  assert.equal(parsed.runtimeProfile, "local-lab");
  assert.ok(parsed.localLabManifestPath?.startsWith("/"), "localLabManifestPath must be resolved to an absolute path");
  assert.match(parsed.localLabManifestPath ?? "", /local-lab\.json$/);
});

test("parseBenchArgs leaves localLabManifestPath undefined when --local-lab-manifest is absent", () => {
  const parsed = parseBenchArgs(["run", "locomo", "--runtime-profile", "baseline"]);
  assert.equal(parsed.localLabManifestPath, undefined);
});

test("parseBenchArgs --matrix empty error lists local-lab alongside the other profiles (cursor review: #1573 PR2 round 5)", () => {
  // Regression: the empty-matrix error named only baseline/real/openclaw-chain
  // even though parseBenchRuntimeProfile accepts local-lab, so the message was
  // an outdated allow-list.
  assert.throws(() => parseBenchArgs(["run", "locomo", "--matrix", " , , "]), /local-lab/);
});
