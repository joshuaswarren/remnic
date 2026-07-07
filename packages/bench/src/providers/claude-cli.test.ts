import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __claudeCliProviderTestHooks, createClaudeCliProvider } from "./claude-cli.ts";

test("claude-cli provider invokes claude -p in an isolated benchmark mode", async () => {
  const captured: {
    args?: string[];
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {};
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { timeoutMs: 1234 },
    },
    {
      async runClaudeCli(request) {
        captured.args = request.args;
        captured.input = request.input;
        captured.env = request.env;
        captured.cwd = request.cwd;
        assert.equal(request.executable, "claude");
        assert.equal(request.timeoutMs, 1234);
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            is_error: false,
            result: "final answer",
            usage: { input_tokens: 10, output_tokens: 4 },
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
  assert.equal(result.model, "opus");
  assert.deepEqual(result.tokens, { input: 10, output: 4 });
  assert.deepEqual(provider.getUsage(), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  });
  assert.deepEqual(captured.args, [
    "--print",
    "--model",
    "opus",
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
    "--append-system-prompt",
    "Answer using only benchmark context.",
  ]);
  assert.ok(captured.input?.includes("BENCHMARK_REQUEST_JSON:"));
  assert.ok(!captured.input?.includes("systemPrompt"));
  assert.ok(captured.input?.includes('"userPrompt": "What is remembered?"'));
  assert.match(captured.input ?? "", /Do not use tools, do not read or write files, do not browse/);
  assert.match(captured.cwd ?? "", /remnic-claude-cli-/);
  assert.notEqual(captured.cwd, process.cwd());
});

test("claude-cli provider omits --append-system-prompt when no systemPrompt is given", async () => {
  const captured: { args?: string[] } = {};
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli(request) {
        captured.args = request.args;
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

  assert.ok(!captured.args?.includes("--append-system-prompt"));
});

test("claude-cli provider runs from a freshly created empty temp directory", async () => {
  const seenCwds: string[] = [];
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli(request) {
        seenCwds.push(request.cwd);
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
  await provider.complete("hello again");

  assert.equal(seenCwds.length, 2);
  for (const cwd of seenCwds) {
    assert.match(cwd, new RegExp(`^${escapeRegExp(os.tmpdir())}`));
    assert.match(path.basename(cwd), /^remnic-claude-cli-/);
  }
  // Each call gets its own fresh directory, not a shared/reused one.
  assert.notEqual(seenCwds[0], seenCwds[1]);
});

test("claude-cli provider does not forward an ambient ANTHROPIC_API_KEY by default", async () => {
  const seededEnv = {
    ANTHROPIC_API_KEY: "ambient-secret-should-not-leak",
    OPENAI_API_KEY: "unrelated-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    GITHUB_TOKEN: "github-secret",
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
            stdout: JSON.stringify({ is_error: false, result: "ok" }),
            stderr: "",
          };
        },
      },
    );

    await provider.complete("hello");

    assert.equal(capturedEnv?.ANTHROPIC_API_KEY, undefined);
    assert.equal(capturedEnv?.OPENAI_API_KEY, undefined);
    assert.equal(capturedEnv?.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(capturedEnv?.GITHUB_TOKEN, undefined);
    assert.equal(capturedEnv?.HOME, os.homedir());
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

test("claude-cli provider forwards an explicitly configured apiKey/baseUrl (opt-in only)", () => {
  const env = __claudeCliProviderTestHooks.buildIsolatedClaudeEnv({
    provider: "claude-cli",
    model: "opus",
    apiKey: "explicit-key",
    baseUrl: "https://gateway.example/v1",
  });

  assert.equal(env.ANTHROPIC_API_KEY, "explicit-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://gateway.example/v1");
});

test("claude-cli provider is_error JSON response throws with a useful message", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            is_error: true,
            result: "invalid model requested",
          }),
          stderr: "",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Claude CLI reported is_error: invalid model requested/,
  );
});

test("claude-cli provider surfaces non-zero CLI exits", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 2,
          signal: null,
          stdout: "",
          stderr: "invalid model",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Claude CLI completion failed \(exit 2\): invalid model/,
  );
});

