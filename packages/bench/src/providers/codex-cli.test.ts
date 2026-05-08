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
