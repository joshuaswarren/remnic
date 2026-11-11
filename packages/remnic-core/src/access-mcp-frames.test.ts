import assert from "node:assert/strict";
import test from "node:test";

import { MCP_STDIO_MAX_FRAME_BYTES, McpFrameReader } from "./access-mcp-frames.js";

function frame(body: string): Buffer {
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");
}

test("a frame that arrives in two reads is returned once, without re-reading the partial buffer", () => {
  const reader = new McpFrameReader();
  const whole = frame('{"id":1}');
  reader.push(whole.subarray(0, 10));
  assert.equal(reader.next(), null);
  assert.equal(reader.hasUnread(), false);

  reader.push(whole.subarray(10));
  assert.equal(reader.hasUnread(), true);
  assert.deepEqual(reader.next(), { kind: "body", text: '{"id":1}', form: "header" });
  assert.equal(reader.next(), null);
});

test("bytes that arrive after the reader stopped on an empty buffer are unread", () => {
  const reader = new McpFrameReader();
  reader.push(frame("first"));
  assert.deepEqual(reader.next(), { kind: "body", text: "first", form: "header" });
  assert.equal(reader.next(), null);
  assert.equal(reader.hasUnread(), false);

  reader.push(frame("second"));
  assert.equal(reader.hasUnread(), true);
  assert.deepEqual(reader.next(), { kind: "body", text: "second", form: "header" });
});

test("the body of an oversized frame is dropped across reads and the next frame is read", () => {
  const reader = new McpFrameReader();
  const declared = MCP_STDIO_MAX_FRAME_BYTES + 5;
  reader.push(Buffer.from(`Content-Length: ${declared}\r\n\r\n${"A".repeat(100)}`, "utf-8"));
  assert.deepEqual(reader.next(), { kind: "too-large", form: "header" });
  assert.equal(reader.next(), null);

  reader.push(Buffer.from("B".repeat(declared - 100), "utf-8"));
  assert.equal(reader.hasUnread(), false);

  reader.push(frame("after"));
  assert.deepEqual(reader.next(), { kind: "body", text: "after", form: "header" });
});

test("a newline-delimited message is a line frame, and a blank line is skipped", () => {
  const reader = new McpFrameReader();
  reader.push(Buffer.from('\n{"id":1}\n{"id":2}\n', "utf-8"));
  assert.deepEqual(reader.next(), { kind: "body", text: '{"id":1}', form: "line" });
  assert.deepEqual(reader.next(), { kind: "body", text: '{"id":2}', form: "line" });
  assert.equal(reader.next(), null);
});

test("a newline-delimited line longer than the bound is refused and the buffer does not keep it", () => {
  const reader = new McpFrameReader();
  reader.push(Buffer.from(`${"A".repeat(MCP_STDIO_MAX_FRAME_BYTES + 1)}\n`, "utf-8"));
  assert.deepEqual(reader.next(), { kind: "too-large", form: "line" });
  assert.equal(reader.next(), null);
  assert.equal(reader.hasUnread(), false);
});
