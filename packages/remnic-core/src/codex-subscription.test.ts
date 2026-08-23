import assert from "node:assert/strict";
import test from "node:test";

import { callCodexCliFallback, setCodexCliFallbackRunnerForProcess } from "./cli-fallback.js";
import {
  CODEX_SUBSCRIPTION_PROVIDER_ID,
  CodexSubscriptionAuthError,
  CodexSubscriptionConfigError,
  __codexSubscriptionTestHooks,
  createCodexSubscriptionRunner,
  ensureCodexSubscriptionRunnerRegistered,
} from "./codex-subscription.js";
import { parseConfig } from "./config.js";
import { FallbackLlmClient } from "./fallback-llm.js";
import { initLogger, resetLogger } from "./logger.js";
import { clearModelsJsonCache } from "./models-json.js";
import { clearSecretCache } from "./resolve-provider-secret.js";

interface FakeOutput {
  status: number | null;
  stdout?: string;
  stderr?: string;
}

function okLogin(): FakeOutput {
  return { status: 0, stdout: "Logged in using ChatGPT\n" };
}

function okExec(text: string): FakeOutput & { outputText: string } {
  return {
    status: 0,
    stdout: `{"type":"turn.completed","usage":{"input_tokens":40,"output_tokens":20}}\n`,
    stderr: "",
    outputText: text,
  };
}

function makeRunner(
  options: {
    login?: FakeOutput;
    exec?: FakeOutput & { outputText?: string };
    loginCalls?: { executable: string; env: NodeJS.ProcessEnv }[];
    execCalls?: unknown[];
  } = {}
) {
  return createCodexSubscriptionRunner({
    env: {
      HOME: "/home/alice",
      PATH: "/usr/bin:/bin",
      CODEX_HOME: "/home/alice/.codex",
      OPENAI_API_KEY: "sk-ambient-must-not-forward",
      OPENAI_BASE_URL: "https://ambient.example/v1",
    },
    runLoginStatus: async (executable, env) => {
      options.loginCalls?.push({ executable, env });
      const out = options.login ?? okLogin();
      return { status: out.status, stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    },
    runCodexExec: async (request) => {
      options.execCalls?.push(request);
      const out = options.exec ?? okExec("fake final answer");
      return {
        status: out.status,
        stdout: out.stdout ?? "",
        stderr: out.stderr ?? "",
        outputText: out.outputText ?? "",
      };
    },
  });
}

function withRunner(runner: ReturnType<typeof makeRunner>, body: () => Promise<void>): Promise<void> {
  const restore = setCodexCliFallbackRunnerForProcess(runner);
  return body().finally(restore);
}

test("codex-subscription success normalizes through CodexCliFallbackResult", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const loginCalls: { executable: string; env: NodeJS.ProcessEnv }[] = [];
  const execCalls: unknown[] = [];
  const runner = makeRunner({ loginCalls, execCalls });

  await withRunner(runner, async () => {
    const result = await callCodexCliFallback(
      { executable: "codex-fake", reasoningEffort: "high" },
      "gpt-5.6-luna",
      [
        { role: "system", content: "extract facts as JSON" },
        { role: "user", content: "the user prefers dark mode" },
      ],
      { timeoutMs: 5_000 }
    );

    assert.equal(result.content, "fake final answer");
    assert.equal(result.usage?.inputTokens, 40);
    assert.equal(result.usage?.outputTokens, 20);
    assert.equal(result.usage?.totalTokens, 60);

    assert.equal(loginCalls.length, 1);
    assert.equal(loginCalls[0]?.executable, "codex-fake");
    // Ambient OpenAI credentials must not reach the child: the subscription
    // login — not an API key — has to authenticate the request.
    assert.equal(loginCalls[0]?.env.OPENAI_API_KEY, undefined);
    assert.equal(loginCalls[0]?.env.OPENAI_BASE_URL, undefined);
    assert.equal(loginCalls[0]?.env.CODEX_HOME, "/home/alice/.codex");

    assert.equal(execCalls.length, 1);
    const request = execCalls[0] as {
      args: string[];
      input: string;
      env: NodeJS.ProcessEnv;
      timeoutMs?: number;
    };
    assert.equal(request.env.OPENAI_API_KEY, undefined);
    assert.equal(request.timeoutMs, 5_000);
    const args = request.args.join(" ");
    assert.match(args, /--model gpt-5\.6-luna/);
    assert.match(args, /model_reasoning_effort="high"/);
    assert.match(args, /--sandbox read-only/);
    assert.match(args, /--ephemeral/);
    assert.match(args, /--output-last-message/);
    assert.match(request.input, /\[system\]\nextract facts as JSON/);
    assert.match(request.input, /\[user\]\nthe user prefers dark mode/);
  });
});

test("unauthenticated login surfaces actionable codex login guidance", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const runner = makeRunner({
    login: { status: 1, stdout: "Not logged in.\nprivate-login-detail" },
  });

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }]),
      (error: unknown) => {
        assert.ok(error instanceof CodexSubscriptionAuthError);
        assert.equal(error.reason, "unauthenticated");
        assert.match(error.message, /codex login/);
        // Raw login-status output stays out of the surfaced error.
        assert.equal(error.message.includes("private-login-detail"), false);
        return true;
      }
    );
  });
});

