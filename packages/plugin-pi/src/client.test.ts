import assert from "node:assert/strict";
import test from "node:test";

import { RemnicClient } from "./client.js";
import type { RemnicPiConfig } from "./config.js";

test("RemnicClient reports request timeouts with actionable context", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new RemnicClient({ ...baseConfig(), requestTimeoutMs: 1 });

  await assert.rejects(
    () => client.health(),
    /Remnic request timed out after 1ms/,
  );
});

function baseConfig(): RemnicPiConfig {
  return {
    remnicDaemonUrl: "http://127.0.0.1:4318",
    recallMode: "auto",
    recallTopK: 8,
    recallBudgetChars: 12000,
    recallEnabled: true,
    observeEnabled: true,
    observeSkipExtraction: false,
    compactionEnabled: true,
    mcpToolsEnabled: true,
    statusEnabled: true,
    requestTimeoutMs: 60000,
  };
}
