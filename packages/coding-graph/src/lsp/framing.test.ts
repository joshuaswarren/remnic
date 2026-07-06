/**
 * Framing edge-case tests (issue #1555 step 2 — prove-fail-before).
 *
 * Covers the off-by-one and split-buffer traps that make LSP framing
 * the most error-prone part of the client:
 *   - single complete frame
 *   - frame split across multiple chunks (body boundary)
 *   - header split across chunks (separator boundary)
 *   - multiple frames in one chunk
 *   - partial frame (body not yet complete) → zero messages
 *   - Content-Length counts UTF-8 BYTES not UTF-16 code units
 *   - malformed header (no Content-Length) → decode error
 *   - invalid JSON body → decode error
 *   - empty feed → zero messages, no throw
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LspFrameDecoder,
  encodeLspFrame,
} from "./framing.js";

test("encodeLspFrame: Content-Length header counts UTF-8 bytes, not UTF-16 code units", () => {
  // The emoji 𝕏 is 4 UTF-8 bytes (F0 9D 95 8F) but 2 UTF-16 code units.
  const frame = encodeLspFrame({ method: "test", params: { text: "𝕏" } });
  // The body is the JSON-serialized object. We check that the header
  // Content-Length matches Buffer.byteLength of the body.
  const headerEnd = frame.indexOf("\r\n\r\n");
  const header = frame.slice(0, headerEnd);
  const body = frame.slice(headerEnd + 4);
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  assert.ok(match, "header must contain Content-Length");
  const declared = Number(match[1]);
  const actual = Buffer.byteLength(body, "utf8");
  assert.equal(declared, actual, "Content-Length must match UTF-8 byte count");
});

test("decode: single complete frame in one chunk", () => {
  const dec = new LspFrameDecoder();
  const frame = encodeLspFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const result = dec.feed(frame);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
  }
  assert.equal(dec.hasResidual, false);
});

test("decode: frame body split across two chunks", () => {
  const dec = new LspFrameDecoder();
  const frame = encodeLspFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const headerEnd = frame.indexOf("\r\n\r\n") + 4;
  const header = frame.slice(0, headerEnd);
  const body = frame.slice(headerEnd);
  const mid = Math.floor(body.length / 2);

  // First chunk: header + half the body → zero messages.
  let result = dec.feed(header + body.slice(0, mid));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages.length, 0);

  // Second chunk: rest of body → one message.
  result = dec.feed(body.slice(mid));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], { jsonrpc: "2.0", id: 1, result: { ok: true } });
  }
});

test("decode: header separator split across two chunks", () => {
  const dec = new LspFrameDecoder();
  const frame = encodeLspFrame({ jsonrpc: "2.0", id: 1, result: "x" });
  // Split right in the middle of \r\n\r\n.
  const sepIdx = frame.indexOf("\r\n\r\n");
  const splitPoint = sepIdx + 2; // after first \r\n, before second \r\n

  let result = dec.feed(frame.slice(0, splitPoint));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages.length, 0);

  result = dec.feed(frame.slice(splitPoint));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], { jsonrpc: "2.0", id: 1, result: "x" });
  }
});

test("decode: multiple frames in one chunk", () => {
  const dec = new LspFrameDecoder();
  const f1 = encodeLspFrame({ jsonrpc: "2.0", id: 1, result: "a" });
  const f2 = encodeLspFrame({ jsonrpc: "2.0", id: 2, result: "b" });
  const f3 = encodeLspFrame({ jsonrpc: "2.0", id: 3, result: "c" });

  const result = dec.feed(f1 + f2 + f3);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 3);
    assert.deepEqual(result.messages[0], { jsonrpc: "2.0", id: 1, result: "a" });
    assert.deepEqual(result.messages[1], { jsonrpc: "2.0", id: 2, result: "b" });
    assert.deepEqual(result.messages[2], { jsonrpc: "2.0", id: 3, result: "c" });
  }
  assert.equal(dec.hasResidual, false);
});

test("decode: partial header (no separator yet) → zero messages, no throw", () => {
  const dec = new LspFrameDecoder();
  const result = dec.feed("Content-Length: 10\r\n");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages.length, 0);
  assert.equal(dec.hasResidual, true);
});

test("decode: malformed header (no Content-Length) → decode error", () => {
  const dec = new LspFrameDecoder();
  const result = dec.feed("Content-Type: text/plain\r\n\r\n{}");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "malformed_header");
  }
});

test("decode: invalid JSON body → decode error", () => {
  const dec = new LspFrameDecoder();
  const body = "{ not valid json";
  const byteLength = Buffer.byteLength(body, "utf8");
  const frame = `Content-Length: ${byteLength}\r\n\r\n${body}`;
  const result = dec.feed(frame);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "json_parse_error");
  }
});

test("decode: empty feed → zero messages, no throw", () => {
  const dec = new LspFrameDecoder();
  const result = dec.feed("");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages.length, 0);
  assert.equal(dec.hasResidual, false);
});

test("decode: UTF-8 multi-byte body — Content-Length matches byte count", () => {
  const dec = new LspFrameDecoder();
  const obj = { jsonrpc: "2.0", id: 1, result: "𝕏𝕏𝕏" };
  const frame = encodeLspFrame(obj);
  const result = dec.feed(frame);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], obj);
  }
});

test("decode: sequential frames after partial — scan offset resets correctly", () => {
  // Regression guard: after extracting a frame that was split, the
  // scanOffset must reset so the next frame's separator is found from
  // the beginning of the new buffer, not from a stale offset.
  const dec = new LspFrameDecoder();
  const f1 = encodeLspFrame({ id: 1 });
  const f2 = encodeLspFrame({ id: 2 });

  // Feed f1 in two chunks to force a split-extract cycle.
  const mid = Math.floor(f1.length / 2);
  dec.feed(f1.slice(0, mid));
  let result = dec.feed(f1.slice(mid));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.messages.length, 1);

  // Now feed f2 — it should parse cleanly from the reset offset.
  result = dec.feed(f2);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.messages.length, 1);
    assert.deepEqual(result.messages[0], { id: 2 });
  }
});
