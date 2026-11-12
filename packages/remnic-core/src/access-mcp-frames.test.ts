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
  reader.push(Buffer.from(`{${"A".repeat(MCP_STDIO_MAX_FRAME_BYTES + 1)}\n`, "utf-8"));
  assert.deepEqual(reader.next(), { kind: "too-large", form: "line" });
  assert.equal(reader.next(), null);
  assert.equal(reader.hasUnread(), false);
});

test("a header block that starts with another header is still a header frame", () => {
  const reader = new McpFrameReader();
  const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  reader.push(Buffer.from(`Content-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`, "utf-8"));
  assert.deepEqual(reader.next(), { kind: "body", text: body, form: "header" });
  assert.equal(reader.next(), null);
});

test("the tail of an oversized line that arrives over several reads is dropped", () => {
  const reader = new McpFrameReader();
  const huge = Buffer.from(`{"x":"${"A".repeat(2 * MCP_STDIO_MAX_FRAME_BYTES + 1000)}"}\n`, "utf-8");
  const frames: unknown[] = [];
  for (let at = 0; at < huge.length; at += 65536) {
    reader.push(huge.subarray(at, at + 65536));
    for (let one = reader.next(); one !== null; one = reader.next()) frames.push(one);
  }
  reader.push(Buffer.from('{"id":2}\n', "utf-8"));
  for (let one = reader.next(); one !== null; one = reader.next()) frames.push(one);
  assert.deepEqual(frames, [
    { kind: "too-large", form: "line" },
    { kind: "body", text: '{"id":2}', form: "line" },
  ]);
});

test("an oversized line that is complete in the buffer does not drop the line after it", () => {
  const reader = new McpFrameReader();
  reader.push(Buffer.from(`{"x":"${"A".repeat(MCP_STDIO_MAX_FRAME_BYTES)}"}\n{"id":2}\n`, "utf-8"));
  assert.deepEqual(reader.next(), { kind: "too-large", form: "line" });
  assert.deepEqual(reader.next(), { kind: "body", text: '{"id":2}', form: "line" });
  assert.equal(reader.next(), null);
});
