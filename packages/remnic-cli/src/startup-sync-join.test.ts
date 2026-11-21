import assert from "node:assert/strict";
import test from "node:test";

import { joinStartupSyncOrWarn } from "./startup-sync-join.js";

test("a failed startup-sync join warns instead of silently querying a stale index", async () => {
  const warnings: string[] = [];
  const orchestrator = { joinStartupSearchSync: async () => false };
  await joinStartupSyncOrWarn(orchestrator, (message) => warnings.push(message));
  assert.equal(warnings.length, 1, "a false join surfaces exactly one stale-index warning");
  assert.match(warnings[0] ?? "", /stale index/);
});

test("a successful or unneeded startup-sync join warns nothing", async () => {
  const warnings: string[] = [];
  const orchestrator = { joinStartupSearchSync: async () => true };
  await joinStartupSyncOrWarn(orchestrator, (message) => warnings.push(message));
  assert.deepEqual(warnings, []);
});
