import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryFlushPlan } from "./memory-flush-plan.js";

test("flush plan keeps relativePath and scopes writeRestrictPrefix to plugin state", () => {
  const plan = buildMemoryFlushPlan({ serviceId: "openclaw-remnic" });
  const prompts = `${plan.prompt}\n${plan.systemPrompt}`;

  assert.equal(plan.relativePath, "state/plugins/openclaw-remnic/flush-plan.md");
  assert.equal(plan.writeRestrictPrefix, "state/plugins/openclaw-remnic/");
  assert.match(prompts, /flush-plan file/i);
  assert.match(prompts, /dated memory paths/i);
  assert.match(prompts, /credentials/i);
  assert.doesNotMatch(prompts, /\bonly\b/i);
});
