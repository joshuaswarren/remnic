/**
 * Deep-recall policy LLM budget/cancellation regressions (issue #2915).
 *
 * One `timeoutMs` budget must span the local and fallback legs: the fallback
 * leg receives only what the local leg left on the clock, and never starts
 * once the budget is spent. The transport cancellation signal reaches both
 * legs. Deterministic: the local leg advances a patched clock instead of
 * sleeping (the same Date.now patch pattern access-service-recall-concurrency
 * uses).
 */

import test from "node:test";
import assert from "node:assert/strict";

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
    (err: unknown) => err instanceof Error && err.name === "AbortError",
    "cancellation after the local leg surfaces as a standard AbortError",
  );
  assert.equal(cancelled.fallbackCalls.length, 0);
});
