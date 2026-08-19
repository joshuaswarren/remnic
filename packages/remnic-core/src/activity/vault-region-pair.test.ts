import assert from "node:assert/strict";
import test from "node:test";

import { assertBeginEndPair } from "./vault-region-pair.js";

test("assertBeginEndPair accepts a matching pair", () => {
  assert.deepEqual(assertBeginEndPair({ beginName: "timeline", endName: "timeline" }), { ok: true });
  assert.deepEqual(assertBeginEndPair({ beginName: "  timeline  ", endName: "timeline" }), {
    ok: true,
  });
});

test("assertBeginEndPair rejects a name mismatch", () => {
  assert.deepEqual(assertBeginEndPair({ beginName: "timeline", endName: "weekly" }), {
    ok: false,
    error: "name_mismatch",
  });
});

test("assertBeginEndPair throws on an empty name", () => {
  assert.throws(() => assertBeginEndPair({ beginName: "", endName: "timeline" }), /empty/i);
  assert.throws(() => assertBeginEndPair({ beginName: "timeline", endName: "   " }), /empty/i);
});