test("claude-cli provider throws when stdout is not valid JSON", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        return {
          status: 0,
          signal: null,
          stdout: "not json at all",
          stderr: "",
        };
      },
    },
  );

  await assert.rejects(provider.complete("hello"), /Claude CLI reported is_error/);
});

test("claude-cli provider throws when the JSON result has empty text", async () => {
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

  await assert.rejects(provider.complete("hello"), /Claude CLI completion returned no result text/);
});

test("claude-cli provider retries transient subprocess signals", async () => {
  let attempts = 0;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 1 },
    },
    {
      async runClaudeCli() {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: null,
            signal: "SIGTERM",
            stdout: "",
            stderr: "parent process interrupted child",
          };
        }
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({
            is_error: false,
            result: "recovered answer",
            usage: { input_tokens: 3, output_tokens: 5 },
          }),
          stderr: "",
        };
      },
    },
  );

  const result = await provider.complete("hello");

  assert.equal(attempts, 2);
  assert.equal(result.text, "recovered answer");
  assert.deepEqual(result.tokens, { input: 3, output: 5 });
});

test("claude-cli provider does not retry benchmark timeouts", async () => {
  let attempts = 0;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 1 },
    },
    {
      async runClaudeCli() {
        attempts += 1;
        return {
          status: 124,
          signal: "SIGTERM",
          stdout: "",
          stderr: "Claude CLI timed out after 1000ms.",
        };
      },
    },
  );

  await assert.rejects(
    provider.complete("hello"),
    /Claude CLI completion failed \(signal SIGTERM\): Claude CLI timed out after 1000ms\./,
  );
  assert.equal(attempts, 1);
});

test("claude-cli provider stops retry backoff when the completion is aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const provider = createClaudeCliProvider(
    {
      provider: "claude-cli",
      model: "opus",
      retryOptions: { maxAttempts: 2, baseBackoffMs: 10_000 },
    },
    {
      async runClaudeCli() {
        attempts += 1;
        setTimeout(() => {
          controller.abort(new Error("benchmark cancelled"));
        }, 10);
        return {
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "parent process interrupted child",
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

test("claude-cli usage-limit signal detector recognizes common phrasing", () => {
  const { isClaudeUsageLimitSignal } = __claudeCliProviderTestHooks;
  assert.equal(isClaudeUsageLimitSignal("Error: usage limit reached, resets in 3 hours"), true);
  assert.equal(isClaudeUsageLimitSignal("You are being rate limited, please try again later"), true);
  assert.equal(isClaudeUsageLimitSignal("HTTP 429 Too Many Requests"), true);
  assert.equal(isClaudeUsageLimitSignal("invalid model requested"), false);
  assert.equal(isClaudeUsageLimitSignal(""), false);
});

test("claude-cli provider backs off much longer on a detected usage-limit than a normal retry", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];
  const originalSetTimeout = global.setTimeout;
  // Short-circuit real waiting: record the requested delay and resolve
  // immediately, so the backoff *decision* is exercised without the test
  // actually sleeping for minutes.
  // @ts-expect-error -- test-only monkeypatch of the timer used by the
  // provider's abort-aware sleep helper.
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    sleepCalls.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as typeof setTimeout;

  try {
    const provider = createClaudeCliProvider(
      {
        provider: "claude-cli",
        model: "opus",
        retryOptions: { maxAttempts: 1, max429WaitMs: 5 * 60_000 },
      },
      {
        async runClaudeCli() {
          attempts += 1;
          if (attempts === 1) {
            return {
              status: 0,
              signal: null,
              stdout: "",
              stderr: "Claude AI usage limit reached, resets at 5pm",
            };
          }
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ is_error: false, result: "recovered after usage limit" }),
            stderr: "",
          };
        },
      },
    );

    const result = await provider.complete("hello");
    assert.equal(result.text, "recovered after usage limit");
    assert.equal(attempts, 2);
    assert.equal(sleepCalls.length, 1);
    // The usage-limit backoff step must be seconds-to-minutes, not the
    // millisecond-scale backoff used for ordinary transient failures.
    assert.ok(sleepCalls[0] >= 60_000, `expected a >=60s usage-limit backoff, got ${sleepCalls[0]}ms`);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("claude-cli provider gives up once the usage-limit backoff budget is exhausted", async () => {
  let attempts = 0;
  const originalSetTimeout = global.setTimeout;
  // @ts-expect-error -- test-only monkeypatch, see above.
  global.setTimeout = ((fn: (...args: unknown[]) => void) => originalSetTimeout(fn, 0)) as typeof setTimeout;

  try {
    const provider = createClaudeCliProvider(
      {
        provider: "claude-cli",
        model: "opus",
        // A budget smaller than the usage-limit base backoff step (60s)
        // forces the very first detection to exhaust the budget.
        retryOptions: { maxAttempts: 5, max429WaitMs: 10 },
      },
      {
        async runClaudeCli() {
          attempts += 1;
          return {
            status: 0,
            signal: null,
            stdout: "",
            stderr: "usage limit exceeded",
          };
        },
      },
    );

    await assert.rejects(provider.complete("hello"), /usage-limit backoff budget \(10ms\) exhausted/);
    assert.equal(attempts, 1);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("claude-cli provider defaults concurrency to 1 and serializes calls", async () => {
  __claudeCliProviderTestHooks.resetSharedClaudeCliGateForTests();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push("start");
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("end");
        active -= 1;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "ok" }),
          stderr: "",
        };
      },
    },
  );

  await Promise.all([provider.complete("one"), provider.complete("two"), provider.complete("three")]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["start", "end", "start", "end", "start", "end"]);
});

