import assert from "node:assert/strict";
import test from "node:test";

import { parseSupersededAt } from "./recall-state-view-superseded.js";

test("ok date returns canonical ISO supersededAt", () => {
  assert.deepEqual(parseSupersededAt("2026-08-19T12:34:56.000Z"), {
    ok: true,
    supersededAt: "2026-08-19T12:34:56.000Z",
  });
});

test("empty date is missing_date", () => {
  assert.deepEqual(parseSupersededAt(""), { ok: false, error: "missing_date" });
  assert.deepEqual(parseSupersededAt("   "), { ok: false, error: "missing_date" });
});

test("invalid date is invalid_date", () => {
  assert.deepEqual(parseSupersededAt("not-a-date"), { ok: false, error: "invalid_date" });
});
