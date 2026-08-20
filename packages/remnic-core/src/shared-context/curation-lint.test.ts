import assert from "node:assert/strict";
import { test } from "node:test";

import { lintCuratedClaims } from "./curation-lint.js";

const AVAILABLE = ["item-1", "item-2", "item-3"];

test("a fully-cited claim set returns no findings", () => {
  const findings = lintCuratedClaims({
    claims: [
      { claimId: "c-1", citedItemIds: ["item-1", "item-2"] },
      { claimId: "c-2", citedItemIds: ["item-3"] },
    ],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, []);
});

test("missing citedItemIds gives no_citations", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1" }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [{ claimId: "c-1", reason: "no_citations" }]);
});

test("an empty citedItemIds array gives no_citations", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: [] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [{ claimId: "c-1", reason: "no_citations" }]);
});

test("an all-blank citedItemIds array gives no_citations", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: ["", "   ", "\t"] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [{ claimId: "c-1", reason: "no_citations" }]);
});

test("one valid plus one unknown citation gives unknown_citation listing only the unknown", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: ["item-1", "item-404"] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [
    { claimId: "c-1", reason: "unknown_citation", unknownIds: ["item-404"] },
  ]);
});

test("all-unknown citations give no_citations, not unknown_citation (precedence)", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: ["nope-1", "nope-2"] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [{ claimId: "c-1", reason: "no_citations" }]);
});

test("unknown ids are sorted ascending and deduplicated", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: ["item-1", "zz", "aa", "zz", "mm"] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [
    { claimId: "c-1", reason: "unknown_citation", unknownIds: ["aa", "mm", "zz"] },
  ]);
});

test("a whitespace-padded citation is unknown (exact comparison, no trim)", () => {
  const findings = lintCuratedClaims({
    claims: [{ claimId: "c-1", citedItemIds: ["item-1", " item-2"] }],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [
    { claimId: "c-1", reason: "unknown_citation", unknownIds: [" item-2"] },
  ]);
});

test("a blank claimId throws RangeError naming claimId", () => {
  assert.throws(
    () =>
      lintCuratedClaims({
        claims: [{ claimId: "   ", citedItemIds: ["item-1"] }],
        availableItemIds: AVAILABLE,
      }),
    (err: unknown) => err instanceof RangeError && /claimId/.test(err.message),
  );
});

test("duplicate claim ids are each linted independently", () => {
  const findings = lintCuratedClaims({
    claims: [
      { claimId: "c-1", citedItemIds: ["item-404", "item-1"] },
      { claimId: "c-1" },
    ],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(findings, [
    { claimId: "c-1", reason: "no_citations" },
    { claimId: "c-1", reason: "unknown_citation", unknownIds: ["item-404"] },
  ]);
});

test("findings are deterministic across two calls with shuffled input", () => {
  const expected: Array<{ claimId: string; reason: string; unknownIds?: string[] }> = [
    { claimId: "c-1", reason: "no_citations" },
    { claimId: "c-2", reason: "no_citations" },
    { claimId: "c-3", reason: "unknown_citation", unknownIds: ["item-404"] },
  ];
  const claims = [
    { claimId: "c-3", citedItemIds: ["item-3", "item-404"] },
    { claimId: "c-1" },
    { claimId: "c-2", citedItemIds: [] },
  ];
  const first = lintCuratedClaims({ claims, availableItemIds: AVAILABLE });
  const second = lintCuratedClaims({
    claims: [claims[2], claims[0], claims[1]],
    availableItemIds: AVAILABLE,
  });
  assert.deepEqual(first, expected);
  assert.deepEqual(second, expected);
});

test("inputs are not mutated", () => {
  const claims = [
    { claimId: "c-1", citedItemIds: ["zz", "item-1", "zz"] as const },
  ];
  const availableItemIds = ["item-1", "item-2"];
  const claimsSnapshot = structuredClone(claims);
  const availableSnapshot = [...availableItemIds];
  lintCuratedClaims({ claims, availableItemIds });
  assert.deepEqual(claims, claimsSnapshot);
  assert.deepEqual(availableItemIds, availableSnapshot);
});
