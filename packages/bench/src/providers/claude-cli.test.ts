import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __claudeCliProviderTestHooks,
  createClaudeCliProvider,
} from "./claude-cli.ts";

test("claude-cli provider invokes claude -p in an isolated benchmark mode", async () => {
  const captured: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
    workspacePath?: string;
  } = {};
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      reasoningEffort: "xhigh",
      retryOptions: { timeoutMs: 1234 },
    },
    {
      async runClaudeCli(request) {
        captured.args = request.args;
        captured.env = request.env;
        captured.workspacePath = request.workspacePath;
        assert.equal(request.timeoutMs, 1234);
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "  final answer\n",
            model: "claude-opus-test",
            usage: { input_tokens: 12, output_tokens: 7 },
          }),
          stderr: "",
        };
      },
    },
  );

  const result = await provider.complete("What is remembered?", {
    systemPrompt: "Answer using only benchmark context.",
    temperature: 0,
  });

  assert.equal(result.text, "final answer");
  assert.equal(result.model, "claude-opus-test");
  assert.deepEqual(result.tokens, { input: 12, output: 7 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
  });
  // Isolation flags (issue #1728): --bare skips CLAUDE.md/hooks/plugins;
  // --tools "" disables every tool so no file/command/browse/memory access.
  assert.ok(captured.args?.includes("-p"));
  assert.ok(captured.args?.includes("--bare"));
  assert.equal(captured.args?.[captured.args.indexOf("--tools") + 1], "");
  assert.equal(captured.args?.[captured.args.indexOf("--model") + 1], "opus");
  assert.equal(captured.args?.[captured.args.indexOf("--effort") + 1], "xhigh");
  assert.equal(captured.args?.[captured.args.indexOf("--output-format") + 1], "json");
  assert.ok(captured.args?.includes("--no-session-persistence"));
  const systemPromptArg = captured.args?.[captured.args.indexOf("--system-prompt") + 1];
  assert.match(systemPromptArg ?? "", /benchmark LLM completion endpoint/);
  // Prompt payload keeps system + user in separate JSON fields.
  const positional = captured.args?.[captured.args.length - 1];
  assert.ok(positional?.includes("BENCHMARK_REQUEST_JSON:"));
  assert.ok(positional?.includes('"systemPrompt": "Answer using only benchmark context."'));
  assert.ok(positional?.includes('"userPrompt": "What is remembered?"'));
  // Workspace is an isolated temp dir, not the operator's project.
  assert.match(captured.workspacePath ?? "", /remnic-claude-cli-/);
  // Memory/secret env never reaches the child.
  assert.equal(captured.env?.REMNIC_MEMORY_DIR, undefined);
  assert.equal(captured.env?.ENGRAM_MEMORY_DIR, undefined);
  assert.equal(captured.env?.OPENCLAW_ENGRAM_ACCESS_TOKEN, undefined);
  assert.equal(captured.env?.OPENAI_API_KEY, undefined);
});

