import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "./config.js";
import type { LocalLlmChatCompletionOptions } from "./local-llm-helpers.js";
import {
  LocalLlmConcurrencyLimiter,
  LocalLlmRateLimitSession,
  computeFullJitterBackoffMs,
  computeRateLimitDelayMs,
  endpointBackoffRemainingMs,
  extendEndpointBackoff,
  isRateLimitedResponse,
  parseRetryAfterMs,
  parseTryAgainHintMs,
  resetLocalLlmRateLimitStateForTests,
  resolveRateLimitSettings,
} from "./local-llm-rate-limit.js";
import { LocalLlmClient } from "./local-llm.js";
import type { PluginConfig } from "./types.js";

/**
 * COS-447: a saturated LiteLLM proxy answered `429 No deployments available`
 * and the client returned at once, so caller loops re-fired immediately
 * (2,400+ calls/h). These tests pin backoff, Retry-After, the retry cap, the
 * process-wide endpoint deadline, and the concurrency cap.
 */

const LITELLM_429 = JSON.stringify({
  error: {
    message:
      "No deployments available for selected model, Try again in 60 seconds. Passed model=m. pre-call-checks=True, cooldown_list=['a', 'b']",
  },
});

type RateLimitTestOverrides = Partial<Record<"localLlmUrl", string>> &
  Partial<
    Record<
      | "localLlmRetry5xxCount"
      | "localLlmRateLimitRetryCount"
      | "localLlmRateLimitBackoffMaxMs"
      | "localLlmMaxConcurrency",
      number
    >
  >;

function createConfig(overrides: RateLimitTestOverrides = {}): PluginConfig {
  return parseConfig({
    memoryDir: "/tmp/remnic-cos-447-rate-limit-test",
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmTimeoutMs: 5_000,
    localLlmRetry5xxCount: 0,
    localLlmRetryBackoffMs: 1,
    localLlmAuthHeader: false,
    localLlmRateLimitRetryCount: 3,
    localLlmRateLimitBackoffBaseMs: 1,
    localLlmRateLimitBackoffMaxMs: 20,
    localLlmMaxConcurrency: 4,
    ...overrides,
  });
}

function ok(content = "ok"): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const DEFAULT_429_BODY = JSON.stringify({ error: { message: "No deployments available for selected model." } });

function rateLimited(status = 429, headers: Record<string, string> = {}, body = DEFAULT_429_BODY): Response {
  return new Response(body, { status, headers: { "content-type": "application/json", ...headers } });
}

