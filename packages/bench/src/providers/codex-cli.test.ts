import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __codexCliProviderTestHooks,
  createCodexCliProvider,
} from "./codex-cli.ts";

test("codex-cli provider invokes codex exec in an isolated benchmark mode", async () => {
  const captured: {
    args?: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
    workspacePath?: string;
    outputPath?: string;
  } = {};
  const provider = createCodexCliProvider(
    {
      provider: "codex-cli",
      model: "gpt-5.5",
      apiKey: "test-api-key",
      baseUrl: "https://gateway.example/v1",
      reasoningEffort: "xhigh",
      retryOptions: { timeoutMs: 1234 },
    },
    {
      async runCodexCli(request) {
        captured.args = request.args;
        captured.input = request.input;
        captured.env = request.env;
        captured.workspacePath = request.workspacePath;
        captured.outputPath = request.outputPath;
        assert.equal(request.executable, "codex");
        assert.equal(request.timeoutMs, 1234);
        return {
          status: 0,
          signal: null,
          stdout: "ignored stdout",
          stderr: "",
          outputText: "  final answer\n",
        };
      },
    },
  );

  const result = await provider.complete("What is remembered?", {
    systemPrompt: "Answer using only benchmark context.",
    temperature: 0,
  });

  assert.equal(result.text, "final answer");
  assert.equal(result.model, "gpt-5.5");
  assert.deepEqual(result.tokens, { input: 0, output: 0 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.deepEqual(captured.args, [
    "exec",
    "--strict-config",
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'approval_policy="never"',
    "--config",
    'web_search="disabled"',
    "--disable",
    "hooks",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "multi_agent",
    "--disable",
    "browser_use",
    "--disable",
    "browser_use_external",
    "--disable",
    "browser_use_full_cdp_access",
    "--disable",
    "computer_use",
    "--disable",
    "image_generation",
    "--disable",
    "in_app_browser",
    "--disable",
    "goals",
    "--disable",
    "memories",
    "--disable",
    "chronicle",
    "--disable",
    "tool_suggest",
    "--disable",
    "workspace_dependencies",
    "--disable",
    "shell_snapshot",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    captured.workspacePath,
    "--skip-git-repo-check",
    "--json",
    "--output-last-message",
    captured.outputPath,
    "-",
  ]);
  assert.match(captured.workspacePath ?? "", /remnic-codex-cli-/);
  assert.ok(captured.input?.includes("BENCHMARK_REQUEST_JSON:"));
  assert.ok(captured.input?.includes('"systemPrompt": "Answer using only benchmark context."'));
  assert.ok(captured.input?.includes('"userPrompt": "What is remembered?"'));
  assert.equal(captured.env?.REMNIC_MEMORY_DIR, undefined);
  assert.equal(captured.env?.ENGRAM_MEMORY_DIR, undefined);
  assert.equal(captured.env?.OPENCLAW_ENGRAM_ACCESS_TOKEN, undefined);
  assert.equal(captured.env?.OPENAI_API_KEY, undefined);
  assert.equal(captured.env?.OPENAI_BASE_URL, undefined);
});

test("codex-cli provider exposes validated structured judge capabilities", async () => {
  const inputs: string[] = [];
  const outputs = [
    JSON.stringify({ score: 0.75, decision: "partial", reason: "mostly correct" }),
    JSON.stringify({
      identity_accuracy: 5,
      stance_coherence: 4,
      novelty: 3,
      calibration: 5,
      notes: "grounded",
    }),
  ];
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "Terra" },
    {
      async runCodexCli(request) {
        inputs.push(request.input);
        return {
          status: 0,
          signal: null,
          stdout: '{"type":"turn.completed","usage":{"input_tokens":30,"cached_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0}}',
          stderr: "",
          outputText: outputs.shift() ?? "",
        };
      },
    },
  );

  const verdict = await provider.judge({
    rubric: "Grade factual correctness.",
    rubricVersion: "judge-v1",
    input: "candidate answer",
  });
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.deepEqual(verdict.verdict, {
      score: 0.75,
      decision: "partial",
      reason: "mostly correct",
    });
    assert.equal(verdict.telemetry.rubricVersion, "judge-v1");
  }

  const assistantRubric = await provider.evaluateAssistantRubric({
    system: "Apply the sealed rubric.",
    user: "assistant response",
    rubricId: "assistant-v1",
  });
  assert.match(assistantRubric, /identity_accuracy/);
  assert.match(inputs[0] ?? "", /Grade factual correctness/);
  assert.match(inputs[0] ?? "", /Return raw JSON only/);
  assert.match(inputs[1] ?? "", /Apply the sealed rubric/);
  assert.equal(provider.getUsage().totalTokens, 80);
});