test("claude-cli provider serializes claude -p calls across SEPARATE provider instances (shared global gate)", async () => {
  // Regression test for PR #1735 review: a benchmark run uses distinct
  // ClaudeCliProvider instances for the responder and the judge. Before this
  // fix, each instance owned its own ClaudeCliConcurrencyGate, so a
  // responder call and a judge call could run `claude -p` concurrently
  // against the operator's single shared Claude Max quota. The gate must now
  // be shared process-wide so two independently-constructed instances still
  // serialize against each other.
  __claudeCliProviderTestHooks.resetSharedClaudeCliGateForTests();
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  const makeBlockingDeps = (label: string) => ({
    async runClaudeCli() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${label}-start`);
      // Blocks on a shared latch (the timer) so both instances would overlap
      // here if they were not serialized by a shared gate.
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`${label}-end`);
      active -= 1;
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ is_error: false, result: "ok" }),
        stderr: "",
      };
    },
  });

  const responder = createClaudeCliProvider({ provider: "claude-cli", model: "opus" }, makeBlockingDeps("responder"));
  const judge = createClaudeCliProvider({ provider: "claude-cli", model: "opus" }, makeBlockingDeps("judge"));

  await Promise.all([responder.complete("respond to this"), judge.complete("judge this")]);

  assert.equal(maxActive, 1);
  assert.deepEqual(order, ["responder-start", "responder-end", "judge-start", "judge-end"]);
});

test("claude-cli provider concurrency can be raised explicitly above the default of 1", async () => {
  __claudeCliProviderTestHooks.resetSharedClaudeCliGateForTests();
  let active = 0;
  let maxActive = 0;
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus", concurrency: 2 },
    {
      async runClaudeCli() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "ok" }),
          stderr: "",
        };
      },
    },
  );

  await Promise.all([provider.complete("one"), provider.complete("two"), provider.complete("three")]);

  assert.equal(maxActive, 2);
});

test("claude-cli provider raising concurrency on one instance raises the shared limit for a second instance too", async () => {
  // Documents/verifies the "max across all instances, never shrinks" policy
  // from getSharedClaudeCliGate: once ANY constructed instance raises the
  // limit, every instance sharing the process-wide gate gets that higher
  // budget too — this is the intended, documented behavior for the
  // local-testing opt-out, not an isolation bug.
  __claudeCliProviderTestHooks.resetSharedClaudeCliGateForTests();
  let active = 0;
  let maxActive = 0;

  const makeDeps = () => ({
    async runClaudeCli() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        status: 0,
        signal: null,
        stdout: JSON.stringify({ is_error: false, result: "ok" }),
        stderr: "",
      };
    },
  });

  const raised = createClaudeCliProvider({ provider: "claude-cli", model: "opus", concurrency: 2 }, makeDeps());
  const defaulted = createClaudeCliProvider({ provider: "claude-cli", model: "opus" }, makeDeps());

  await Promise.all([raised.complete("one"), defaulted.complete("two")]);

  assert.equal(maxActive, 2);
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

test("claude-cli provider discovery reports the configured model", async () => {
  let versionChecked = false;
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeVersion() {
        versionChecked = true;
        return { status: 0, stderr: "" };
      },
    },
  );

  const models = await provider.discover?.();

  assert.equal(versionChecked, true);
  assert.deepEqual(models, [
    {
      id: "opus",
      name: "opus (Claude CLI)",
      contextLength: 0,
      capabilities: ["completion"],
    },
  ]);
});

test("claude-cli provider discovery fails loudly when the CLI is missing", async () => {
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeVersion() {
        return { status: 127, stderr: "command not found" };
      },
    },
  );

  await assert.rejects(provider.discover?.() as Promise<unknown>, /Claude CLI discovery failed/);
});

test("claude-cli command terminates subprocess when aborted", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-claude-cli-test-"));
  const controller = new AbortController();

  try {
    const run = __claudeCliProviderTestHooks.runClaudeCliCommand({
      executable: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
      input: "hello",
      cwd: tempDir,
      timeoutMs: 60_000,
      signal: controller.signal,
      env: process.env,
    });

    setTimeout(() => controller.abort(), 20);
    const result = await run;

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Claude CLI aborted by benchmark timeout/);
    assert.equal(__claudeCliProviderTestHooks.getActiveClaudeCliChildCount(), 0);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("claude-cli parent cleanup terminates active subprocesses", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "remnic-claude-cli-test-"));

  try {
    const run = __claudeCliProviderTestHooks.runClaudeCliCommand({
      executable: process.execPath,
      args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
      input: "hello",
      cwd: tempDir,
      timeoutMs: 60_000,
      env: process.env,
    });

    assert.equal(__claudeCliProviderTestHooks.getActiveClaudeCliChildCount(), 1);
    __claudeCliProviderTestHooks.terminateActiveClaudeCliChildren("SIGTERM");

    const result = await run;

    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(__claudeCliProviderTestHooks.getActiveClaudeCliChildCount(), 0);
  } finally {
    __claudeCliProviderTestHooks.terminateActiveClaudeCliChildren("SIGKILL");
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("claude-cli benchmark prompt carries only the user payload (system prompt goes via --append-system-prompt)", () => {
  const prompt = __claudeCliProviderTestHooks.buildClaudeCompletionPrompt("USER_CONTEXT: answer this");

  const json = prompt.slice(prompt.indexOf("{"));
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, {
    userPrompt: "USER_CONTEXT: answer this",
  });
});

test("claude-cli buildClaudeCliArgs passes systemPrompt via --append-system-prompt, trimmed", () => {
  const { buildClaudeCliArgs } = __claudeCliProviderTestHooks;

  const withPrompt = buildClaudeCliArgs({ provider: "claude-cli", model: "opus" }, "  judge this carefully  ");
  assert.deepEqual(withPrompt.slice(-2), ["--append-system-prompt", "judge this carefully"]);

  const withoutPrompt = buildClaudeCliArgs({ provider: "claude-cli", model: "opus" }, undefined);
  assert.ok(!withoutPrompt.includes("--append-system-prompt"));

  const withBlankPrompt = buildClaudeCliArgs({ provider: "claude-cli", model: "opus" }, "   ");
  assert.ok(!withBlankPrompt.includes("--append-system-prompt"));

  assert.deepEqual(withPrompt.slice(0, -2), [
    "--print",
    "--model",
    "opus",
    "--output-format",
    "json",
    "--input-format",
    "text",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    "",
    "--no-session-persistence",
  ]);
});

test("claude-cli buildClaudeCliArgs always includes --no-session-persistence (verified real flag, claude -p --help v2.1.202)", () => {
  const { buildClaudeCliArgs } = __claudeCliProviderTestHooks;

  assert.ok(buildClaudeCliArgs({ provider: "claude-cli", model: "opus" }).includes("--no-session-persistence"));
});

test("claude-cli buildIsolatedClaudeEnv forwards opts.maxTokens as CLAUDE_CODE_MAX_OUTPUT_TOKENS", () => {
  const { buildIsolatedClaudeEnv } = __claudeCliProviderTestHooks;

  const withMaxTokens = buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }, 50);
  assert.equal(withMaxTokens.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "50");

  // Fractional values are floored to an integer token count.
  const withFractionalMaxTokens = buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }, 50.9);
  assert.equal(withFractionalMaxTokens.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "50");
});

test("claude-cli buildIsolatedClaudeEnv omits CLAUDE_CODE_MAX_OUTPUT_TOKENS when maxTokens is absent or invalid", () => {
  const { buildIsolatedClaudeEnv } = __claudeCliProviderTestHooks;

  assert.equal(
    buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    undefined,
  );
  assert.equal(
    buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }, 0).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    undefined,
  );
  assert.equal(
    buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }, -5).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    undefined,
  );
  assert.equal(
    buildIsolatedClaudeEnv({ provider: "claude-cli", model: "opus" }, Number.NaN).CLAUDE_CODE_MAX_OUTPUT_TOKENS,
    undefined,
  );
});

test("claude-cli provider forwards opts.maxTokens through to the child process env end to end", async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const provider = createClaudeCliProvider(
    { provider: "claude-cli", model: "opus" },
    {
      async runClaudeCli(request) {
        capturedEnv = request.env;
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ is_error: false, result: "ok" }),
          stderr: "",
        };
      },
    },
  );

  await provider.complete("hello", { maxTokens: 128 });

  assert.equal(capturedEnv?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("claude-cli parseClaudeCliJsonResult treats non-object JSON as an error blob (no TypeError)", () => {
  const { parseClaudeCliJsonResult } = __claudeCliProviderTestHooks;
  for (const stdout of ["null", "42", "\"a string\"", "[1,2,3]"]) {
    const parsed = parseClaudeCliJsonResult(stdout);
    assert.equal(parsed.is_error, true, `expected non-object JSON ${stdout} to become an error blob`);
  }
  const ok = parseClaudeCliJsonResult(JSON.stringify({ is_error: false, result: "hi" }));
  assert.equal(ok.is_error, false);
  assert.equal(ok.result, "hi");
});

test("claude-cli provider backs off on a zero-exit empty result whose quota text is only on stderr", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];
  const originalSetTimeout = global.setTimeout;
  // @ts-expect-error -- test-only monkeypatch of the provider's sleep timer.
  global.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
    sleepCalls.push(ms ?? 0);
    return originalSetTimeout(fn, 0);
  }) as typeof setTimeout;
  try {
    const provider = createClaudeCliProvider(
      { provider: "claude-cli", model: "opus", retryOptions: { maxAttempts: 1, max429WaitMs: 5 * 60_000 } },
      {
        async runClaudeCli() {
          attempts += 1;
          if (attempts === 1) {
            // zero exit, is_error unset, empty result — quota only on stderr.
            return {
              status: 0,
              signal: null,
              stdout: JSON.stringify({ is_error: false, result: "" }),
              stderr: "Claude AI usage limit reached, resets at 5pm",
            };
          }
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify({ is_error: false, result: "recovered after empty usage-limit" }),
            stderr: "",
          };
        },
      },
    );
    const result = await provider.complete("hello");
    assert.equal(result.text, "recovered after empty usage-limit");
    assert.equal(attempts, 2);
    assert.equal(sleepCalls.length, 1);
    assert.ok(sleepCalls[0] >= 60_000, `expected a usage-limit backoff, got ${sleepCalls[0]}ms`);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("claude-cli provider forwards CLAUDE_CODE_OAUTH_TOKEN but still drops ANTHROPIC_API_KEY", async () => {
  const seededEnv: Record<string, string> = {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-should-forward",
    ANTHROPIC_API_KEY: "ambient-secret-should-not-leak",
  };
  const previousEnv = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(seededEnv)) {
    previousEnv.set(k, process.env[k]);
    process.env[k] = v;
  }
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  try {
    const provider = createClaudeCliProvider(
      { provider: "claude-cli", model: "opus" },
      {
        async runClaudeCli(request) {
          capturedEnv = request.env;
          return { status: 0, signal: null, stdout: JSON.stringify({ is_error: false, result: "ok" }), stderr: "" };
        },
      },
    );
    await provider.complete("hello");
    assert.equal(capturedEnv?.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token-should-forward");
    assert.equal(capturedEnv?.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const [k, v] of previousEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
