import assert from "node:assert/strict";
import test from "node:test";
import { parseLocalLlmConfig } from "./local-llm-config.js";

test("#2964: parseLocalLlmConfig round-trips a free-form localLlmHeaders key", () => {
  const parsed = parseLocalLlmConfig(
    {
      localLlmHeaders: {
        "X-Remnic-Canary": "alpha-9",
        Authorization: "Bearer x",
        drop: 1,
      },
    },
    undefined,
    (value) => value,
  );
  assert.deepEqual(parsed.localLlmHeaders, {
    "X-Remnic-Canary": "alpha-9",
    Authorization: "Bearer x",
  });
});
