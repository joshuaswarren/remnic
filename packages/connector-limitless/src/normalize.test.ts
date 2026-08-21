import assert from "node:assert/strict";
import { test } from "node:test";

import type { LimitlessLifelog } from "./client.js";
import { lifelogToConversation } from "./normalize.js";

const SAMPLE: LimitlessLifelog = {
  id: "lifelog-1",
  title: "Coffee with a friend",
  startTime: "2026-06-10T09:00:00-05:00",
  endTime: "2026-06-10T09:42:00-05:00",
  contents: [
    {
      type: "heading1",
      content: "Coffee with a friend",
      children: [
        {
          type: "heading2",
          content: "Catching up",
          children: [
            {
              type: "blockquote",
              content: "I finally tried that hiking trail you mentioned.",
              speakerName: "Speaker 2",
              speakerIdentifier: null,
              startTime: "2026-06-10T09:01:00-05:00",
              endTime: "2026-06-10T09:01:08-05:00",
            },
            {
              type: "blockquote",
              content: "Nice! The east loop is my favorite.",
              speakerName: "Jordan Sample",
              speakerIdentifier: "user",
              startTime: "2026-06-10T09:01:10-05:00",
            },
          ],
        },
      ],
    },
    {
      type: "blockquote",
      content: "   ",
      speakerName: "Speaker 2",
      speakerIdentifier: null,
    },
  ],
};

test("maps lifelog metadata and dialogue blockquotes", () => {
  const conversation = lifelogToConversation(SAMPLE);
  assert.equal(conversation.id, "lifelog-1");
  assert.equal(conversation.source, "limitless");
  assert.equal(conversation.title, "Coffee with a friend");
  assert.equal(conversation.startIso, "2026-06-10T09:00:00-05:00");
  assert.equal(conversation.segments.length, 2);
});

test("marks the wearer via speakerIdentifier and keys them as 'user'", () => {
  const conversation = lifelogToConversation(SAMPLE);
  const [other, wearer] = conversation.segments;
  assert.equal(other.isWearer, undefined);
  assert.equal(other.speakerKey, "Speaker 2");
  assert.equal(wearer.isWearer, true);
  assert.equal(wearer.speakerKey, "user");
  assert.equal(wearer.speakerName, "Jordan Sample");
});

test("skips whitespace-only blockquotes and heading nodes", () => {
  const conversation = lifelogToConversation(SAMPLE);
  assert.ok(
    conversation.segments.every((segment) => segment.text.trim().length > 0),
  );
});

test("tolerates lifelogs with no contents", () => {
  const conversation = lifelogToConversation({ id: "empty-1" });
  assert.equal(conversation.segments.length, 0);
  assert.equal(conversation.startIso, "");
});

test("caps pathological nesting instead of recursing forever", () => {
  let node: LimitlessLifelog["contents"] = [
    { type: "blockquote", content: "deep", speakerName: "Speaker 9" },
  ];
  for (let depth = 0; depth < 64; depth++) {
    node = [{ type: "heading2", content: "wrap", children: node }];
  }
  const conversation = lifelogToConversation({ id: "deep-1", contents: node });
  // The deepest blockquote is beyond the cap and gets dropped — the
  // important property is no stack overflow and no crash.
  assert.ok(conversation.segments.length <= 1);
});
