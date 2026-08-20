import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stampSpanSource,
  verifySpanSource,
  type SpanSourceStamp,
} from "./extraction-span-source-hash.js";

const TEXT = "The canary offset string, version one.";

test("stampSpanSource: round trip verifies ok", () => {
  const stamp = stampSpanSource(TEXT);
  const check = verifySpanSource(TEXT, stamp);
  assert.deepEqual(check, { ok: true });
});

test("stampSpanSource: empty string gets a real stamp and round trips", () => {
  const stamp = stampSpanSource("");
  assert.match(stamp.hash, /^[0-9a-f]{64}$/);
  assert.equal(stamp.length, 0);
  assert.equal(
    stamp.hash,
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.deepEqual(verifySpanSource("", stamp), { ok: true });
});

test("verifySpanSource: same-length single-character edit is hash_mismatch", () => {
  const stamp = stampSpanSource(TEXT);
  const edited = TEXT.replace("canary", "canarz");
  assert.equal(edited.length, TEXT.length);
  const check = verifySpanSource(edited, stamp);
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.error, "hash_mismatch");
  }
});

test("verifySpanSource: added character is length_mismatch even though hash also differs", () => {
  const stamp = stampSpanSource(TEXT);
  const longer = `${TEXT}!`;
  const check = verifySpanSource(longer, stamp);
  assert.equal(check.ok, false);
  if (!check.ok) {
    assert.equal(check.error, "length_mismatch");
    assert.equal(check.expected.length, TEXT.length);
    assert.equal(check.actual.length, longer.length);
  }
});

test("verifySpanSource: failure result carries no source text", () => {
  const original = "original driftmarker-alpha payload";
  const edited = "original driftmarker-beta payload";
  const stamp = stampSpanSource(original);
  const check = verifySpanSource(edited, stamp);
  assert.equal(check.ok, false);
  const serialized = JSON.stringify(check);
  assert.ok(!serialized.includes("driftmarker-alpha"));
  assert.ok(!serialized.includes("driftmarker-beta"));
});

test("stampSpanSource: non-string text throws TypeError naming text", () => {
  assert.throws(() => stampSpanSource(42 as unknown as string), /text/);
  assert.throws(() => stampSpanSource(null as unknown as string), /text/);
  assert.throws(
    () => stampSpanSource(undefined as unknown as string),
    /text/,
  );
});

test("verifySpanSource: non-string text throws TypeError naming text", () => {
  const stamp = stampSpanSource(TEXT);
  assert.throws(
    () => verifySpanSource(7 as unknown as string, stamp),
    /text/,
  );
});

function stampWithHash(hash: unknown): SpanSourceStamp {
  return { hash: hash as string, length: TEXT.length };
}

test("verifySpanSource: malformed expected hash throws RangeError naming the field", () => {
  const good = stampSpanSource(TEXT);
  const tooShort = good.hash.slice(0, 63);
  const upper = good.hash.toUpperCase();
  const nonHex = `${good.hash.slice(0, 63)}z`;
  for (const bad of [tooShort, upper, nonHex, 123, null]) {
    assert.throws(
      () => verifySpanSource(TEXT, stampWithHash(bad)),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match((err as Error).message, /hash/);
        return true;
      },
    );
  }
});

test("verifySpanSource: inherited stamp fields are rejected", () => {
  const good = stampSpanSource(TEXT);
  const inherited = Object.create(good) as SpanSourceStamp;
  assert.throws(
    () => verifySpanSource(TEXT, inherited),
    (err: unknown) => {
      assert.ok(err instanceof RangeError);
      assert.match((err as Error).message, /hash/);
      return true;
    },
  );
});

test("verifySpanSource: negative or fractional expected length throws", () => {
  const good = stampSpanSource(TEXT);
  for (const bad of [-1, -0.5, 4.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => verifySpanSource(TEXT, { hash: good.hash, length: bad }),
      (err: unknown) => {
        assert.ok(err instanceof RangeError);
        assert.match((err as Error).message, /length/);
        return true;
      },
    );
  }
});

test("stampSpanSource: two stamps of the same string are identical", () => {
  const a = stampSpanSource(TEXT);
  const b = stampSpanSource(TEXT);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
