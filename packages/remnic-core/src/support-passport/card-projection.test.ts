import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { SupportPassportCardService as PublicSupportPassportCardService } from "../index.js";
import type { MemoryFile } from "../types.js";
import { computeSupportPassportOwnerKey, projectSupportPassportCard } from "./card-projection.js";
import { SupportPassportCardService } from "./card-service.js";
import { computeSupportPassportCardRevision } from "./contracts.js";

function makeMemory(
  overrides: {
    id?: string;
    title?: string;
    content?: string;
    order?: string;
    sourceMemoryIds?: string;
    status?: string;
    supportCategory?: string;
    blockedBy?: string;
    archivedAt?: string;
    supersededBy?: string;
    namespace?: string;
    owner?: string | null;
  } = {}
): MemoryFile {
  return {
    path: path.resolve(import.meta.dirname, "fixtures", "support-card.md"),
    content: overrides.content ?? "Offer me a quiet place and time.",
    frontmatter: {
      id: overrides.id ?? "support-card-1",
      category: "preference",
      source: "support-passport",
      confidence: 1,
      confidenceTier: "explicit",
      created: "2026-08-11T12:00:00.000Z",
      updated: "2026-08-11T12:00:00.000Z",
      status: (overrides.status ?? "active") as "active",
      blockedBy: overrides.blockedBy,
      archivedAt: overrides.archivedAt,
      supersededBy: overrides.supersededBy,
      tags: ["support-passport-card"],
      structuredAttributes: {
        ...(overrides.namespace === "" ? {} : { "support-passport-namespace": overrides.namespace ?? "alice" }),
        ...(overrides.owner === null
          ? {}
          : { "support-passport-owner": overrides.owner ?? computeSupportPassportOwnerKey("owner:alice") }),
        "support-passport-title": overrides.title ?? "Quiet space",
        "support-passport-category": overrides.supportCategory ?? "environment",
        "support-passport-order": overrides.order ?? "0",
        "support-passport-review-by": "2026-09-01T12:00:00.000Z",
        "support-passport-source-ids": overrides.sourceMemoryIds ?? "source-1,source-2",
      },
    },
  } as MemoryFile;
}

test("the support passport is exported from the public core package", () => {
  assert.equal(PublicSupportPassportCardService, SupportPassportCardService);
});

test("card projection normalizes IDs and public fields before revision hashing", () => {
  const projected = projectSupportPassportCard(
    makeMemory({
      id: " support-card-1 ",
      title: " Quiet space ",
      content: " Offer me a quiet place and time. ",
      sourceMemoryIds: "source-1, source-2 ",
    })
  );
  assert.ok(projected);
  assert.equal(projected.card.cardId, "support-card-1");
  assert.equal(projected.card.title, "Quiet space");
  assert.equal(projected.card.statement, "Offer me a quiet place and time.");
  assert.deepEqual(projected.sourceMemoryIds, ["source-1", "source-2"]);
  assert.equal(projected.namespace, "alice");
  const { revision, ...fields } = projected.card;
  assert.equal(revision, computeSupportPassportCardRevision(fields));
});

test("card projection rejects duplicate normalized source IDs", () => {
  assert.equal(projectSupportPassportCard(makeMemory({ sourceMemoryIds: "source-1, source-1 " })), null);
});

test("card projection rejects superseded status without relying on supersededBy", () => {
  assert.equal(projectSupportPassportCard(makeMemory({ status: "superseded" })), null);
});

test("card projection rejects invalid lifecycle and category fields", () => {
  assert.equal(projectSupportPassportCard(makeMemory({ namespace: "" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ supportCategory: "medical" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ status: "published" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ blockedBy: "memory-review" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ archivedAt: "2026-08-12T12:00:00.000Z" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ supersededBy: "replacement-card" })), null);
  assert.equal(projectSupportPassportCard(makeMemory({ owner: null })), null);
});

test("card projection accepts only canonical nonnegative decimal order values", () => {
  assert.ok(projectSupportPassportCard(makeMemory({ order: "0" })));
  for (const order of ["", " ", "00", "01", "+1", "-1", "0x10", "1.0"]) {
    assert.equal(projectSupportPassportCard(makeMemory({ order })), null);
  }
});
