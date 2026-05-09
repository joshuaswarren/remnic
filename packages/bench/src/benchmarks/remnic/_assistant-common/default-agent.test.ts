import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssistantResponderPrompt,
  finalizeAssistantOutput,
  neutralizeUnsupportedGenderedPronouns,
} from "./default-agent.js";

test("buildAssistantResponderPrompt preserves prompt and asks for grounded synthesis", () => {
  const prompt = buildAssistantResponderPrompt("What should I do next?");

  assert.match(prompt, /^What should I do next\?/);
  assert.match(prompt, /Use only the supplied Remnic memory context/);
  assert.match(prompt, /Combine facts, stated positions, and open threads/);
  assert.match(prompt, /what it rules out/);
  assert.match(prompt, /settled stances and decisions/);
  assert.match(prompt, /Include one explicit grounded frame/);
  assert.match(prompt, /Avoid unsupported demographic details/);
  assert.match(prompt, /Do not use gendered third-person pronouns/);
  assert.match(prompt, /Flag uncertainty/);
});

test("buildAssistantResponderPrompt adds open-question recall guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I'm meeting Priya. What open questions does she expect me to answer?",
  );

  assert.match(prompt, /person-specific expected question/);
  assert.match(prompt, /settled stance that constrains the answer/);
});

test("buildAssistantResponderPrompt adds highest-leverage action guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "I have 45 minutes free. What's the single highest-leverage thing I should do?",
  );

  assert.match(prompt, /concrete 45-minute outcome/);
  assert.match(prompt, /downstream dependency/);
});

test("buildAssistantResponderPrompt adds synthesis framing guidance", () => {
  const prompt = buildAssistantResponderPrompt(
    "What is the right strategy? Give me a synthesized view.",
  );

  assert.match(prompt, /state the operating principle/);
  assert.match(prompt, /connect at least three distinct memory items/);
});

test("neutralizeUnsupportedGenderedPronouns removes unsupported gendered references", () => {
  assert.equal(
    neutralizeUnsupportedGenderedPronouns(
      "Pair with Jordan Okafor this week. He joined last week and his onboarding is open.",
    ),
    "Pair with Jordan Okafor this week. The person joined last week and the person's onboarding is open.",
  );
});

test("finalizeAssistantOutput appends a grounded leverage frame for next-best-action prompts", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "I have 45 minutes free. What's the single highest-leverage thing I should do?",
      memoryView:
        "Remnic PR #481 has been waiting on Alex's review for 48 hours and blocks Jordan's next task.",
    },
    "Review Remnic PR #481 now.",
  );

  assert.match(output, /Leverage frame:/);
  assert.match(output, /dependency-leverage rule/);
  assert.match(output, /generic urgency sort/);
});

test("finalizeAssistantOutput appends a grounded synthesis frame for synthesis prompts", () => {
  const output = finalizeAssistantOutput(
    {
      prompt:
        "Across everything you've stored, what is the right caching strategy? Give me a synthesized view.",
      memoryView:
        "Atlas design doc revision 4 proposes sharded read cache. The user pushed back on expanded write-through caching.",
    },
    "Use a sharded read cache and avoid expanding write-through caching.",
  );

  assert.match(output, /Synthesis frame:/);
  assert.match(output, /risk-control strategy/);
});
