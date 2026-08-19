import assert from "node:assert/strict";
import { test } from "node:test";

import { filterLiveEnvelopes, markSupersededCirculation } from "./staleness.js";

test("filterLiveEnvelopes drops at the expiry instant (half-open)", () => {
  const expiresAt = "2026-08-18T12:00:00.000Z";
  const at = Date.parse(expiresAt);
  const live = { id: "keep", expiresAt };
  const forever = { id: "legacy" };
  const items = [live, forever];

  assert.deepEqual(filterLiveEnvelopes(items, at - 1), items);
  assert.deepEqual(filterLiveEnvelopes(items, at), [forever]);
  assert.deepEqual(filterLiveEnvelopes(items, at + 1), [forever]);
  assert.equal(items.length, 2);
});

test("markSupersededCirculation flags targets that still circulate", () => {
  const older = { id: "item-1", expiresAt: "2026-08-19T00:00:00.000Z" };
  const newer = { id: "item-2", supersedes: "item-1" };
  const other = { id: "item-3" };
  const items = [older, newer, other];

  const marked = markSupersededCirculation(items);
  assert.equal(marked[0]?.circulating, true);
  assert.equal(marked[1]?.circulating, undefined);
  assert.equal(marked[2]?.circulating, undefined);
  assert.equal(older.circulating, undefined);
  assert.notEqual(marked[0], older);
});
