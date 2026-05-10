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

test("latestUserQuery skips Pi context-excluded messages", () => {
  const messages = [
    { role: "user", content: "usable" },
    { role: "user", content: "private", excludeFromContext: true },
  ];

  assert.equal(latestUserQuery(messages), "usable");
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

test("toObserveMessage encodes Pi bash executions as tool results", () => {
  const observed = toObserveMessage({
    role: "bashExecution",
    command: "cat src/index.ts",
    output: "src/index.ts contents",
    exitCode: 0,
  });

  assert.ok(observed);
  assert.equal(observed.role, "user");
  assert.equal(observed.parts?.[0]?.kind, "tool_result");
  assert.equal(observed.parts?.[0]?.toolName, "bashExecution");
  assert.equal(observed.parts?.[0]?.filePath, "src/index.ts");
  assert.equal(observed.parts?.[0]?.payload.command, "cat src/index.ts");
  assert.equal(observed.parts?.[0]?.payload.output, "src/index.ts contents");
  assert.equal(observed.parts?.[0]?.payload.exitCode, 0);
});

test("toObserveMessage skips Pi context-excluded messages", () => {
  assert.equal(
    toObserveMessage({ role: "bashExecution", command: "secret", output: "private", excludeFromContext: true }),
    null,
  );
});

test("hashObservedMessage scopes duplicate detection by session", () => {
  const observed = toObserveMessage({ role: "user", content: "same" });

  assert.ok(observed);
  const hash = hashObservedMessage(observed, "pi:one");
  assert.equal(hash.length, 64);
  assert.notEqual(hash, hashObservedMessage(observed, "pi:two"));
  assert.equal(hash.includes("same"), false);
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

test("summarizeMessages skips Pi context-excluded messages", () => {
  const summary = summarizeMessages([
    { role: "user", content: "keep" },
    { role: "bashExecution", command: "private", output: "secret", excludeFromContext: true },
  ], 1000);

  assert.equal(summary, "[user] keep");
});