function modelsResponse(): Response {
  return new Response(JSON.stringify({ object: "list", data: [{ id: "test-local-model", object: "model" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Route chat completions to `chat`; answer availability probes with a model list. */
async function withFetch(chat: () => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes("/chat/completions") ? chat() : modelsResponse();
  };
  resetLocalLlmRateLimitStateForTests();
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
    resetLocalLlmRateLimitStateForTests();
  }
}

function failureStatus(diag: LocalLlmChatCompletionOptions["failureDiag"]): number | undefined {
  const err = diag?.lastError;
  return err instanceof Error && "status" in err && Number.isInteger(err.status) ? Number(err.status) : undefined;
}

// ---- pure helpers ----------------------------------------------------------

test("classifies 429/503/408 and LiteLLM cooldown bodies as rate limits, not 400s", () => {
  assert.equal(isRateLimitedResponse(429, ""), true);
  assert.equal(isRateLimitedResponse(503, ""), true);
  assert.equal(isRateLimitedResponse(408, ""), true);
  assert.equal(isRateLimitedResponse(500, "No deployments available for selected model"), true);
  assert.equal(isRateLimitedResponse(500, "internal error"), false);
  assert.equal(isRateLimitedResponse(400, "Context Window exceeded ... fallbacks cooldown_list"), false);
  assert.equal(isRateLimitedResponse(502, ""), false);
});

test("parses Retry-After as delta-seconds or HTTP-date", () => {
  assert.equal(parseRetryAfterMs("5"), 5_000);
  assert.equal(parseRetryAfterMs(" 1.5 "), 1_500);
  const now = Date.parse("2026-10-26T00:00:00Z");
  assert.equal(parseRetryAfterMs("Mon, 26 Oct 2026 00:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfterMs("Sun, 25 Oct 2026 23:00:00 GMT", now), 0);
  assert.equal(parseRetryAfterMs("soon"), null);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("999999"), 10 * 60_000, "clamped to the sanity bound");
});

test("parses LiteLLM 'Try again in N seconds' body hint", () => {
  assert.equal(parseTryAgainHintMs(LITELLM_429), 60_000);
  assert.equal(parseTryAgainHintMs("try again in 250ms"), 250);
  assert.equal(parseTryAgainHintMs("Try again in 2 minutes"), 120_000);
  assert.equal(parseTryAgainHintMs("busy"), null);
});

test("full-jitter backoff grows exponentially and is capped", () => {
  const max = () => 0.999999;
  assert.equal(computeFullJitterBackoffMs(1, 100, 10_000, max), 99);
  assert.equal(computeFullJitterBackoffMs(2, 100, 10_000, max), 199);
  assert.equal(computeFullJitterBackoffMs(4, 100, 10_000, max), 799);
  assert.equal(computeFullJitterBackoffMs(20, 100, 10_000, max), 9_999);
  assert.equal(
    computeFullJitterBackoffMs(3, 100, 10_000, () => 0),
    0
  );
  for (let i = 0; i < 200; i += 1) {
    const v = computeFullJitterBackoffMs(3, 100, 10_000);
    assert.ok(v >= 0 && v < 400);
  }
});

test("server hint is a floor on the backoff delay", () => {
  const settings = { backoffBaseMs: 100, backoffMaxMs: 1_000 };
  assert.equal(
    computeRateLimitDelayMs(1, settings, 5_000, () => 0.5),
    5_000
  );
  assert.equal(
    computeRateLimitDelayMs(4, settings, 10, () => 0.5),
    400
  );
  assert.equal(
    computeRateLimitDelayMs(4, settings, null, () => 0.5),
    400
  );
});

test("settings default sanely and reject invalid values", () => {
  assert.deepEqual(resolveRateLimitSettings({}), {
    retryCount: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    maxConcurrency: 4,
  });
  const s = resolveRateLimitSettings({
    localLlmRateLimitRetryCount: -1,
    localLlmRateLimitBackoffBaseMs: 5_000,
    localLlmRateLimitBackoffMaxMs: 10,
    localLlmMaxConcurrency: 0,
  });
  assert.equal(s.retryCount, 3);
  assert.equal(s.backoffMaxMs, 5_000, "max never below base");
  assert.equal(s.maxConcurrency, 0);
});

test("limiter caps concurrency, serves high priority first, and drops aborted waiters", async () => {
  const limiter = new LocalLlmConcurrencyLimiter(1);
  const first = await limiter.acquire();
  assert.ok(first);
  const order: string[] = [];
  const low = limiter.acquire().then((r) => {
    order.push("low");
    return r;
  });
  const aborter = new AbortController();
  const aborted = limiter.acquire({ signal: aborter.signal });
  const high = limiter.acquire({ highPriority: true }).then((r) => {
    order.push("high");
    return r;
  });
  assert.equal(limiter.queued, 3);
  aborter.abort();
  assert.equal(await aborted, null);
  assert.equal(limiter.queued, 2);
  first();
  const highRelease = await high;
  assert.deepEqual(order, ["high"]);
  assert.equal(limiter.inFlight, 1);
  highRelease?.();
  (await low)?.();
  assert.deepEqual(order, ["high", "low"]);
  assert.equal(limiter.inFlight, 0);
});

// ---- client integration ----------------------------------------------------

test("429 is retried with backoff and then succeeds", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return calls === 1 ? rateLimited(429) : ok("after backoff");
    },
    async () => {
      const client = new LocalLlmClient(createConfig({ localLlmUrl: "http://127.0.0.1:1001" }));
      const result = await client.chatCompletion([{ role: "user", content: "x" }], { operation: "lcm-summarize" });
      assert.equal(result?.content, "after backoff");
      assert.equal(calls, 2);
    }
  );
});

test("Retry-After header delays the retry", async () => {
  const stamps: number[] = [];
  await withFetch(
    async () => {
      stamps.push(Date.now());
      return stamps.length === 1 ? rateLimited(503, { "retry-after": "1" }) : ok();
    },
    async () => {
      const client = new LocalLlmClient(
        createConfig({ localLlmUrl: "http://127.0.0.1:1002", localLlmRateLimitBackoffMaxMs: 5_000 })
      );
      const result = await client.chatCompletion([{ role: "user", content: "x" }]);
      assert.equal(result?.content, "ok");
      assert.equal(stamps.length, 2);
      assert.ok(stamps[1] - stamps[0] >= 950, `waited ${stamps[1] - stamps[0]}ms, expected >= 1000ms`);
    }
  );
});

test("rate-limit retries are capped and report status 429", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return rateLimited(429);
    },
    async () => {
      const client = new LocalLlmClient(
        createConfig({ localLlmUrl: "http://127.0.0.1:1003", localLlmRateLimitRetryCount: 2 })
      );
      const options: LocalLlmChatCompletionOptions = { failureDiag: {} };
      const result = await client.chatCompletion([{ role: "user", content: "x" }], options);
      assert.equal(result, null);
      assert.equal(calls, 3, "one initial attempt + 2 rate-limit retries");
      assert.equal(failureStatus(options.failureDiag), 429);
    }
  );
});

