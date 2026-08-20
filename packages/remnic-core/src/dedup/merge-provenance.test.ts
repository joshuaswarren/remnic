import assert from "node:assert/strict";
import test from "node:test";

import {
  MERGE_DERIVED_VIA,
  buildMergeFrontmatterUpdate,
  type MergeProvenanceSource,
} from "./merge-provenance.js";

const NOW = "2026-08-19T12:34:56Z";

function src(sessionKey: string, turnId: string, quote: string): MergeProvenanceSource {
  return { sessionKey, turnId, quote };
}

test("appends incoming sources after target sources in order", () => {
  const target = [src("s1", "t1", "q1"), src("s2", "t2", "q2")];
  const incoming = [src("s3", "t3", "q3")];
  const result = buildMergeFrontmatterUpdate({ targetSources: target, incomingSources: incoming, nowIso: NOW });
  assert.deepEqual(result.sources, [src("s1", "t1", "q1"), src("s2", "t2", "q2"), src("s3", "t3", "q3")]);
});

test("exact-triple dedup keeps the first occurrence", () => {
  const target = [src("s1", "t1", "q1")];
  const incoming = [src("s1", "t1", "q1"), src("s1", "t1", "q1"), src("s9", "t9", "q9")];
  const result = buildMergeFrontmatterUpdate({ targetSources: target, incomingSources: incoming, nowIso: NOW });
  assert.deepEqual(result.sources, [src("s1", "t1", "q1"), src("s9", "t9", "q9")]);
});

test("sources differing in any one field are both kept", () => {
  const result = buildMergeFrontmatterUpdate({
    targetSources: [src("s1", "t1", "q1")],
    incomingSources: [src("s1", "t1", "q2"), src("s1", "t2", "q1"), src("s2", "t1", "q1")],
    nowIso: NOW,
  });
  assert.deepEqual(result.sources, [
    src("s1", "t1", "q1"),
    src("s1", "t1", "q2"),
    src("s1", "t2", "q1"),
    src("s2", "t1", "q1"),
  ]);
});

test("blank sessionKey, turnId, or quote is rejected with RangeError mentioning source", () => {
  const cases = [src("", "t1", "q1"), src("  ", "t1", "q1"), src("s1", "", "q1"), src("s1", "t1", "   ")];
  for (const bad of cases) {
    assert.throws(
      () => buildMergeFrontmatterUpdate({ incomingSources: [bad], nowIso: NOW }),
      { name: "RangeError", message: /source/ }
    );
  }
  // Target provenance must meet the same traceability bar.
  assert.throws(
    () => buildMergeFrontmatterUpdate({ targetSources: [src("s1", "", "q1")], incomingSources: [], nowIso: NOW }),
    { name: "RangeError", message: /source/ }
  );
});

test("merge_count defaults to 1 and increments from the target count", () => {
  const absent = buildMergeFrontmatterUpdate({ incomingSources: [], nowIso: NOW });
  assert.equal(absent.merge_count, 1);
  const fromTwo = buildMergeFrontmatterUpdate({ incomingSources: [], targetMergeCount: 2, nowIso: NOW });
  assert.equal(fromTwo.merge_count, 3);
});

test("negative, float, and NaN targetMergeCount throw RangeError mentioning merge_count", () => {
  for (const bad of [-1, 2.5, Number.NaN]) {
    assert.throws(
      () => buildMergeFrontmatterUpdate({ incomingSources: [], targetMergeCount: bad, nowIso: NOW }),
      { name: "RangeError", message: /merge_count/ }
    );
  }
});

test("invalid and blank nowIso throw RangeError mentioning nowIso", () => {
  for (const bad of ["", "   ", "not-a-timestamp"]) {
    assert.throws(
      () => buildMergeFrontmatterUpdate({ incomingSources: [], nowIso: bad }),
      { name: "RangeError", message: /nowIso/ }
    );
  }
});

test("updated echoes the caller's timestamp verbatim and derived_via is constant", () => {
  const result = buildMergeFrontmatterUpdate({ incomingSources: [], nowIso: "2026-08-19T12:34:56Z" });
  assert.equal(result.updated, "2026-08-19T12:34:56Z");
  assert.equal(result.derived_via, MERGE_DERIVED_VIA);
  assert.equal(MERGE_DERIVED_VIA, "semantic-merge");
});

test("empty incomingSources still bumps merge_count and preserves target sources", () => {
  const target = [src("s1", "t1", "q1")];
  const result = buildMergeFrontmatterUpdate({ targetSources: target, incomingSources: [], targetMergeCount: 4, nowIso: NOW });
  assert.equal(result.merge_count, 5);
  assert.deepEqual(result.sources, [src("s1", "t1", "q1")]);
});

test("inputs are not mutated", () => {
  const target = [src("s1", "t1", "q1"), src("s1", "t1", "q1")];
  const incoming = [src("s1", "t1", "q1"), src("s2", "t2", "q2")];
  const targetSnapshot = structuredClone(target);
  const incomingSnapshot = structuredClone(incoming);
  const result = buildMergeFrontmatterUpdate({ targetSources: target, incomingSources: incoming, targetMergeCount: 1, nowIso: NOW });
  result.sources[0].quote = "mutated";
  result.sources.length = 0;
  assert.deepEqual(target, targetSnapshot);
  assert.deepEqual(incoming, incomingSnapshot);
});