test("api-key login is reported as needing a ChatGPT login", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const runner = makeRunner({
    login: { status: 0, stdout: "Logged in using an API key.\n" },
  });

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }]),
      (error: unknown) => {
        assert.ok(error instanceof CodexSubscriptionAuthError);
        assert.equal(error.reason, "unauthenticated");
        assert.match(error.message, /ChatGPT login/);
        return true;
      }
    );
  });
});

test("expired or revoked session surfaces reauth guidance and clears the login cache", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const loginCalls: { executable: string; env: NodeJS.ProcessEnv }[] = [];
  const execCalls: unknown[] = [];
  const runner = makeRunner({
    loginCalls,
    execCalls,
    exec: { status: 1, stderr: "error: stream disconnected: 401 Unauthorized (token expired)\n" },
  });

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }]),
      (error: unknown) => {
        assert.ok(error instanceof CodexSubscriptionAuthError);
        assert.equal(error.reason, "expired_or_revoked");
        assert.match(error.message, /codex login/);
        return true;
      }
    );
    // The auth failure must invalidate the cached login status so a re-login
    // is picked up by the very next request.
    await assert.rejects(callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }]));
    assert.equal(loginCalls.length, 2);
    assert.equal(execCalls.length, 2);
  });
});

test("timeout keeps a distinct provider error type", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const runner = makeRunner({
    exec: { status: 124, stderr: "codex-subscription: exec timed out after 5000ms.\n" },
  });

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }], {
        timeoutMs: 5_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError");
        assert.match(error.message, /timed out after 5000ms/);
        return true;
      }
    );
  });
});

test("caller abort reason is preserved, not reclassified", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const runner = makeRunner();
  const controller = new AbortController();
  const reason = new Error("planner cancelled");
  controller.abort(reason);

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }], {
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.equal(error, reason);
        return true;
      }
    );

    // Abort without a reason keeps the AbortError contract.
    const bare = new AbortController();
    bare.abort();
    await assert.rejects(
      callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }], {
        signal: bare.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "AbortError");
        return true;
      }
    );
  });
});

test("apiKey config is rejected without echoing the value", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const runner = makeRunner();

  await withRunner(runner, async () => {
    await assert.rejects(
      callCodexCliFallback({ apiKey: "sk-should-never-echo" }, "gpt-5.6-luna", [{ role: "user", content: "hi" }]),
      (error: unknown) => {
        assert.ok(error instanceof CodexSubscriptionConfigError);
        assert.match(error.message, /does not accept apiKey/);
        assert.equal(error.message.includes("sk-should-never-echo"), false);
        return true;
      }
    );
  });
});

test("secret-shaped child output is redacted from errors and logs", async () => {
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  const lines: string[] = [];
  initLogger(
    {
      info: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
      debug: (message) => lines.push(message),
    },
    true,
    { timestamps: false }
  );
  const runner = makeRunner({
    exec: {
      status: 2,
      stderr:
        "error: request rejected\nauthorization: Bearer eyJhbGciOiJ9.fake.jwt.payload.1234567890\nkey: sk-live-abcdefgh12345678\n",
    },
  });

  try {
    await withRunner(runner, async () => {
      await assert.rejects(
        callCodexCliFallback({}, "gpt-5.6-luna", [{ role: "user", content: "hi" }]),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          const message = error.message;
          assert.equal(message.includes("sk-live-abcdefgh12345678"), false);
          assert.equal(message.includes("eyJhbGciOiJ9"), false);
          assert.match(message, /\[redacted\]/);
          return true;
        }
      );
    });
    assert.equal(
      lines.some((line) => line.includes("sk-live-abcdefgh12345678")),
      false,
      "logs must not contain the echoed API key"
    );
    assert.equal(
      lines.some((line) => line.includes("eyJhbGciOiJ9")),
      false,
      "logs must not contain the echoed bearer token"
    );
  } finally {
    resetLogger();
  }
});

test("built-in codex-subscription provider routes through FallbackLlmClient", { concurrency: false }, async () => {
  clearModelsJsonCache();
  clearSecretCache();
  __codexSubscriptionTestHooks.resetLoginStatusCache();
  __codexSubscriptionTestHooks.resetCoreRunnerRegistered();
  const execCalls: unknown[] = [];
  const runner = makeRunner({ execCalls });

  const restore = setCodexCliFallbackRunnerForProcess(runner);
  try {
    // A pre-registered runner (host/benchmark) must win; ensure registers nothing.
    assert.equal(ensureCodexSubscriptionRunnerRegistered(), false);

    const llm = new FallbackLlmClient({
      agents: { defaults: { model: { primary: `${CODEX_SUBSCRIPTION_PROVIDER_ID}/gpt-5.6-luna` } } },
    });
    const response = await llm.chatCompletion([{ role: "user", content: "remember this" }]);
    assert.equal(response?.content, "fake final answer");
    assert.equal(response?.modelUsed, "codex-subscription/gpt-5.6-luna");
    assert.equal(execCalls.length, 1);
  } finally {
    restore();
    clearModelsJsonCache();
    clearSecretCache();
  }
});

test("existing API-key provider config still parses", () => {
  const parsed = parseConfig({ openaiApiKey: "sk-existing-key", model: "gpt-5.5" });
  assert.equal(parsed.modelSource, "plugin");
  assert.equal(parsed.openaiApiKey, "sk-existing-key");
  assert.equal(parsed.model, "gpt-5.5");
});
