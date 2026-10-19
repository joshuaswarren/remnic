/**
 * Correction classify completion: short timeout, caller abort, gateway fallback.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isAbortError } from "../abort-error.js";
import type { PluginConfig } from "../types.js";
import { type CorrectionClassifyDeps, completeCorrectionClassify } from "./correction-classify.js";

const MESSAGES = [{ role: "user" as const, content: "the old fact is a duplicate" }];

function config(over: Partial<PluginConfig> = {}): PluginConfig {
  return {
    localLlmEnabled: true,
    localLlmFallback: true,
    modelSource: "plugin",
    correctionClassifyTimeoutMs: 40,
    ...over,
  } as PluginConfig;
}

function hangUntilAbort(): CorrectionClassifyDeps["localLlm"] {
  return {
    chatCompletion: (_messages, options) =>
      new Promise((resolve) => {
        const finish = () => resolve(null);
        if (options?.signal?.aborted) {
          finish();
          return;
        }
        options?.signal?.addEventListener("abort", finish, { once: true });
      }),
  };
}

test("classify falls back after the local attempt times out", async () => {
  let fallbackCalls = 0;
  let localSignal: AbortSignal | undefined;
  const deps: CorrectionClassifyDeps = {
    config: config(),
    localLlm: {
      chatCompletion: (_messages, options) =>
        new Promise((resolve) => {
          localSignal = options?.signal;
          const finish = () => resolve(null);
          if (options?.signal?.aborted) {
            finish();
            return;
          }
          options?.signal?.addEventListener("abort", finish, { once: true });
        }),
    },
    fallbackChat: async () => {
      fallbackCalls += 1;
      return { content: '{"classification":"outdated","confidence":0.8,"actions":[]}', modelUsed: "gateway" };
    },
  };
  const content = await completeCorrectionClassify(MESSAGES, deps);
  assert.equal(fallbackCalls, 1);
  assert.equal(localSignal?.aborted, true);
  assert.match(content ?? "", /outdated/);
});

test("classify cancels on caller abort and does not call the fallback", async () => {
  let fallbackCalls = 0;
  const caller = new AbortController();
  const deps: CorrectionClassifyDeps = {
    config: config({ correctionClassifyTimeoutMs: 30_000 }),
    localLlm: hangUntilAbort(),
    fallbackChat: async () => {
      fallbackCalls += 1;
      return { content: "should-not-run", modelUsed: "gateway" };
    },
  };
  const pending = completeCorrectionClassify(MESSAGES, deps, caller.signal);
  caller.abort();
  await assert.rejects(pending, (err: unknown) => isAbortError(err));
  assert.equal(fallbackCalls, 0);
});

test("classify uses the fallback when the local LLM returns null", async () => {
  let localCalls = 0;
  let fallbackCalls = 0;
  const deps: CorrectionClassifyDeps = {
    config: config(),
    localLlm: {
      chatCompletion: async () => {
        localCalls += 1;
        return null;
      },
    },
    fallbackChat: async () => {
      fallbackCalls += 1;
      return { content: '{"ok":true}', modelUsed: "gateway" };
    },
  };
  const content = await completeCorrectionClassify(MESSAGES, deps);
  assert.equal(localCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(content, '{"ok":true}');
});

test("classify does not call the fallback when the local LLM returns content", async () => {
  let fallbackCalls = 0;
  const deps: CorrectionClassifyDeps = {
    config: config(),
    localLlm: { chatCompletion: async () => ({ content: "local-json" }) },
    fallbackChat: async () => {
      fallbackCalls += 1;
      return { content: "gateway", modelUsed: "gateway" };
    },
  };
  assert.equal(await completeCorrectionClassify(MESSAGES, deps), "local-json");
  assert.equal(fallbackCalls, 0);
});

test("gateway modelSource skips the local LLM", async () => {
  let localCalls = 0;
  const deps: CorrectionClassifyDeps = {
    config: config({ modelSource: "gateway", localLlmEnabled: true }),
    localLlm: {
      chatCompletion: async () => {
        localCalls += 1;
        return { content: "local" };
      },
    },
    fallbackChat: async () => ({ content: "gateway-primary", modelUsed: "gateway" }),
  };
  assert.equal(await completeCorrectionClassify(MESSAGES, deps), "gateway-primary");
  assert.equal(localCalls, 0);
});

test("no configured gateway models return null without waiting out the classify timeout", async () => {
  const started = Date.now();
  const content = await completeCorrectionClassify(MESSAGES, {
    config: config({ localLlmEnabled: false }),
    localLlm: {
      chatCompletion: async () => {
        throw new Error("local must not run");
      },
    },
  });
  assert.equal(content, null);
  assert.ok(Date.now() - started < 1000, `no-models path took ${Date.now() - started}ms`);
});

test("a fallback attempt timeout returns null instead of an abort", async () => {
  const deps: CorrectionClassifyDeps = {
    config: config({ localLlmEnabled: false, correctionClassifyTimeoutMs: 40 }),
    localLlm: {
      chatCompletion: async () => {
        throw new Error("local must not run");
      },
    },
    fallbackChat: (_messages, options) =>
      new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error("fallback attempt aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (options.signal?.aborted) {
          fail();
          return;
        }
        options.signal?.addEventListener("abort", fail, { once: true });
      }),
  };
  assert.equal(await completeCorrectionClassify(MESSAGES, deps), null);
});

test("localLlmFallback false does not call the gateway after a local miss", async () => {
  let fallbackCalls = 0;
  const deps: CorrectionClassifyDeps = {
    config: config({ localLlmFallback: false }),
    localLlm: { chatCompletion: async () => null },
    fallbackChat: async () => {
      fallbackCalls += 1;
      return { content: "nope", modelUsed: "gateway" };
    },
  };
  await assert.rejects(() => completeCorrectionClassify(MESSAGES, deps), /fallback disabled/);
  assert.equal(fallbackCalls, 0);
});