test("a server hint beyond the max skips the retry and gates every client on that endpoint", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return rateLimited(429, {}, LITELLM_429);
    },
    async () => {
      const url = "http://127.0.0.1:1004";
      const a = new LocalLlmClient(createConfig({ localLlmUrl: url }));
      const b = new LocalLlmClient(createConfig({ localLlmUrl: url }));
      assert.equal(await a.chatCompletion([{ role: "user", content: "x" }]), null);
      assert.equal(calls, 1, "60s hint > 20ms max: no immediate retry");
      assert.ok(endpointBackoffRemainingMs(`${url}/v1/chat/completions`) > 50_000);
      const options: LocalLlmChatCompletionOptions = { failureDiag: {} };
      assert.equal(await b.chatCompletion([{ role: "user", content: "y" }], options), null);
      assert.equal(calls, 1, "second client must not hit the proxy during the shared backoff");
      assert.equal(failureStatus(options.failureDiag), 429);
    }
  );
});

test("503 rate-limit retries do not consume the 5xx retry budget", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return calls < 3 ? rateLimited(503) : ok();
    },
    async () => {
      const client = new LocalLlmClient(
        createConfig({ localLlmUrl: "http://127.0.0.1:1005", localLlmRetry5xxCount: 0 })
      );
      assert.equal((await client.chatCompletion([{ role: "user", content: "x" }]))?.content, "ok");
      assert.equal(calls, 3);
    }
  );
});

test("400 responses are not treated as rate limits", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "Context Window exceeded" } }), { status: 400 });
    },
    async () => {
      const client = new LocalLlmClient(createConfig({ localLlmUrl: "http://127.0.0.1:1006" }));
      assert.equal(await client.chatCompletion([{ role: "user", content: "x" }]), null);
      assert.equal(calls, 1);
    }
  );
});

test("process-wide concurrency cap bounds in-flight requests across clients", async () => {
  let inFlight = 0;
  let peak = 0;
  await withFetch(
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 25));
      inFlight -= 1;
      return ok();
    },
    async () => {
      const config = createConfig({ localLlmUrl: "http://127.0.0.1:1007", localLlmMaxConcurrency: 2 });
      const clients = [new LocalLlmClient(config), new LocalLlmClient(config), new LocalLlmClient(config)];
      const results = await Promise.all(
        Array.from({ length: 7 }, (_, i) => clients[i % 3].chatCompletion(
          [{ role: "user", content: `q${i}` }],
          { priority: i % 2 === 0 ? "recall-critical" : "background" }
        ))
      );
      assert.equal(results.filter((r) => r?.content === "ok").length, 7);
      assert.equal(peak, 2);
    }
  );
});

