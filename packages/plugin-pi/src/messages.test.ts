import assert from "node:assert/strict";
import test from "node:test";

import {
  hashObservedMessage,
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

test("toObserveMessage preserves Pi tool result messages", () => {
  const observed = toObserveMessage({
    role: "toolResult",
    toolName: "read",
    content: [{ type: "text", text: "Read src/index.ts" }],
    isError: false,
  });

  assert.ok(observed);
  assert.equal(observed.role, "assistant");
  assert.equal(observed.parts?.[0]?.kind, "tool_result");
  assert.equal(observed.parts?.[0]?.toolName, "read");
  assert.equal(observed.parts?.[0]?.filePath, "src/index.ts");
  assert.equal(observed.parts?.[0]?.payload.isError, false);
});

test("hashObservedMessage scopes duplicate detection by session", () => {
  const observed = toObserveMessage({ role: "user", content: "same" });

  assert.ok(observed);
  assert.notEqual(
    hashObservedMessage(observed, "pi:one"),
    hashObservedMessage(observed, "pi:two"),
  );
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

test("summarizeMessages counts separators against max character budget", () => {
  const summary = summarizeMessages([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ], 20);

  assert.ok(summary.length <= 20);
  assert.equal(summary, "[user] a\n\n[assistant");
});
