import assert from "node:assert/strict";
import test from "node:test";

import {
  latestUserQuery,
  sessionKeyFromContext,
  summarizeMessages,
  textFromMessage,
  toObserveMessage,
} from "./messages.js";

test("sessionKeyFromContext uses Pi session id when available", () => {
  assert.equal(
    sessionKeyFromContext({ sessionManager: { getSessionId: () => "abc123" } }),
    "pi:abc123",
  );
});

test("latestUserQuery extracts the newest user text", () => {
  const messages = [
    { role: "user", content: "older" },
    { role: "assistant", content: "answer" },
    { role: "user", content: [{ type: "text", text: "newer" }] },
  ];
  assert.equal(latestUserQuery(messages), "newer");
});

test("toObserveMessage marks Pi messages with structured tool parts", () => {
  const observed = toObserveMessage({
    role: "assistant",
    content: [
      { type: "text", text: "Updated src/index.ts" },
      { type: "toolCall", name: "edit", arguments: { path: "src/index.ts" } },
    ],
  });

  assert.ok(observed);
  assert.equal(observed.sourceFormat, "pi");
  assert.equal(observed.role, "assistant");
  assert.equal(observed.parts?.[1]?.kind, "file_write");
  assert.equal(observed.parts?.[1]?.filePath, "src/index.ts");
});

test("textFromMessage renders bash executions for observation", () => {
  assert.equal(
    textFromMessage({ role: "bashExecution", command: "npm test", output: "ok" }),
    "Ran npm test\nok",
  );
});

test("summarizeMessages respects max character budget", () => {
  const summary = summarizeMessages([{ role: "user", content: "abcdef" }], 10);
  assert.equal(summary.length, 10);
});