test("rate-limit waits never exceed the caller's request timeout", async () => {
  let calls = 0;
  await withFetch(
    async () => {
      calls += 1;
      return rateLimited(429, { "retry-after": "2" });
    },
    async () => {
      const client = new LocalLlmClient(
        createConfig({ localLlmUrl: "http://127.0.0.1:1008", localLlmRateLimitBackoffMaxMs: 5_000 })
      );
      const started = Date.now();
      const options: LocalLlmChatCompletionOptions = { timeoutMs: 300, failureDiag: {} };
      assert.equal(await client.chatCompletion([{ role: "user", content: "x" }], options), null);
      assert.equal(await client.chatCompletion([{ role: "user", content: "y" }], { timeoutMs: 300 }), null);
      assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms despite a 300ms budget`);
      assert.equal(calls, 1, "a 2s hint beyond the 300ms budget is neither retried nor re-sent");
      assert.equal(failureStatus(options.failureDiag), 429);
    }
  );
});

test("a queued attempt rechecks a cooldown recorded while it waited for a slot", async () => {
  await withFetch(
    async () => ok(),
    async () => {
      const endpoint = "http://127.0.0.1:1009/v1/chat/completions";
      const settings = resolveRateLimitSettings(
        createConfig({ localLlmMaxConcurrency: 1, localLlmRateLimitBackoffMaxMs: 1_000 })
      );
      const holder = await new LocalLlmRateLimitSession(endpoint, settings, false).beforeAttempt();
      assert.equal(holder.kind, "go");
      const queued = new LocalLlmRateLimitSession(endpoint, settings, false, 5_000).beforeAttempt();
      extendEndpointBackoff(endpoint, 60_000);
      if (holder.kind === "go") holder.release();
      const gate = await queued;
      assert.equal(gate.kind, "skip");
      assert.equal(gate.kind === "skip" ? gate.reason : null, "backoff");
    }
  );
});

test("waiting for a concurrency slot is bounded by the wait budget", async () => {
  await withFetch(
    async () => ok(),
    async () => {
      const endpoint = "http://127.0.0.1:1010/v1/chat/completions";
      const settings = resolveRateLimitSettings(createConfig({ localLlmMaxConcurrency: 1 }));
      const holder = await new LocalLlmRateLimitSession(endpoint, settings, false).beforeAttempt();
      const started = Date.now();
      const gate = await new LocalLlmRateLimitSession(endpoint, settings, false, 50).beforeAttempt();
      assert.equal(gate.kind === "skip" ? gate.reason : gate.kind, "queue");
      assert.ok(Date.now() - started < 1_000);
      if (holder.kind === "go") holder.release();
    }
  );
});

test("limiter reserves one finite permit for recall-critical work", async () => {
  const limiter = new LocalLlmConcurrencyLimiter(2);
  const background = await limiter.acquire();
  const secondBackground = await limiter.acquire({ timeoutMs: 0 });
  try {
    assert.ok(background);
    assert.equal(secondBackground, null, "background must not consume the recall permit");
    const foreground = await limiter.acquire({ highPriority: true, timeoutMs: 0 });
    assert.ok(foreground, "recall must start without waiting for background completion");
    foreground();
    foreground();
    assert.equal(limiter.inFlight, 1, "release remains idempotent");
  } finally {
    secondBackground?.();
    background?.();
  }
});

test("reserved background queue survives aborts and responds to resizing", async () => {
  const limiter = new LocalLlmConcurrencyLimiter(2);
  const background = await limiter.acquire();
  assert.ok(background);
  const controller = new AbortController();
  const aborted = limiter.acquire({ signal: controller.signal });
  controller.abort();
  const abortedRelease = await aborted;
  abortedRelease?.();
  assert.equal(abortedRelease, null);
  const queued = limiter.acquire();
  const foreground = await limiter.acquire({ highPriority: true, timeoutMs: 0 });
  assert.ok(foreground);
  assert.equal(limiter.queued, 1);
  limiter.setMax(3);
  const nextBackground = await queued;
  assert.ok(nextBackground);
  assert.equal(limiter.inFlight, 3);
  nextBackground();
  background();
  foreground();
  assert.equal(limiter.inFlight, 0);
});

for (const max of [2, 4]) {
  test(`queued background work progresses under critical backlog at cap ${max}`, async () => {
    const limiter = new LocalLlmConcurrencyLimiter(max);
    const held = await Promise.all(Array.from({ length: max }, () => limiter.acquire({ highPriority: true })));
    assert.ok(held.every(Boolean));
    const controller = new AbortController();
    const backgroundRelease = limiter.acquire({ signal: controller.signal });
    const criticalBacklog = limiter.acquire({ highPriority: true, signal: controller.signal });
    try {
      assert.equal(limiter.queued, 2);
      held[0]?.();
      const background = await Promise.race([backgroundRelease, Promise.resolve(null)]);
      assert.ok(background, "background must get the released permit while critical work stays live");
      assert.equal(limiter.inFlight, max);
      assert.equal(limiter.queued, 1);
      background();
      const critical = await criticalBacklog;
      assert.ok(critical, "critical backlog resumes when background no longer needs its permit");
      critical();
    } finally {
      controller.abort();
      for (const release of [...held, ...await Promise.all([backgroundRelease, criticalBacklog])]) release?.();
    }
    assert.equal(limiter.inFlight, 0);
    assert.equal(limiter.queued, 0);
  });
}

test("one-permit and unlimited limits still admit background work", async () => {
  for (const max of [1, 0]) {
    const limiter = new LocalLlmConcurrencyLimiter(max);
    const first = await limiter.acquire({ timeoutMs: 0 });
    assert.ok(first);
    const second = await limiter.acquire({ timeoutMs: 0 });
    assert.equal(second === null, max === 1);
    second?.();
    first();
    assert.equal(limiter.inFlight, 0);
  }
});