test("claude-cli provider does not expose unrelated process secrets to the child", async () => {
  const seededEnv = {
    ANTHROPIC_API_KEY: "anthropic-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "github-secret",
    NPM_TOKEN: "npm-secret",
    REMNIC_MEMORY_DIR: "/tmp/remnic",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  let capturedEnv: NodeJS.ProcessEnv | undefined;
  try {
    const provider = createClaudeCliProvider(
      { provider: "claude-cli", model: "opus" },
      {
        async runClaudeCli(request) {
          capturedEnv = request.env;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({
              type: "result",
              is_error: false,
              result: "ok",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            stderr: "",
          };
        },
      },
    );

    await provider.complete("hello");

    // ANTHROPIC_API_KEY IS allowlisted (Claude Code headless needs it), but
    // every unrelated secret and the Remnic memory dir must stay out.
    assert.equal(capturedEnv?.ANTHROPIC_API_KEY, "anthropic-secret");
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

test("claude-cli provider preserves networking env required by the child", () => {
  const seededEnv = {
    ANTHROPIC_BASE_URL: "https://gateway.example",
    HTTPS_PROXY: "http://proxy.example:8080",
    HOME: "/tmp/claude-home",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const env = __claudeCliProviderTestHooks.buildIsolatedClaudeEnv();
    assert.equal(env.ANTHROPIC_BASE_URL, "https://gateway.example");
    assert.equal(env.HTTPS_PROXY, "http://proxy.example:8080");
    assert.equal(env.HOME, "/tmp/claude-home");
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

test("claude-cli provider forwards config apiKey/baseUrl into the child env", async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      apiKey: "config-secret-key",
      baseUrl: "https://config-gateway.example",
    },
    {
      async runClaudeCli(request) {
        capturedEnv = request.env;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            type: "result",
            is_error: false,
            result: "ok",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          stderr: "",
        };
      },
    },
  );

  await provider.complete("hello");

  // Config apiKey/baseUrl MUST reach Claude Code headless as the env vars it
  // reads in --bare mode (mirrors codex-cli forwarding OPENAI_API_KEY). Before
  // the fix, buildIsolatedClaudeEnv() ignored config and these were undefined.
  assert.equal(capturedEnv?.ANTHROPIC_API_KEY, "config-secret-key");
  assert.equal(capturedEnv?.ANTHROPIC_BASE_URL, "https://config-gateway.example");
});

test("buildIsolatedClaudeEnv lets config apiKey/baseUrl override the inherited env", () => {
  const seededEnv = {
    ANTHROPIC_API_KEY: "env-secret",
    ANTHROPIC_BASE_URL: "https://env-gateway.example",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(seededEnv)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const env = __claudeCliProviderTestHooks.buildIsolatedClaudeEnv(
      "config-secret-key",
      "https://config-gateway.example",
    );
    assert.equal(env.ANTHROPIC_API_KEY, "config-secret-key");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://config-gateway.example");
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

test("claude-cli provider defaults reasoning effort to xhigh", async () => {
  let args: string[] = [];
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli(request) {
        args = request.args;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "ok" }),
          stderr: "",
        };
      },
    },
  );

  await provider.complete("hello");

  assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
});

test("claude-cli provider expands home-relative executable paths", () => {
  assert.equal(
    __claudeCliProviderTestHooks.resolveClaudeCliExecutable({
      provider: "claude-cli",
      model: "opus",
      executable: "~/bin/claude",
    }),
    path.join(os.homedir(), "bin", "claude"),
  );
});

test("claude-cli provider can use a benchmark-scoped executable env override", async () => {
  const previous = process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE;
  process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE = "/tmp/claude-app-binary";
  let executable = "";

  try {
    const provider = createClaudeCliProvider(
      { provider: "claude-cli", model: "opus" },
      {
        async runClaudeCli(request) {
          executable = request.executable;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ is_error: false, result: "ok" }),
            stderr: "",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(executable, "/tmp/claude-app-binary");
  } finally {
    if (previous === undefined) {
      delete process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE;
    } else {
      process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE = previous;
    }
  }
});

test("claude-cli provider executable config overrides the env override", async () => {
  const previous = process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE;
  process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE = "/tmp/claude-app-binary";
  let executable = "";

  try {
    const provider = createClaudeCliProvider(
      { provider: "claude-cli", model: "opus", executable: "/tmp/explicit-claude" },
      {
        async runClaudeCli(request) {
          executable = request.executable;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ is_error: false, result: "ok" }),
            stderr: "",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(executable, "/tmp/explicit-claude");
  } finally {
    if (previous === undefined) {
      delete process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE;
    } else {
      process.env.REMNIC_BENCH_CLAUDE_CLI_EXECUTABLE = previous;
    }
  }
});

test("claude-cli provider records token usage from the result envelope", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            is_error: false,
            result: "answer",
            usage: { input_tokens: 100, output_tokens: 40 },
          }),
          stderr: "",
        };
      },
    },
  );

  await provider.complete("q");

  assert.deepEqual(provider.getUsage(), {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
  });
});

test("claude-cli usage extractor estimates output tokens when usage is partial", () => {
  const usage = __claudeCliProviderTestHooks.extractClaudeUsage(
    { input_tokens: 200 },
    "a".repeat(40),
  );
  // No output_tokens field → estimate from text length (ceil(40/4) = 10),
  // capped to input so it can never exceed the reported total.
  assert.equal(usage.input, 200);
  assert.equal(usage.output, 10);
});

test("claude-cli provider surfaces auth/runtime is_error without retrying", async () => {
  // `claude -p` returns is_error:true with a JSON body on the no-auth case
  // ("Not logged in"). This MUST surface as a clear error and MUST NOT be
  // retried (retries burn Claude Max session budget re-asking an auth wall).
  let calls = 0;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { maxAttempts: 3 },
    },
    {
      async runClaudeCli() {
        calls += 1;
        return {
          status: 1,
          signal: null,
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            result: "Not logged in · Please run /login",
          }),
          stderr: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("q"),
    /Claude CLI completion failed .* Not logged in/,
  );
  assert.equal(calls, 1, "is_error auth failures must not be retried");
});

test("claude-cli provider surfaces non-zero exits without a parseable envelope", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 2,
          signal: null,
          stdout: "not json at all",
          stderr: "claude: argument error",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("q"),
    /Claude CLI completion failed \(exit 2\): claude: argument error/,
  );
});

