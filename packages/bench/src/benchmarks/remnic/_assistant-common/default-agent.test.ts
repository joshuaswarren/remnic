import assert from "node:assert/strict";
import test from "node:test";

import { buildAssistantResponderPrompt } from "./default-agent.js";

test("buildAssistantResponderPrompt preserves prompt and asks for grounded synthesis", () => {
  const prompt = buildAssistantResponderPrompt("What should I do next?");

  assert.match(prompt, /^What should I do next\?/);
  assert.match(prompt, /Use only the supplied Remnic memory context/);
  assert.match(prompt, /Combine facts, stated positions, and open threads/);
  assert.match(prompt, /what it rules out/);
  assert.match(prompt, /settled stances and decisions/);
  assert.match(prompt, /Avoid unsupported demographic details/);
  assert.match(prompt, /Flag uncertainty/);
});

test("buildAssistantResponderPrompt adds open-question recall guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I'm meeting Priya. What open questions does she expect me to answer?",
  );

  assert.match(prompt, /person-specific expected question/);
  assert.match(prompt, /settled stance that constrains the answer/);
});
