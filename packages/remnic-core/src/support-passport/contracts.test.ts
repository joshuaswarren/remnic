import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SupportPassportCardListSchema,
  SupportPassportCardSchema,
  SupportPassportManualDraftInputSchema,
  SupportPassportNamespaceSchema,
  SupportPassportReplaceCardInputSchema,
  computeSupportPassportCardRevision,
} from "./contracts.js";

function makeCard(cardId: string) {
  const fields = {
    cardId,
    title: "Quiet space",
    statement: "Offer me a quiet place and time.",
    category: "environment" as const,
    status: "active" as const,
    updatedAt: "2026-08-11T12:00:00.000Z",
    reviewBy: "2027-02-07T12:00:00.000Z",
  };
  return { ...fields, revision: computeSupportPassportCardRevision(fields) };
}

test("the public support card contract rejects unknown fields", () => {
  assert.equal(SupportPassportCardSchema.safeParse({ ...makeCard("card-1"), note: "private" }).success, false);
});

test("the support card list contract rejects duplicate card IDs", () => {
  const card = makeCard("card-1");
  assert.equal(SupportPassportCardListSchema.safeParse([card, card]).success, false);
});

test("manual and replacement drafts require the owner's review date", () => {
  const draft = {
    principal: "owner:alice",
    title: "Quiet space",
    statement: "Offer me a quiet place and time.",
    category: "environment",
  };
  assert.equal(SupportPassportManualDraftInputSchema.safeParse(draft).success, false);
  assert.equal(
    SupportPassportReplaceCardInputSchema.safeParse({
      ...draft,
      cardId: "card-1",
      expectedRevision: "a".repeat(64),
    }).success,
    false
  );
});

test("support card dates reject invalid calendar values and timezone offsets", () => {
  for (const reviewBy of ["2027-02-31T12:00:00Z", "2027-01-01T00:00:00+25:00"]) {
    const draft = {
      principal: "owner:alice",
      title: "Quiet space",
      statement: "Offer me a quiet place and time.",
      category: "environment",
      reviewBy,
    };
    assert.equal(SupportPassportManualDraftInputSchema.safeParse(draft).success, false);
    assert.equal(
      SupportPassportReplaceCardInputSchema.safeParse({
        ...draft,
        cardId: "card-1",
        expectedRevision: "a".repeat(64),
      }).success,
      false
    );
    assert.equal(SupportPassportCardSchema.safeParse({ ...makeCard("card-1"), reviewBy }).success, false);
  }
});

test("support card titles reject attribute delimiters and line breaks", () => {
  for (const title of ["Quiet ] space", "Quiet\nspace", "Quiet\rspace"]) {
    const manualDraft = {
      principal: "owner:alice",
      title,
      statement: "Offer me a quiet place and time.",
      category: "environment",
      reviewBy: "2027-02-07T12:00:00.000Z",
    };
    assert.equal(SupportPassportManualDraftInputSchema.safeParse(manualDraft).success, false);
    assert.equal(
      SupportPassportReplaceCardInputSchema.safeParse({
        ...manualDraft,
        cardId: "card-1",
        expectedRevision: "a".repeat(64),
      }).success,
      false
    );
    assert.equal(SupportPassportCardSchema.safeParse({ ...makeCard("card-1"), title }).success, false);
  }
});

test("support passport namespaces reject path and attribute delimiters", () => {
  for (const namespace of ["alice/bob", "alice\\bob", "alice]bob", "alice:bob"]) {
    assert.equal(SupportPassportNamespaceSchema.safeParse(namespace).success, false);
  }
  assert.equal(SupportPassportNamespaceSchema.safeParse("team.alpha-1").success, true);
});

test("support card revisions change when any public field changes", () => {
  const initial = makeCard("card-1");
  const changed = computeSupportPassportCardRevision({
    cardId: initial.cardId,
    title: initial.title,
    statement: "Offer me a quiet room and time.",
    category: initial.category,
    status: initial.status,
    updatedAt: initial.updatedAt,
    reviewBy: initial.reviewBy,
  });
  assert.notEqual(changed, initial.revision);
});

test("support card revisions ignore object key insertion order", () => {
  const initial = makeCard("card-1");
  const reordered = {
    reviewBy: initial.reviewBy,
    updatedAt: initial.updatedAt,
    status: initial.status,
    category: initial.category,
    statement: initial.statement,
    title: initial.title,
    cardId: initial.cardId,
  };

  assert.equal(computeSupportPassportCardRevision(reordered), initial.revision);
});
