/**
 * Deep-recall policy LLM budget/cancellation regressions (issue #2915).
 *
 * One `timeoutMs` budget must span the local and fallback legs: the fallback
 * leg receives only what the local leg left on the clock, and never starts
 * once the budget is spent. A spent budget also starts neither leg. The
 * transport cancellation signal reaches both legs and rejects as AbortError
 * when the signal is already aborted, when abort lands during the local
 * leg, and when abort lands during the fallback. Deterministic: legs
 * advance a patched clock instead of sleeping.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { isAbortError } from "./abort-error.js";
import { parseConfig } from "./config.js";
import { callDeepRecallPolicyLlm } from "./deep-recall-policy-llm.js";
import type { FallbackLlmClient } from "./fallback-llm.js";
import type { LocalLlmClient } from "./local-llm.js";

interface CapturedCall {
  timeoutMs?: number;
  signal?: AbortSignal;
}

function fakeClients(input: {
  localBehavior?: (call: CapturedCall) => Promise<{ content: string } | null>;
  fallbackBehavior?: (call: CapturedCall) => Promise<{ content: string } | null>;
}): {
  localLlm: LocalLlmClient;
  fallbackLlm: FallbackLlmClient;
  localCalls: CapturedCall[];
  fallbackCalls: CapturedCall[];
} {
  const localCalls: CapturedCall[] = [];
  const fallbackCalls: CapturedCall[] = [];
  const localLlm = {
    chatCompletion: async (_messages: unknown, options: { timeoutMs?: number; signal?: AbortSignal }) => {
      const call = { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.signal ? { signal: options.signal } : {}) };
      localCalls.push(call);
      if (input.localBehavior) return input.localBehavior(call);
      return { content: "local-ok" };
    },
  } as unknown as LocalLlmClient;
  const fallbackLlm = {
    chatCompletion: async (_messages: unknown, options: { timeoutMs?: number; signal?: AbortSignal }) => {
      const call = { ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.signal ? { signal: options.signal } : {}) };
      fallbackCalls.push(call);
      if (input.fallbackBehavior) return input.fallbackBehavior(call);
      return { content: "fallback-ok" };
    },
  } as unknown as FallbackLlmClient;
  return { localLlm, fallbackLlm, localCalls, fallbackCalls };
}

test("one step timeout spans both legs: a spent budget never starts the fallback (issue #2915)", async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const { localLlm, fallbackLlm, fallbackCalls } = fakeClients({
      // The local leg burns the whole 50ms budget before failing.
      localBehavior: () => {
        clock += 60;
        return Promise.reject(new Error("local leg failed"));
      },
      fallbackBehavior: () => {
        throw new Error("the fallback must not start once the step budget is spent");
      },
    });
    const result = await callDeepRecallPolicyLlm({
      statePrompt: "state",
      config: parseConfig({}),
      localLlm,
      fallbackLlm,
      timeoutMs: 50,
    });
    assert.equal(result, null, "both legs failed/spent — the loop treats that as a stop");
    assert.equal(fallbackCalls.length, 0, "the fallback leg never restarted the step timeout");
  } finally {
    Date.now = realNow;
  }
});

test("the fallback leg receives only the budget the local leg left (issue #2915)", async () => {
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    const { localLlm, fallbackLlm, fallbackCalls } = fakeClients({
      localBehavior: () => {
        clock += 30;
        return Promise.reject(new Error("local leg failed"));
      },
      fallbackBehavior: () => Promise.resolve({ content: "fallback-ok" }),
    });
    const result = await callDeepRecallPolicyLlm({
      statePrompt: "state",
      config: parseConfig({}),
      localLlm,
      fallbackLlm,
      timeoutMs: 200,
    });
    assert.equal(result, "fallback-ok");
    assert.equal(fallbackCalls.length, 1);
    const fallbackTimeout = fallbackCalls[0]?.timeoutMs;
    assert.ok(
      fallbackTimeout !== undefined && fallbackTimeout > 0 && fallbackTimeout <= 170,
      `fallback timeout must be the remaining budget (got ${String(fallbackTimeout)}), not a restarted 200`,
    );
  } finally {
    Date.now = realNow;
  }
});

test("the cancellation signal reaches both legs and stops the fallback after abort (issue #2915)", async () => {
  // Part A — a live signal is forwarded to both legs' options.
  const live = fakeClients({
    localBehavior: () => Promise.reject(new Error("local leg failed")),
  });
  const liveController = new AbortController();
  const forwarded = await callDeepRecallPolicyLlm({
    statePrompt: "state",
    config: parseConfig({}),
    localLlm: live.localLlm,
    fallbackLlm: live.fallbackLlm,
    timeoutMs: 0,
    signal: liveController.signal,
  });
  assert.equal(forwarded, "fallback-ok");
  assert.equal(live.localCalls[0]?.signal, liveController.signal, "the local leg received the transport signal");
  assert.equal(live.fallbackCalls[0]?.signal, liveController.signal, "the fallback leg received the transport signal");

  // Part B — cancellation during the local leg stops before the fallback.
  const cancelled = fakeClients({
    localBehavior: () => {
      liveController.abort();
      return Promise.reject(new Error("local leg failed"));
    },
    fallbackBehavior: () => {
      throw new Error("the fallback must not run after cancellation");
    },
  });
  await assert.rejects(
    callDeepRecallPolicyLlm({
      statePrompt: "state",
      config: parseConfig({}),
      localLlm: cancelled.localLlm,
      fallbackLlm: cancelled.fallbackLlm,
      timeoutMs: 0,
      signal: liveController.signal,
    }),
    (err: unknown) => isAbortError(err),
    "cancellation after the local leg surfaces as a standard AbortError",
  );
  assert.equal(cancelled.fallbackCalls.length, 0);
});

test("a pre-aborted signal rejects before either policy leg (issue #2915)", async () => {
  const controller = new AbortController();
  controller.abort();
  const clients = fakeClients({
    localBehavior: () => {
      throw new Error("the local leg must not start after pre-abort");
    },
    fallbackBehavior: () => {
      throw new Error("the fallback leg must not start after pre-abort");
    },
  });
  await assert.rejects(
    callDeepRecallPolicyLlm({
      statePrompt: "state",
      config: parseConfig({}),
      localLlm: clients.localLlm,
      fallbackLlm: clients.fallbackLlm,
      timeoutMs: 0,
      signal: controller.signal,
    }),
    (err: unknown) => isAbortError(err),
    "pre-aborted policy call surfaces as a standard AbortError",
  );
  assert.equal(clients.localCalls.length, 0, "the local leg never started");
  assert.equal(clients.fallbackCalls.length, 0, "the fallback leg never started");
});

test("abort during the fallback leg rejects as AbortError instead of null (issue #2915)", async () => {
  const controller = new AbortController();
  const clients = fakeClients({
    localBehavior: () => Promise.reject(new Error("local leg failed")),
    fallbackBehavior: () => {
      controller.abort();
      return Promise.reject(new Error("fallback failed after abort"));
    },
  });
  await assert.rejects(
    callDeepRecallPolicyLlm({
      statePrompt: "state",
      config: parseConfig({}),
      localLlm: clients.localLlm,
      fallbackLlm: clients.fallbackLlm,
      timeoutMs: 0,
      signal: controller.signal,
    }),
    (err: unknown) => isAbortError(err),
    "cancellation during the fallback leg is not converted to null",
  );
  assert.equal(clients.fallbackCalls.length, 1, "the fallback leg started before abort");
});

test("a spent shared budget starts neither local nor fallback (issue #2915)", async () => {
  const realNow = Date.now;
  const config = parseConfig({});
  let clock = 1_000_000;
  Date.now = () => {
    const now = clock;
    clock += 100;
    return now;
  };
  try {
    const { localLlm, fallbackLlm, localCalls, fallbackCalls } = fakeClients({
      localBehavior: () => {
        throw new Error("the local leg must not start once the step budget is spent");
      },
      fallbackBehavior: () => {
        throw new Error("the fallback leg must not start once the step budget is spent");
      },
    });
    const result = await callDeepRecallPolicyLlm({
      statePrompt: "state",
      config,
      localLlm,
      fallbackLlm,
      timeoutMs: 50,
    });
    assert.equal(result, null, "exhausted budget is a stop, not an unbounded call");
    assert.equal(localCalls.length, 0, "the local leg never started without a timeout");
    assert.equal(fallbackCalls.length, 0, "the fallback leg never started");
  } finally {
    Date.now = realNow;
  }
});
