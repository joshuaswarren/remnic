import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMergeFrontmatterUpdate,
  MERGE_DERIVED_VIA,
  type MergeProvenanceSource,
} from "./merge-provenance.js";

const NOW = "2026-08-19T12:00:00.000Z";

function source(overrides: Partial<MergeProvenanceSource> = {}): MergeProvenanceSource {
  return {
    sessionKey: "project/demo/1",
    observedAt: "2026-08-18T09:00:00.000Z",
    quote: "the API limit is 100/min",
    ...overrides,
  };
}

test("appends incoming sources after target sources in order", () => {
  const a = source({ quote: "first" });
  const b = source({ quote: "second" });
  const update = buildMergeFrontmatterUpdate({
    targetSources: [a],
    incomingSources: [b],
    nowIso: NOW,
  });
  assert.deepEqual(
    update.sources.map((s) => s.quote),
    ["first", "second"],
  );
});

test("uses the serializer's allow-listed operator, not an invented one", () => {
  const update = buildMergeFrontmatterUpdate({ incomingSources: [source()], nowIso: NOW });
  assert.equal(update.derived_via, "merge");
  assert.equal(MERGE_DERIVED_VIA, "merge");
});

test("preserves every canonical optional field on an accepted source", () => {
  const full = source({ turnId: "turn-7", charStart: 4, charEnd: 12 });
  const update = buildMergeFrontmatterUpdate({ incomingSources: [full], nowIso: NOW });
  assert.deepEqual(update.sources, [
    {
      sessionKey: full.sessionKey,
      observedAt: full.observedAt,
      quote: full.quote,
      turnId: "turn-7",
      charStart: 4,
      charEnd: 12,
    },
  ]);
});

test("accepts a source with no turnId, which the canonical shape allows", () => {
  const update = buildMergeFrontmatterUpdate({ incomingSources: [source()], nowIso: NOW });
  assert.equal(update.sources.length, 1);
  assert.equal("turnId" in update.sources[0]!, false);
});

test("deduplicates on the full field tuple and keeps the first", () => {
  const first = source({ turnId: "turn-1" });
  const update = buildMergeFrontmatterUpdate({
    targetSources: [first],
    incomingSources: [{ ...first }, source({ turnId: "turn-2" })],
    nowIso: NOW,
  });
  assert.deepEqual(
    update.sources.map((s) => s.turnId),
    ["turn-1", "turn-2"],
  );
});

test("sources differing only in offsets are both kept", () => {
  const update = buildMergeFrontmatterUpdate({
    incomingSources: [source({ charStart: 0, charEnd: 5 }), source({ charStart: 6, charEnd: 9 })],
    nowIso: NOW,
  });
  assert.equal(update.sources.length, 2);
});

test("a blank sessionKey or quote is rejected", () => {
  for (const bad of [source({ sessionKey: "  " }), source({ quote: "" })]) {
    assert.throws(() => buildMergeFrontmatterUpdate({ incomingSources: [bad], nowIso: NOW }), /non-blank/);
  }
});

test("a missing or malformed observedAt is rejected", () => {
  for (const bad of ["", "2026-08-18", "not-a-date", undefined as unknown as string]) {
    assert.throws(
      () => buildMergeFrontmatterUpdate({ incomingSources: [source({ observedAt: bad })], nowIso: NOW }),
      /observedAt/,
    );
  }
});

test("a blank turnId is rejected while an absent one is fine", () => {
  assert.throws(
    () => buildMergeFrontmatterUpdate({ incomingSources: [source({ turnId: " " })], nowIso: NOW }),
    /turnId/,
  );
});

test("negative, non-integer, and inverted offsets are rejected", () => {
  assert.throws(
    () => buildMergeFrontmatterUpdate({ incomingSources: [source({ charStart: -1 })], nowIso: NOW }),
    /charStart/,
  );
  assert.throws(
    () => buildMergeFrontmatterUpdate({ incomingSources: [source({ charEnd: 1.5 })], nowIso: NOW }),
    /charEnd/,
  );
  assert.throws(
    () =>
      buildMergeFrontmatterUpdate({
        incomingSources: [source({ charStart: 9, charEnd: 2 })],
        nowIso: NOW,
      }),
    /charEnd must be >= charStart/,
  );
});

test("reinforcement_count starts at 1 and increments from the target", () => {
  assert.equal(
    buildMergeFrontmatterUpdate({ incomingSources: [source()], nowIso: NOW }).reinforcement_count,
    1,
  );
  assert.equal(
    buildMergeFrontmatterUpdate({
      incomingSources: [source()],
      targetReinforcementCount: 2,
      nowIso: NOW,
    }).reinforcement_count,
    3,
  );
});

test("an invalid target reinforcement_count is rejected", () => {
  for (const bad of [-1, 1.5, Number.NaN, "2" as unknown as number]) {
    assert.throws(
      () =>
        buildMergeFrontmatterUpdate({
          incomingSources: [source()],
          targetReinforcementCount: bad,
          nowIso: NOW,
        }),
      /reinforcement_count/,
    );
  }
});

// Date.parse alone accepts "123" and rolls 2026-02-30 into March; the value is
// echoed verbatim into frontmatter, so the full ISO shape is required.
test("nowIso must be a full ISO instant with a real calendar date", () => {
  for (const bad of ["", "   ", "123", "2026-01-01", "2026-02-30T00:00:00Z", "nope"]) {
    assert.throws(
      () => buildMergeFrontmatterUpdate({ incomingSources: [source()], nowIso: bad }),
      /nowIso/,
    );
  }
  assert.equal(
    buildMergeFrontmatterUpdate({ incomingSources: [source()], nowIso: "2026-08-19T12:00:00+02:00" }).updated,
    "2026-08-19T12:00:00+02:00",
  );
});

test("empty incomingSources still bumps the counter and preserves target sources", () => {
  const update = buildMergeFrontmatterUpdate({
    targetSources: [source()],
    incomingSources: [],
    targetReinforcementCount: 1,
    nowIso: NOW,
  });
  assert.equal(update.sources.length, 1);
  assert.equal(update.reinforcement_count, 2);
});

test("inputs are not mutated", () => {
  const target = [source({ turnId: "t" })];
  const incoming = [source({ quote: "other" })];
  const snapshot = JSON.stringify({ target, incoming });
  buildMergeFrontmatterUpdate({ targetSources: target, incomingSources: incoming, nowIso: NOW });
  assert.equal(JSON.stringify({ target, incoming }), snapshot);
});