test("claude-cli provider retries transient subprocess signals", async () => {
  let calls = 0;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { maxAttempts: 3, baseBackoffMs: 1 },
    },
    {
      async runClaudeCli() {
        calls += 1;
        if (calls < 3) {
          return { status: null, signal: "SIGTERM", stdout: "", stderr: "killed" };
        }
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "ok" }),
          stderr: "",
        };
      },
    },
  );

  const result = await provider.complete("q");

  assert.equal(result.text, "ok");
  assert.equal(calls, 3);
});

test("claude-cli provider does not retry benchmark timeouts", async () => {
  let calls = 0;
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus", retryOptions: { maxAttempts: 3 } },
    {
      async runClaudeCli() {
        calls += 1;
        return {
          status: 124,
          signal: "SIGTERM",
          stdout: "",
          stderr: "\nClaude CLI timed out after 1000ms.",
        };
      },
    },
  );

  await assert.rejects(provider.complete("q"), /timed out/);
  assert.equal(calls, 1);
});

test("claude-cli provider throws when the result envelope has no result text", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "   " }),
          stderr: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("q"),
    /Claude CLI completion returned no result text/,
  );
});

test("claude-cli envelope parser rejects non-object and non-JSON stdout", () => {
  const { parseClaudeResultEnvelope } = __claudeCliProviderTestHooks;
  assert.equal(parseClaudeResultEnvelope(""), undefined);
  assert.equal(parseClaudeResultEnvelope("not json"), undefined);
  assert.equal(parseClaudeResultEnvelope("[1, 2, 3]"), undefined);
  assert.deepEqual(parseClaudeResultEnvelope('{"is_error":false,"result":"x"}'), {
    isError: false,
    result: "x",
  });
});

test("claude-cli benchmark prompt keeps system and user input in separate JSON fields", () => {
  const prompt = __claudeCliProviderTestHooks.buildClaudeCompletionPrompt(
    "What color?",
    "Be terse.",
  );
  assert.ok(prompt.includes("BENCHMARK_REQUEST_JSON:"));
  const marker = "BENCHMARK_REQUEST_JSON:";
  const payload = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length).trim()) as {
    systemPrompt: string;
    userPrompt: string;
  };
  assert.equal(payload.systemPrompt, "Be terse.");
  assert.equal(payload.userPrompt, "What color?");
});

test("claude-cli provider resets accumulated usage", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            is_error: false,
            result: "ok",
            usage: { input_tokens: 5, output_tokens: 5 },
          }),
          stderr: "",
        };
      },
    },
  );

  await provider.complete("q");
  provider.resetUsage();

  assert.deepEqual(provider.getUsage(), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test("claude-cli provider diagnostics dir expands home-relative tilde paths", () => {
  assert.equal(
    __claudeCliProviderTestHooks.resolveClaudeCliDiagnosticsDir({
      provider: "claude-cli",
      model: "opus",
      diagnosticsDir: "~/bench-diag",
    }),
    path.resolve(path.join(os.homedir(), "bench-diag")),
  );
});

test("claude-cli discover surfaces a Claude Code model entry", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeVersion() {
        return { status: 0, stderr: "2.1.202 (Claude Code)" };
      },
    },
  );

  const models = await provider.discover();

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "opus");
  assert.match(models[0].name, /Claude Code/);
  assert.ok(models[0].capabilities.includes("completion"));
});

test("claude-cli discover fails clearly when the CLI is missing", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeVersion() {
        return { status: 127, stderr: "command not found: claude" };
      },
    },
  );

  await assert.rejects(provider.discover(), /Claude CLI discovery failed/);
});

// ---------------------------------------------------------------------------
// Keyless smoke (issue #1728): when no Claude auth is available the live CLI
// reports is_error. This test runs ONLY when REMNIC_BENCH_CLAUDE_CLI_SMOKE=1
// is set AND the operator has logged in; otherwise it skips with a reason so
// CI never burns Claude Max budget or fabricates a number.
// ---------------------------------------------------------------------------

test("claude-cli live smoke (keyless skip-with-reason by default)", { skip: process.env.REMNIC_BENCH_CLAUDE_CLI_SMOKE !== "1" ? "set REMNIC_BENCH_CLAUDE_CLI_SMOKE=1 and run `claude` login to exercise the live transport" : false }, async () => {
  const provider = createClaudeCliProvider({
    provider: "claude-cli",
    model: process.env.REMNIC_BENCH_CLAUDE_CLI_SMOKE_MODEL ?? "opus",
    retryOptions: { timeoutMs: 60_000 },
  });

  const result = await provider.complete("Reply with exactly: smoke-ok");

  assert.equal(result.text, "smoke-ok");
  assert.ok(result.tokens.input >= 0);
  assert.ok(result.tokens.output >= 0);
});
