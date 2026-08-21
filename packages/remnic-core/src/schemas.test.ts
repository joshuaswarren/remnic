import assert from "node:assert/strict";
import test from "node:test";

import { ConsolidationResultSchema, ExtractionResultSchema } from "./schemas.js";

// Synthetic fixtures only — no real memory content (public repo).
const validFact = {
  category: "fact",
  content: "The API rate limit is 1000 requests per minute.",
  confidence: 0.8,
  tags: ["api"],
};

const validEntity = {
  name: "acme-corp",
  type: "company",
  facts: ["Uses PostgreSQL for the main database."],
};

const validQuestion = {
  question: "Which service enforces the rate limit?",
  context: "The limit shape suggests an upstream gateway.",
  priority: 0.4,
};

const validRelationship = {
  source: "person-jane-doe",
  target: "acme-corp",
  label: "works at",
};

function baseResult() {
  return {
    facts: [validFact],
    profileUpdates: ["Prefers concise status updates."],
    entities: [validEntity],
    questions: [validQuestion],
    relationships: [validRelationship],
  };
}

test("ExtractionResultSchema salvages valid facts from a mixed-invalid array (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    facts: [
      validFact,
      { category: "not-a-category", content: "x", confidence: 0.5, tags: [] },
      { category: "fact", content: "missing confidence", tags: [] },
      // procedure facts without steps fail the superRefine — salvage must
      // respect refinement issues, not just base-shape issues
      { category: "procedure", content: "Deploy the service.", confidence: 0.9, tags: ["deploy"] },
      "bare string is not a fact",
    ],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.facts, [validFact]);
});

test("ExtractionResultSchema fails when a non-empty facts array is wholly invalid (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    facts: [
      { category: "not-a-category", content: "x", confidence: 0.5, tags: [] },
      42,
    ],
  });

  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error.issues.some((issue) => issue.message.includes("no items matching the schema")),
  );
});

test("ExtractionResultSchema keeps explicitly empty arrays valid (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    facts: [],
    profileUpdates: [],
    entities: [],
    questions: [],
    relationships: [],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.facts, []);
  assert.deepEqual(parsed.data?.questions, []);
});

test("ExtractionResultSchema salvages valid entities from a mixed-invalid array (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    entities: [
      validEntity,
      { name: "bad-type", type: "organization", facts: ["nope"] },
      { name: "bad-facts", type: "person", facts: [17] },
      null,
    ],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.entities, [validEntity]);
});

test("ExtractionResultSchema fails when a non-empty entities array is wholly invalid (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    entities: [{ name: "bad-type", type: "organization", facts: ["nope"] }],
  });

  assert.equal(parsed.success, false);
});

test("ExtractionResultSchema salvages valid questions from a mixed-invalid array (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    questions: [
      validQuestion,
      { question: "no context", priority: 0.3 },
      { question: "bad priority", context: "out of range", priority: 5 },
    ],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.questions, [validQuestion]);
});

test("ExtractionResultSchema salvages valid profileUpdates and relationships (#2455)", () => {
  const parsed = ExtractionResultSchema.safeParse({
    ...baseResult(),
    profileUpdates: ["Prefers concise status updates.", 42, null],
    relationships: [validRelationship, { source: "jane-doe", label: "missing target" }],
  });

  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data?.profileUpdates, ["Prefers concise status updates."]);
  assert.deepEqual(parsed.data?.relationships, [validRelationship]);
});

test("ExtractionResultSchema still accepts null/omitted relationships (#2455)", () => {
  const nullParsed = ExtractionResultSchema.safeParse({ ...baseResult(), relationships: null });
  assert.equal(nullParsed.success, true);

  const omitted: Record<string, unknown> = { ...baseResult() };
  delete omitted.relationships;
  const omittedParsed = ExtractionResultSchema.safeParse(omitted);
  assert.equal(omittedParsed.success, true);
});

test("ConsolidationResultSchema stays strict on mixed-invalid arrays (#2455)", () => {
  const validItem = { existingId: "fact-1", action: "SKIP", reason: "still accurate" };
  const parsed = ConsolidationResultSchema.safeParse({
    items: [validItem, { existingId: "fact-2", action: "DESTROY", reason: "bad enum" }],
    profileUpdates: [],
    entityUpdates: [],
  });

  assert.equal(parsed.success, false);
});