test("codex-cli structured judge distinguishes malformed output and caller aborts", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "Luna" },
    {
      async runCodexCli(request) {
        if (request.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        return {
          status: 0,
          signal: null,
          stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
          stderr: "",
          outputText: '{"score":2,"decision":"pass","reason":"out of range"}',
        };
      },
    },
  );
  const malformed = await provider.judge({
    rubric: "rubric",
    rubricVersion: "v1",
    input: "input",
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "malformed_verdict");

  const controller = new AbortController();
  controller.abort();
  const aborted = await provider.judge({
    rubric: "rubric",
    rubricVersion: "v1",
    input: "input",
    signal: controller.signal,
  });
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.error.code, "aborted");
});

test("codex-cli provider does not expose unrelated process secrets to the child", async () => {
  const seededEnv = {
    ANTHROPIC_API_KEY: "anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "github-secret",
    NPM_TOKEN: "npm-secret",
    OPENAI_API_KEY: "openai-secret",
    REMNIC_MEMORY_DIR: "/tmp/remnic",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  try {
    const provider = createCodexCliProvider(
      { provider: "codex-cli", model: "gpt-5.5" },
      {
        async runCodexCli(request) {
          capturedEnv = request.env;
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            outputText: "ok",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);
    assert.equal(capturedEnv?.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedEnv?.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(capturedEnv?.GITHUB_TOKEN, undefined);
    assert.equal(capturedEnv?.NPM_TOKEN, undefined);
    assert.equal(capturedEnv?.REMNIC_MEMORY_DIR, undefined);
  } finally {
    for (const key of Object.keys(seededEnv)) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
});

test("codex-cli provider preserves mixed-case Windows runtime env keys", () => {
  const seededEnv = {
    Path: "C:\\tools\\bin",
    SystemRoot: "C:\\Windows",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const env = __codexCliProviderTestHooks.buildIsolatedCodexEnv();

    assert.equal(env.Path, "C:\\tools\\bin");
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.OPENAI_API_KEY, undefined);
  } finally {
    for (const key of Object.keys(seededEnv)) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
});

test("codex-cli provider preserves networking env required by the child", () => {
  const seededEnv = {
    CODEX_HOME: "/tmp/codex-home",
    HTTPS_PROXY: "http://proxy.example:8080",
    no_proxy: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const env = __codexCliProviderTestHooks.buildIsolatedCodexEnv();

    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example:8080");
    assert.equal(env.no_proxy, "localhost,127.0.0.1");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/etc/company-ca.pem");
    assert.equal(env.SSL_CERT_FILE, "/etc/ssl/cert.pem");
    assert.equal(env.SSL_CERT_DIR, "/etc/ssl/certs");
  } finally {
    for (const key of Object.keys(seededEnv)) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
});

test("codex-cli provider does not forward API transport scoping to the child", () => {
  const seededEnv = {
    OPENAI_BASE_URL: "https://gateway.example/v1",
    OPENAI_ORGANIZATION: "org-example",
    OPENAI_PROJECT: "proj-example",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const env = __codexCliProviderTestHooks.buildIsolatedCodexEnv();

    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.OPENAI_ORGANIZATION, undefined);
    assert.equal(env.OPENAI_PROJECT, undefined);
  } finally {
    for (const key of Object.keys(seededEnv)) {
      const previous = previousEnv.get(key);
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  }
});

test("codex-cli provider defaults reasoning effort to xhigh", async () => {
  let args: string[] = [];
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli(request) {
        args = request.args;
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "",
          outputText: "ok",
        };
      },
    },
  );

  await provider.complete("hello");

  assert.equal(
    args[args.indexOf("--config") + 1],
    'model_reasoning_effort="xhigh"',
  );
  assert.equal(args.some((arg) => arg.includes("service_tier")), false);
  assert.ok(args.includes("--json"));
});

test("codex-cli provider can use a benchmark-scoped executable env override", async () => {
  const previous = process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE;
  process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE = "/tmp/codex-app-binary";
  let executable = "";

  try {
    const provider = createCodexCliProvider(
      { provider: "codex-cli", model: "gpt-5.5" },
      {
        async runCodexCli(request) {
          executable = request.executable;
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            outputText: "ok",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(executable, "/tmp/codex-app-binary");
  } finally {
    if (previous === undefined) {
      delete process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE;
    } else {
      process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE = previous;
    }
  }
});

test("codex-cli provider expands home-relative executable paths", () => {
  assert.equal(
    __codexCliProviderTestHooks.resolveCodexCliExecutable({
      provider: "codex-cli",
      model: "gpt-5.5",
      executable: "~/bin/codex",
    }),
    path.join(os.homedir(), "bin", "codex"),
  );
});

test("codex-cli provider executable config overrides the env override", async () => {
  const previous = process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE;
  process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE = "/tmp/codex-app-binary";
  let executable = "";

  try {
    const provider = createCodexCliProvider(
      {
        provider: "codex-cli",
        model: "gpt-5.5",
        executable: "/tmp/explicit-codex",
      },
      {
        async runCodexCli(request) {
          executable = request.executable;
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            outputText: "ok",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(executable, "/tmp/explicit-codex");
  } finally {
    if (previous === undefined) {
      delete process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE;
    } else {
      process.env.REMNIC_BENCH_CODEX_CLI_EXECUTABLE = previous;
    }
  }
});

test("codex-cli provider records total token usage from CLI stderr", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "tokens used 1,234",
          outputText: "final answer",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.deepEqual(result.tokens, { input: 1231, output: 3 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 1231,
    outputTokens: 3,
    totalTokens: 1234,
  });
});

test("codex-cli token parser uses the final tokens-used line", () => {
  assert.deepEqual(
    __codexCliProviderTestHooks.parseCodexTokenUsage(
      "tokens used 100\ntokens used 2,000",
      "ok",
    ),
    { input: 1999, output: 1 },
  );
});

test("codex-cli provider records token usage when Codex writes token accounting to stdout", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 0,
          signal: null,
          stdout: "tokens used 44",
          stderr: "",
          outputText: "final answer",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.equal(result.tokens.input + result.tokens.output, 44);
  assert.equal(provider.getUsage().totalTokens, 44);
});

test("codex-cli provider fails closed on CLI errors without calling the Responses API", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("network must not be used");
  }) as typeof fetch;

  try {
    const provider = createCodexCliProvider(
      {
        provider: "codex-cli",
        model: "gpt-5.5",
        apiKey: "test-api-key",
        reasoningEffort: "xhigh",
        retryOptions: { timeoutMs: 1234, maxAttempts: 1 },
      },
      { async runCodexCli() {
        return { status: 2, signal: null, stdout: "", stderr: "login required", outputText: "" };
      } },
    );

    await assert.rejects(provider.complete("What is remembered?"), /login required/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("codex-cli provider ignores the removed Responses transport override", async () => {
  const previousTransport = process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
  let cliCalled = false;

  process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT = "responses";

  try {
    const provider = createCodexCliProvider(
      { provider: "codex-cli", model: "gpt-5.5" },
      {
        async runCodexCli() {
          cliCalled = true;
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "",
            outputText: "cli answer",
          };
        },
      },
    );

    assert.equal((await provider.complete("hello")).text, "cli answer");
    assert.equal(cliCalled, true);
  } finally {
    if (previousTransport === undefined) {
      delete process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
    } else {
      process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT = previousTransport;
    }
  }
});

test("bounded codex-cli runs require ChatGPT auth and persist native usage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-auth-"));
  const keys = [
    "REMNIC_BENCH_CODEX_CREDIT_BUDGET",
    "REMNIC_BENCH_CODEX_CREDIT_RESERVE",
    "REMNIC_BENCH_CODEX_CREDIT_LEDGER",
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.REMNIC_BENCH_CODEX_CREDIT_BUDGET = "2473";
  process.env.REMNIC_BENCH_CODEX_CREDIT_RESERVE = "473";
  process.env.REMNIC_BENCH_CODEX_CREDIT_LEDGER = path.join(directory, "ledger.json");

  try {
    __codexCliProviderTestHooks.clearCodexCliLoginStatusCache();
    let called = false;
    const apiAuthed = createCodexCliProvider(
      { provider: "codex-cli", model: "gpt-5.6-luna" },
      {
        async runCodexLoginStatus() {
          return { status: 0, stdout: "Logged in using an API key", stderr: "" };
        },
        async runCodexCli() {
          called = true;
          throw new Error("must not run");
        },
      },
    );
    await assert.rejects(apiAuthed.complete("hello"), /require ChatGPT-backed/);
    assert.equal(called, false);

    __codexCliProviderTestHooks.clearCodexCliLoginStatusCache();
    const chatGptAuthed = createCodexCliProvider(
      { provider: "codex-cli", model: "gpt-5.6-luna" },
      {
        async runCodexLoginStatus() {
          return { status: 0, stdout: "Logged in using ChatGPT", stderr: "" };
        },
        async runCodexCli() {
          return {
            status: 0,
            signal: null,
            stdout: '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":10,"reasoning_output_tokens":5}}',
            stderr: "",
            outputText: "answer",
          };
        },
      },
    );
    assert.equal((await chatGptAuthed.complete("hello")).text, "answer");
    const ledger = JSON.parse(
      await readFile(path.join(directory, "ledger.json"), "utf8"),
    ) as { entries: Array<{ inputTokens: number; cachedInputTokens: number }> };
    assert.deepEqual(ledger.entries[0], {
      at: ledger.entries[0]?.at,
      model: "gpt-5.6-luna",
      credits: 0.00355,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 10,
      reasoningOutputTokens: 5,
    });
  } finally {
    __codexCliProviderTestHooks.clearCodexCliLoginStatusCache();
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("codex-cli provider surfaces non-zero CLI exits", async () => {
  const provider = createCodexCliProvider(
    { provider: "codex-cli", model: "gpt-5.5" },
    {
      async runCodexCli() {
        return {
          status: 2,
          signal: null,
          stdout: "",
          stderr: "invalid model",
          outputText: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Codex CLI completion failed \(exit 2\): invalid model/,
  );
});

test("codex-cli provider retries transient subprocess signals", async () => {
  let attempts = 0;
  const provider = createCodexCliProvider(
    {
      provider: "codex-cli",
      model: "gpt-5.5",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 1 },
    },
    {
      async runCodexCli() {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "parent process interrupted child",
            outputText: "",
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: "",
          stderr: "tokens used 8",
          outputText: "recovered answer",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered answer");
  assert.deepEqual(result.tokens, { input: 4, output: 4 });
});

test("codex-cli provider stops retry backoff when the completion is aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const provider = createCodexCliProvider(
    {
      provider: "codex-cli",
      model: "gpt-5.5",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 10_000 },
    },
    {
      async runCodexCli() {
        attempts += 1;
        setTimeout(() => {
          controller.abort(new Error("benchmark cancelled"));
        }, 10);
        return {
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "parent process interrupted child",
          outputText: "",
        };
      },
    },
  );

  const startedAt = performance.now();
  await assert.rejects(
    provider.complete("hello", { signal: controller.signal }),
    /benchmark cancelled/,
  );

  assert.equal(attempts, 1);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("codex-cli provider marks transient retry diagnostics without counting final success as failure", async () => {
  const diagnosticsDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-codex-cli-diag-"),
  );
  let attempts = 0;

  try {
    const provider = createCodexCliProvider(
      {
        provider: "codex-cli",
        model: "gpt-5.5",
        diagnosticsDir,
        retryOptions: { maxAttempts: 2, baseBackoffMs: 1 },
      },
      {
        async runCodexCli() {
          attempts += 1;
          if (attempts === 1) {
            return {
              status: null,
              signal: "SIGTERM",
              stdout: "partial stdout",
              stderr: "parent process interrupted child",
              outputText: "",
            };
          }
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "ok",
            outputText: "recovered answer",
          };
        },
      },
    );

    await provider.complete("hello");

    const diagnostics = await Promise.all(
      (await readdir(diagnosticsDir)).map(async (file) =>
        JSON.parse(await readFile(path.join(diagnosticsDir, file), "utf8")) as Record<string, unknown>,
      ),
    );
    diagnostics.sort((left, right) =>
      String((left.retry as { attempt?: number } | undefined)?.attempt ?? 0)
        .localeCompare(String((right.retry as { attempt?: number } | undefined)?.attempt ?? 0)),
    );

    assert.equal(diagnostics.length, 2);
    assert.deepEqual(diagnostics[0]?.retry, {
      attempt: 1,
      maxAttempts: 2,
      transientFailure: true,
    });
    assert.equal((diagnostics[0]?.result as { signal?: string }).signal, "SIGTERM");
    assert.match(String(diagnostics[0]?.error), /Codex CLI completion failed/);
    assert.deepEqual(diagnostics[1]?.retry, {
      attempt: 2,
      maxAttempts: 2,
    });
    assert.equal((diagnostics[1]?.result as { status?: number }).status, 0);
    assert.equal("error" in diagnostics[1]!, false);
  } finally {
    await rm(diagnosticsDir, { force: true, recursive: true });
  }
});

test("codex-cli provider does not retry benchmark timeouts", async () => {
  let attempts = 0;
  const provider = createCodexCliProvider(
    {
      provider: "codex-cli",
      model: "gpt-5.5",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 1 },
    },
    {
      async runCodexCli() {
        attempts += 1;
        return {
          status: 124,
          signal: "SIGTERM",
          stdout: "",
          stderr: "Codex CLI timed out after 1000ms.",
          outputText: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Codex CLI completion failed \(signal SIGTERM\): Codex CLI timed out after 1000ms\./,
  );
  assert.equal(attempts, 1);
});

test("codex-cli provider writes metadata diagnostics without full prompt text", async () => {
  const diagnosticsDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-codex-cli-diag-"),
  );
  const previousRunId = process.env.REMNIC_BENCH_RUN_ID;
  process.env.REMNIC_BENCH_RUN_ID = "test-public-matrix-run";

  try {
    const provider = createCodexCliProvider(
      {
        provider: "codex-cli",
        model: "gpt-5.5",
        diagnosticsDir,
        reasoningEffort: "xhigh",
        retryOptions: { timeoutMs: 1234 },
      },
      {
        async runCodexCli() {
          return {
            status: 0,
            signal: null,
            stdout: "tokens used 44",
            stderr: "ok",
            outputText: "final answer",
          };
        },
      },
    );

    await provider.complete("What is remembered?", {
      systemPrompt: "Answer using only benchmark context.",
    });

    const files = await readdir(diagnosticsDir);
    assert.equal(files.length, 1);
    const diagnostic = JSON.parse(
      await readFile(path.join(diagnosticsDir, files[0]!), "utf8"),
    ) as Record<string, unknown>;

    assert.equal(diagnostic.provider, "codex-cli");
    assert.equal(diagnostic.runId, "test-public-matrix-run");
    assert.equal(diagnostic.model, "gpt-5.5");
    assert.equal(diagnostic.reasoningEffort, "xhigh");
    assert.equal(diagnostic.serviceTier, "default");
    assert.equal(diagnostic.timeoutMs, 1234);
    assert.equal("fullPrompt" in diagnostic, false);
    assert.equal((diagnostic.prompt as { userPromptChars: number }).userPromptChars, 19);
    assert.equal((diagnostic.result as { status: number }).status, 0);
  } finally {
    if (previousRunId === undefined) {
      delete process.env.REMNIC_BENCH_RUN_ID;
    } else {
      process.env.REMNIC_BENCH_RUN_ID = previousRunId;
    }
    await rm(diagnosticsDir, { force: true, recursive: true });
  }
});

test("codex-cli provider writes full diagnostics only when explicitly requested", async () => {
  const diagnosticsDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-codex-cli-diag-"),
  );

  try {
    const provider = createCodexCliProvider(
      {
        provider: "codex-cli",
        model: "gpt-5.5",
        diagnosticsDir,
        diagnosticsMode: "full",
      },
      {
        async runCodexCli() {
          return {
            status: 124,
            signal: "SIGTERM",
            stdout: "",
            stderr: "timed out",
            outputText: "",
          };
        },
      },
    );

    await assert.rejects(
      provider.complete("diagnostic prompt"),
      /Codex CLI completion failed \(signal SIGTERM\): timed out/,
    );

    const [file] = await readdir(diagnosticsDir);
    const diagnosticPath = path.join(diagnosticsDir, file!);
    const diagnostic = JSON.parse(
      await readFile(diagnosticPath, "utf8"),
    ) as Record<string, unknown>;

    assert.match(String(diagnostic.fullPrompt), /diagnostic prompt/);
    assert.equal((diagnostic.result as { status: number }).status, 124);
    assert.match(String(diagnostic.error), /Codex CLI completion failed/);
    if (process.platform !== "win32") {
      assert.equal((await stat(diagnosticPath)).mode & 0o777, 0o600);
      assert.equal((await stat(diagnosticsDir)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(diagnosticsDir, { force: true, recursive: true });
  }
});

test("codex-cli diagnostics dir expands home-relative tilde paths", () => {
  assert.equal(
    __codexCliProviderTestHooks.resolveCodexCliDiagnosticsDir({
      provider: "codex-cli",
      model: "gpt-5.5",
      diagnosticsDir: "~/codex-diag",
    }),
    path.join(os.homedir(), "codex-diag"),
  );
});

test("codex-cli command terminates subprocess when aborted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-cli-test-"));
  const controller = new AbortController();

  try {
    const run = __codexCliProviderTestHooks.runCodexCliCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); setInterval(() => {}, 1000);",
      ],
      input: "hello",
      outputPath: path.join(tempDir, "last-message.txt"),
      workspacePath: tempDir,
      timeoutMs: 60_000,
      signal: controller.signal,
      env: process.env,
    });

    setTimeout(() => controller.abort(), 20);
    const result = await run;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Codex CLI aborted by benchmark timeout/);
    assert.equal(__codexCliProviderTestHooks.getActiveCodexCliChildCount(), 0);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("codex-cli command rejects a successful process that omits the final-message file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-output-"));
  const workspacePath = path.join(tempDir, "workspace");
  await mkdir(workspacePath);
  try {
    await assert.rejects(
      __codexCliProviderTestHooks.runCodexCliCommand({
        executable: process.execPath,
        args: [
          "-e",
          'process.stdout.write(\'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}\\n\')',
        ],
        input: "prompt",
        outputPath: path.join(tempDir, "missing-last-message.txt"),
        workspacePath,
        env: process.env,
      }),
      /did not write --output-last-message/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("codex-cli command identifies a confirmed pre-dispatch failure", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-dispatch-"));
  try {
    await assert.rejects(
      __codexCliProviderTestHooks.runCodexCliCommand({
        executable: path.join(tempDir, "missing-codex-executable"),
        args: [],
        input: "prompt",
        outputPath: path.join(tempDir, "last-message.txt"),
        workspacePath: tempDir,
        env: process.env,
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "CodexCreditDispatchError" &&
        /could not start/.test(error.message),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("codex-cli parent cleanup terminates active subprocesses", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-codex-cli-test-"));

  try {
    const run = __codexCliProviderTestHooks.runCodexCliCommand({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); setInterval(() => {}, 1000);",
      ],
      input: "hello",
      outputPath: path.join(tempDir, "last-message.txt"),
      workspacePath: tempDir,
      timeoutMs: 60_000,
      env: process.env,
    });

    assert.equal(__codexCliProviderTestHooks.getActiveCodexCliChildCount(), 1);
    __codexCliProviderTestHooks.terminateActiveCodexCliChildren("SIGTERM");

    const result = await run;

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(__codexCliProviderTestHooks.getActiveCodexCliChildCount(), 0);
  } finally {
    __codexCliProviderTestHooks.terminateActiveCodexCliChildren("SIGKILL");
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("codex-cli benchmark prompt keeps system and user input in separate JSON fields", () => {
  const prompt = __codexCliProviderTestHooks.buildCodexCompletionPrompt(
    "USER_CONTEXT: answer this",
    "SYSTEM_CONTEXT: judge this",
  );

  const json = prompt.slice(prompt.indexOf("{"));
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, {
    systemPrompt: "SYSTEM_CONTEXT: judge this",
    userPrompt: "USER_CONTEXT: answer this",
  });
});
