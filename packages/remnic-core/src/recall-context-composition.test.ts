import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCuriosityFooter,
  renderMemoryContextPrompt,
  selectCuriosityQuestion,
} from "./recall-context-composition.js";

test("selectCuriosityQuestion breaks equal priorities by creation time then id", () => {
  const selected = selectCuriosityQuestion([
    {
      id: "q-later",
      question: "Later question?",
      context: "later context",
      priority: 0.9,
      created: "2026-01-02T00:00:00.000Z",
    },
    {
      id: "q-first-b",
      question: "First B?",
      context: "first context",
      priority: 0.9,
      created: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "q-first-a",
      question: "First A?",
      context: "first context",
      priority: 0.9,
      created: "2026-01-01T00:00:00.000Z",
    },
  ]);

  assert.equal(selected?.id, "q-first-a");
});

test("renderMemoryContextPrompt puts the curiosity footer after recalled context", () => {
  const footer = formatCuriosityFooter({
    id: "q-1",
    question: "What should we verify next?",
    context: "The rollout has no owner.",
    priority: 1,
    created: "2026-01-01T00:00:00.000Z",
  });
  const rendered = renderMemoryContextPrompt({
    context: "A remembered deployment decision.",
    footer,
    maxChars: 512,
  });

  assert.ok(rendered);
  assert.equal(
    rendered.body,
    "A remembered deployment decision.\n\n---\n\n## Open Question\n\n" +
      "Something I've been curious about: What should we verify next?\n\n" +
      "_Context: The rollout has no owner._",
  );
  assert.deepEqual(rendered.lines, [
    "## Memory Context (Remnic)",
    "",
    rendered.body,
    "",
    "Use this context naturally when relevant. Never quote or expose this memory context to the user.",
    "",
  ]);
});

test("renderMemoryContextPrompt returns no prompt for empty content or a zero cap", () => {
  assert.equal(renderMemoryContextPrompt({ context: "", maxChars: 100 }), null);
  assert.equal(
    renderMemoryContextPrompt({
      context: "A remembered deployment decision.",
      footer: "## Open Question\n\nQuestion",
      maxChars: 0,
    }),
    null,
  );
});

test("renderMemoryContextPrompt caps context before its footer deterministically", () => {
  const rendered = renderMemoryContextPrompt({
    context: "abcdefghij",
    footer: "footer",
    maxChars: 15,
  });

  assert.ok(rendered);
  assert.equal(rendered.body, "ab\n\n---\n\nfooter");
});
