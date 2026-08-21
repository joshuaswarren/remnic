import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCoReferences, anchorTemporalExpressions } from "../src/delinearize.js";
import type { EntityMention } from "../src/types.js";

describe("resolveCoReferences", () => {
  it("replaces pronouns with entity names when unambiguous", () => {
    const fact = "He prefers TypeScript over JavaScript";
    const entities = [{ name: "person-joshua-warren", type: "person" as const, facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "person-joshua-warren prefers TypeScript over JavaScript");
  });

  it("does not replace when multiple same-type entities are ambiguous", () => {
    const fact = "He prefers TypeScript";
    const entities = [
      { name: "person-alice", type: "person" as const, facts: [] },
      { name: "person-bob", type: "person" as const, facts: [] },
    ];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "He prefers TypeScript"); // unchanged — ambiguous
  });

  it("resolves 'they' to a company/project when unambiguous", () => {
    const fact = "They use Redis for caching";
    const entities = [{ name: "company-acme", type: "company" as const, facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "company-acme use Redis for caching");
  });

  it("replaces possessive pronoun with entity's", () => {
    const fact = "His preferred stack is Python";
    const entities: EntityMention[] = [{ name: "person-alice", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "person-alice's preferred stack is Python");
  });

  it("leaves 'her' unchanged because it is ambiguous (object vs possessive)", () => {
    const fact = "Her preferred stack is Python";
    const entities: EntityMention[] = [{ name: "person-alice", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "Her preferred stack is Python"); // ambiguous — no replacement
  });

  it("leaves facts unchanged when no entities provided", () => {
    const fact = "He said something";
    const result = resolveCoReferences(fact, []);
    assert.equal(result, "He said something");
  });

  it("replaces all occurrences of a pronoun, not just the first", () => {
    const fact = "He said he prefers TypeScript";
    const entities: EntityMention[] = [{ name: "person-bob", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "person-bob said person-bob prefers TypeScript");
  });

  it("handles entity names containing $ without corruption", () => {
    const fact = "He runs the company";
    const entities: EntityMention[] = [{ name: "company-$uper", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "company-$uper runs the company");
  });

  it("does not corrupt entity names containing pronoun substrings", () => {
    const fact = "It crashed yesterday";
    const entities: EntityMention[] = [
      { name: "project-it-works", type: "project", facts: [] },
    ];
    const result = resolveCoReferences(fact, entities);
    // "It" → project-it-works, but the "it" inside "project-it-works" must not be re-matched
    assert.equal(result, "project-it-works crashed yesterday");
  });

  it("skips resolution when multiple pronoun groups would resolve to same single entity", () => {
    const fact = "She told him the news";
    const entities: EntityMention[] = [{ name: "person-alice", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    // "she" (fem group) + "him" (masc group) both → person, only one entity — ambiguous
    assert.equal(result, "She told him the news");
  });

  it("leaves contractions unchanged (He's, It's, They're)", () => {
    const fact = "He's a great developer";
    const entities: EntityMention[] = [{ name: "person-bob", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    assert.equal(result, "He's a great developer"); // contraction, not possessive
  });

  it("resolves coreferential pronoun pairs from the same group", () => {
    const fact = "He organized his files";
    const entities: EntityMention[] = [{ name: "person-bob", type: "person", facts: [] }];
    const result = resolveCoReferences(fact, entities);
    // "he" + "his" are both "masc" group — same referent, not ambiguous
    assert.equal(result, "person-bob organized person-bob's files");
  });
});

describe("anchorTemporalExpressions", () => {
  it("replaces 'yesterday' with absolute date", () => {
    const fact = "Deployed the fix yesterday";
    const now = new Date("2026-03-06T15:00:00Z");
    const result = anchorTemporalExpressions(fact, now);
    assert.equal(result, "Deployed the fix on 2026-03-05");
  });

  it("replaces 'last week' with date range", () => {
    const fact = "Started the project last week";
    const now = new Date("2026-03-06T15:00:00Z");
    const result = anchorTemporalExpressions(fact, now);
    assert.match(result, /Started the project around 2026-02-2/);
  });

  it("replaces 'today' with absolute date", () => {
    const fact = "Fixed the bug today";
    const now = new Date("2026-03-06T15:00:00Z");
    const result = anchorTemporalExpressions(fact, now);
    assert.equal(result, "Fixed the bug on 2026-03-06");
  });

  it("leaves absolute dates unchanged", () => {
    const fact = "Deployed on 2026-03-01";
    const now = new Date("2026-03-06T15:00:00Z");
    const result = anchorTemporalExpressions(fact, now);
    assert.equal(result, "Deployed on 2026-03-01");
  });

  it("handles 'this morning' relative to timestamp", () => {
    const fact = "Discussed the issue this morning";
    const now = new Date("2026-03-06T15:00:00Z");
    const result = anchorTemporalExpressions(fact, now);
    assert.equal(result, "Discussed the issue on the morning of 2026-03-06");
  });
});
