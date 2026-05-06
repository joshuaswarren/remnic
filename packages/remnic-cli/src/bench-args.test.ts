import assert from "node:assert/strict";
import test from "node:test";

import { parseBenchArgs } from "./bench-args.js";

test("parseBenchArgs keeps validated matrix profiles typed and ordered", () => {
  const parsed = parseBenchArgs([
    "run",
    "assistant-morning-brief",
    "--matrix",
    "baseline,real,openclaw-chain",
  ]);

  assert.deepEqual(parsed.matrixProfiles, [
    "baseline",
    "real",
    "openclaw-chain",
  ]);
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
  assert.equal(
    parsed.datasetDir,
    "/tmp/bench-datasets/longmemeval",
  );
  assert.equal(parsed.systemModel, "gpt-4o-mini");
  assert.equal(parsed.publishedSeed, 42);
  assert.equal(parsed.publishedLimit, 100);
  assert.equal(parsed.publishedOut, "/tmp/out");
});

test("parseBenchArgs rejects unknown published --name", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "not-a-benchmark",
        "--dataset",
        "/tmp",
        "--model",
        "m",
      ]),
    /--name must be one of longmemeval, locomo/,
  );
});

test("parseBenchArgs rejects non-integer --limit", () => {
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
        "--limit",
        "3.14",
      ]),
    /--limit must be a non-negative integer/,
  );
});

test("parseBenchArgs rejects non-integer --seed", () => {
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
        "--seed",
        "1.5",
      ]),
    /--seed must be a non-negative integer/,
  );
});

test("parseBenchArgs rejects --model without value (CLAUDE.md rule 14)", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
      ]),
    /--model requires a value/,
  );
});

test("parseBenchArgs rejects empty --model string", () => {
  // Feeding an empty string via `--model=` is not our flag syntax
  // (we don't support =), but an explicitly empty next-token is tested.
  // We use `" "` to make this robust: `trim().length === 0`.
  assert.throws(
    () =>
      parseBenchArgs([
        "published",
        "--name",
        "locomo",
        "--dataset",
        "/tmp",
        "--model",
        "   ",
      ]),
    /--model must not be empty/,
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
    /--system-codex-reasoning-effort requires --system-provider codex-cli/,
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
    /--internal-codex-reasoning-effort requires --internal-provider codex-cli/,
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
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--ama-bench-judge-protocol",
        "paperish",
      ]),
    /--ama-bench-judge-protocol must be "default" or "recommended"/,
  );
});

test("parseBenchArgs requires cross-judge model when cross-judge provider is configured", () => {
  assert.throws(
    () =>
      parseBenchArgs([
        "run",
        "ama-bench",
        "--ama-bench-cross-judge-provider",
        "ollama",
      ]),
    /--ama-bench-cross-judge-model is required/,
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
    /--ama-bench-cross-judge-model is required/,
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
    /--ama-bench-cross-judge-codex-reasoning-effort requires/,
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
    /--provider must be one of "openai", "anthropic", "ollama", "litellm", "local-llm", or "codex-cli"/,
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
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "locomo",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--dry-run",
  ]);
  assert.equal(parsed.publishedDryRun, true);
});

test("parseBenchArgs --limit 0 preserved (CLAUDE.md rule 27 slice-negative-zero)", () => {
  const parsed = parseBenchArgs([
    "published",
    "--name",
    "locomo",
    "--dataset",
    "/tmp",
    "--model",
    "m",
    "--limit",
    "0",
  ]);
  assert.equal(parsed.publishedLimit, 0);
});
