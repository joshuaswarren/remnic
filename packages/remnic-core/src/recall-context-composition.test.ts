import assert from "node:assert/strict";
import test from "node:test";

import {
  boundRecallContextComposition,
  composeMissingMemoryContext,
  composeRecallContext,
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

test("#2972 healthy recall carries no degradation marker", () => {
  const composition = boundRecallContextComposition({
    context: "A remembered deployment decision.",
    maxChars: 512,
  });

  assert.equal("degradation" in composition, false);
  assert.ok(!JSON.stringify(composition).includes("degradation"));
});

test("#2972 budget-clipped context is marked degraded, not silently cut", () => {
  const composition = boundRecallContextComposition({
    context: "x".repeat(100),
    maxChars: 20,
  });

  assert.equal(composition.degradation?.state, "degraded");
  assert.equal(composition.degradation?.reason, "budget-clipped");
  assert.equal(composition.degradation?.budget?.fullChars, 100);
  assert.ok(
    (composition.degradation?.budget?.deliveredChars ?? 0) <
      (composition.degradation?.budget?.fullChars ?? 0),
  );
});

test("#2972 a fitting compact context is preferred over clipping the tail", () => {
  const composition = boundRecallContextComposition({
    context: "full-form entry one\n\nfull-form entry two",
    compactContext: "entry one\nentry two",
    maxChars: 30,
  });

  assert.equal(composition.context, "entry one\nentry two");
  assert.equal(composition.degradation?.state, "degraded");
  assert.equal(composition.degradation?.reason, "budget-compacted");
  assert.equal(composition.degradation?.budget?.deliveredChars, 19);
});

test("#2972 a compact form that is not shallower than the full context is ignored", () => {
  const composition = boundRecallContextComposition({
    context: "x".repeat(50),
    compactContext: "y".repeat(60),
    maxChars: 10,
  });

  assert.equal(composition.degradation?.reason, "budget-clipped");
});

test("#2972 backend failure yields an explicit missing note, never an empty string", () => {
  const composition = composeMissingMemoryContext({ detail: "backend_unavailable" });
  const body = composeRecallContext(composition);

  assert.ok(body.length > 0);
  assert.match(body, /memory context unavailable/i);
  assert.equal(composition.degradation?.state, "missing");
  assert.equal(composition.degradation?.reason, "backend-unavailable");
  assert.equal(composition.degradation?.detail, "backend_unavailable");

  const rendered = renderMemoryContextPrompt({ ...composition, maxChars: 512 });
  assert.ok(rendered);
  assert.match(rendered.body, /memory context unavailable/i);
});
