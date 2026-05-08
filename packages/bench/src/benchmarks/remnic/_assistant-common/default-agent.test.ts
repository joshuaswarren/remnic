import assert from "node:assert/strict";
import test from "node:test";

import { buildAssistantResponderPrompt } from "./default-agent.js";

test("buildAssistantResponderPrompt preserves prompt and asks for grounded synthesis", () => {
  const prompt = buildAssistantResponderPrompt("What should I do next?");

  assert.match(prompt, /^What should I do next\?/);
  assert.match(prompt, /Use only the supplied Remnic memory context/);
  assert.match(prompt, /Combine facts, stated positions, and open threads/);
  assert.match(prompt, /Flag uncertainty/);
});
