import assert from "node:assert/strict";
import test from "node:test";

import { parseStateViewKind } from "./recall-state-view-kind.js";

test("parses each allowed kind", () => {
  for (const kind of ["current", "historical", "transition"] as const) {
    assert.deepEqual(parseStateViewKind(kind), { ok: true, kind });
  }
});

test("unknown kind is unknown_kind", () => {
  assert.deepEqual(parseStateViewKind("ghost"), { ok: false, error: "unknown_kind" });
  assert.deepEqual(parseStateViewKind("superseded"), { ok: false, error: "unknown_kind" });
});

test("empty kind is unknown_kind", () => {
  assert.deepEqual(parseStateViewKind(""), { ok: false, error: "unknown_kind" });
});
