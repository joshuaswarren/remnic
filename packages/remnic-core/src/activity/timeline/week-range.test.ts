import assert from "node:assert/strict";
import test from "node:test";

import { weekRange } from "./week-range.js";

test("monday week is [start, start+7)", () => {
  assert.deepEqual(weekRange({ weekStartIso: "2026-07-13" }), {
    start: "2026-07-13",
    endExclusive: "2026-07-20",
  });
});

test("invalid date throws", () => {
  assert.throws(() => weekRange({ weekStartIso: "2026-02-30" }), /YYYY-MM-DD/);
  assert.throws(() => weekRange({ weekStartIso: "not-a-date" }), /YYYY-MM-DD/);
});

test("exclusive end is the next week start", () => {
  const first = weekRange({ weekStartIso: "2026-07-13" });
  const next = weekRange({ weekStartIso: first.endExclusive });
  assert.equal(next.start, first.endExclusive);
  assert.equal(next.endExclusive, "2026-07-27");
});
