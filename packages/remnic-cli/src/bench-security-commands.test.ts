import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { BENCH_SECURITY_USAGE, parseBenchSecurityArgs } from "./bench-security-commands.js";
import { resolveHomeDir } from "./path-utils.js";

test("injection-suite parser requires --seeds and defaults outside the checkout", () => {
  const parsed = parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--limit", "2"]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.seeds, 1);
  assert.equal(parsed.limit, 2);
  assert.equal(parsed.variantsPerFamily, 25);
  assert.equal(parsed.retryAmbiguous, false);
  assert.equal(
    parsed.outputDir,
    path.join(resolveHomeDir(), ".remnic", "bench", "results", "h5-injection-suite"),
  );
});

test("injection-suite --run implies resume", () => {
  const parsed = parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--run", "/tmp/h5-run"]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.resume, true);
  assert.equal(parsed.outputDir, "/tmp/h5-run");
});

test("injection-suite parses explicit ambiguous-request retry", () => {
  const parsed = parseBenchSecurityArgs([
    "injection-suite",
    "--seeds",
    "1",
    "--run",
    "/tmp/h5-run",
    "--retry-ambiguous",
  ]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.resume, true);
  assert.equal(parsed.retryAmbiguous, true);
});

test("injection-suite rejects ambiguous retry on a new run", () => {
  assert.throws(
    () => parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--retry-ambiguous"]),
    /requires --run or --resume/,
  );
});

test("injection-suite parses live executor flags", () => {
  const parsed = parseBenchSecurityArgs([
    "injection-suite",
    "--seeds",
    "1",
    "--executor",
    "ollama",
    "--model",
    "qwen3.8-27b-64k:latest",
    "--base-url",
    "http://127.0.0.1:11434",
  ]);
  assert.ok(!("help" in parsed));
  if ("help" in parsed) return;
  assert.equal(parsed.executor, "ollama");
  assert.equal(parsed.model, "qwen3.8-27b-64k:latest");
  assert.equal(parsed.baseUrl, "http://127.0.0.1:11434");
});

test("unknown executor is rejected", () => {
  assert.throws(
    () => parseBenchSecurityArgs(["injection-suite", "--seeds", "1", "--executor", "runpod"]),
    /--executor must be/,
  );
});

test("unknown security subcommand is rejected", () => {
  assert.throws(() => parseBenchSecurityArgs(["nope"]), /unknown bench security subcommand/);
});

test("openai-compat help names host-isolated credential env vars", () => {
  assert.match(BENCH_SECURITY_USAGE, /api\.openai\.com \/ integrate\.api\.nvidia\.com/);
  assert.match(BENCH_SECURITY_USAGE, /router\.huggingface\.co require https \+ provider key/);
  assert.match(BENCH_SECURITY_USAGE, /REMNIC_OPENAI_COMPAT_API_KEY/);
  assert.match(BENCH_SECURITY_USAGE, /loopback HTTP/);
});
