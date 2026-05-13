import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
    "--model",
    "gpt-5.5",
    "--config",
    'model_reasoning_effort="xhigh"',
    "--config",
    'approval_policy="never"',
    "--disable",
    "codex_hooks",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--cd",
    captured.workspacePath,
    "--skip-git-repo-check",
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
  assert.equal(captured.env?.OPENAI_API_KEY, "test-api-key");
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

test("codex-cli provider falls back to Responses API when CLI health probe fails", async () => {
  const previousTransport = process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
  const previousFetch = globalThis.fetch;
  let probeCount = 0;
  let fetchCount = 0;

  delete process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
  globalThis.fetch = (async (input, init) => {
    fetchCount += 1;
    assert.equal(String(input), "https://api.openai.com/v1/responses");
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      "Bearer test-api-key",
    );
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "gpt-5.5");
    assert.deepEqual(body.reasoning, { effort: "xhigh" });
    assert.equal(body.max_output_tokens, 12);
    assert.equal(body.store, false);
    assert.match(String(body.instructions), /benchmark LLM completion endpoint/);
    assert.match(String(body.instructions), /Answer briefly\./);
    assert.equal(body.input, "What is remembered?");
    return new Response(
      JSON.stringify({
        model: "gpt-5.5",
        output: [
          {
            content: [{ type: "output_text", text: "direct answer" }],
          },
        ],
        usage: { input_tokens: 11, output_tokens: 2, total_tokens: 13 },
      }),
      { status: 200 },
    );
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
      {
        async runCodexVersion() {
          probeCount += 1;
          return { status: 124, stderr: "version probe timed out" };
        },
      },
    );

    const result = await provider.complete("What is remembered?", {
      systemPrompt: "Answer briefly.",
      maxTokens: 12,
    });

    assert.equal(probeCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(result.text, "direct answer");
    assert.deepEqual(result.tokens, { input: 11, output: 2 });
    assert.deepEqual(provider.getUsage(), {
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13,
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTransport === undefined) {
      delete process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
    } else {
      process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT = previousTransport;
    }
  }
});

test("codex-cli provider fails fast when Responses transport is forced without an API key", async () => {
  const previousTransport = process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  let cliCalled = false;

  process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT = "responses";
  delete process.env.OPENAI_API_KEY;

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
            outputText: "unexpected",
          };
        },
      },
    );

    await assert.rejects(
      provider.complete("hello"),
      /Codex CLI fallback requires OPENAI_API_KEY/,
    );
    assert.equal(cliCalled, false);
  } finally {
    if (previousTransport === undefined) {
      delete process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT;
    } else {
      process.env.REMNIC_BENCH_CODEX_CLI_TRANSPORT = previousTransport;
    }
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
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

test("codex-cli provider writes metadata diagnostics without full prompt text", async () => {
  const diagnosticsDir = await mkdtemp(
    path.join(os.tmpdir(), "remnic-codex-cli-diag-"),
  );

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
    assert.equal(diagnostic.model, "gpt-5.5");
    assert.equal(diagnostic.reasoningEffort, "xhigh");
    assert.equal(diagnostic.timeoutMs, 1234);
    assert.equal("fullPrompt" in diagnostic, false);
    assert.equal((diagnostic.prompt as { userPromptChars: number }).userPromptChars, 19);
    assert.equal((diagnostic.result as { status: number }).status, 0);
  } finally {
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
    const diagnostic = JSON.parse(
      await readFile(path.join(diagnosticsDir, file!), "utf8"),
    ) as Record<string, unknown>;

    assert.match(String(diagnostic.fullPrompt), /diagnostic prompt/);
    assert.equal((diagnostic.result as { status: number }).status, 124);
    assert.match(String(diagnostic.error), /Codex CLI completion failed/);
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
