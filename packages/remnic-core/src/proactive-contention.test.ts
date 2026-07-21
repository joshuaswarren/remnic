import assert from "node:assert/strict";
import test from "node:test";

import { LocalLlmClient } from "./local-llm.js";
import { shouldRunProactivePass } from "./proactive-contention.js";
import type { PluginConfig } from "./types.js";

function proactiveConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    proactiveExtractionTimeoutMs: 2500,
    proactiveExtractionMaxTokens: 900,
    proactiveExtractionSkipWhenLocalLlmBusy: true,
    ...overrides,
  } as unknown as PluginConfig;
}

function fakeClient(contended: boolean): LocalLlmClient {
  return { isBackgroundLaneContended: () => contended } as unknown as LocalLlmClient;
}

test("shouldRunProactivePass: budget disables skip the pass", () => {
  const busy = fakeClient(true);
  assert.equal(shouldRunProactivePass(proactiveConfig(), 0, true, fakeClient(false)), false);
  assert.equal(
    shouldRunProactivePass(proactiveConfig({ proactiveExtractionTimeoutMs: 0 }), 2, true, fakeClient(false)),
    false,
  );
  assert.equal(
    shouldRunProactivePass(proactiveConfig({ proactiveExtractionMaxTokens: 0 }), 2, true, fakeClient(false)),
    false,
  );
  // A busy lane must not mask a budget disable either.
  assert.equal(shouldRunProactivePass(proactiveConfig({ proactiveExtractionMaxTokens: 0 }), 2, true, busy), false);
});

test("shouldRunProactivePass: skips only a local extraction against a busy background lane (issue #2011)", () => {
  // Local extractor + busy lane + gate on → skip.
  assert.equal(shouldRunProactivePass(proactiveConfig(), 2, true, fakeClient(true)), false);
  // Local extractor + idle lane → run.
  assert.equal(shouldRunProactivePass(proactiveConfig(), 2, true, fakeClient(false)), true);
  // Cloud extractor (no single-lane saturation) → run even if the local lane is busy.
  assert.equal(shouldRunProactivePass(proactiveConfig(), 2, false, fakeClient(true)), true);
  // Gate disabled → run even when the local lane is busy.
  assert.equal(
    shouldRunProactivePass(proactiveConfig({ proactiveExtractionSkipWhenLocalLlmBusy: false }), 2, true, fakeClient(true)),
    true,
  );
});

test("LocalLlmClient.isBackgroundLaneContended reflects background queue and in-flight state", () => {
  const client = new LocalLlmClient({
    localLlmEnabled: true,
    localLlmModel: "test-local-model",
    localLlmUrl: "http://127.0.0.1:1234",
    localLlmTimeoutMs: 1_000,
  } as unknown as PluginConfig);

  // Test seam: reach the client's private queue state to simulate lane occupancy.
  const internals = client as unknown as {
    requestQueues: Record<string, unknown[]>;
    queueProcessing: Set<string>;
  };

  assert.equal(client.isBackgroundLaneContended(), false);

  // A queued background request contends the lane.
  internals.requestQueues.background.push({});
  assert.equal(client.isBackgroundLaneContended(), true);
  internals.requestQueues.background.length = 0;
  assert.equal(client.isBackgroundLaneContended(), false);

  // An in-flight background request contends the lane too.
  internals.queueProcessing.add("background");
  assert.equal(client.isBackgroundLaneContended(), true);

  // A recall-critical request on the separate priority slot does not.
  internals.queueProcessing.clear();
  internals.queueProcessing.add("recall-critical");
  assert.equal(client.isBackgroundLaneContended(), false);
});
