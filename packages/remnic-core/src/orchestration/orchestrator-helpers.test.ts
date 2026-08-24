import assert from "node:assert/strict";
import test from "node:test";

import type { SearchCollectionState } from "./orchestrator-helpers.js";
import { qmdStartupCollectionChecksWithTimeout } from "./startup-collection-checks.js";

test("startup collection batch falls back when an individual check never settles", async () => {
  const neverSettles = new Promise<{ namespace: string; state: SearchCollectionState }>(() => undefined);

  const states = await qmdStartupCollectionChecksWithTimeout(
    [neverSettles],
    ["default"],
    1,
  );

  assert.deepEqual(states, [{ namespace: "default", state: "unknown" }]);
});

test("startup collection batch preserves settled collection states", async () => {
  const states = await qmdStartupCollectionChecksWithTimeout(
    [Promise.resolve({ namespace: "default", state: "present" as const })],
    ["default"],
    50,
  );

  assert.deepEqual(states, [{ namespace: "default", state: "present" }]);
});
