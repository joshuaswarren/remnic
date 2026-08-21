import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeTrainingPairs } from "./synthesizer.js";
import type { TrainingExportRecord } from "@remnic/core";

function makeRecord(
  overrides: Partial<TrainingExportRecord> = {},
): TrainingExportRecord {
  return {
    instruction: overrides.instruction ?? "Recall a memory",
    input: overrides.input ?? "",
    output: overrides.output ?? "Some memory content.",
    ...overrides,
  };
}

describe("synthesizeTrainingPairs", () => {
  it("generates preference-style questions for category=preference", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food, cooking)",
        category: "preference",
        output: "I love sushi and ramen.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1, "should generate at least one pair");
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("like") || q.includes("preference") || q.includes("favorite"),
      `expected preference-style question, got: "${pairs[0].instruction}"`,
    );
    assert.equal(pairs[0].output, "I love sushi and ramen.");
  });

  it("generates opinion-style questions for category=correction", () => {
    const records = [
      makeRecord({
        instruction: "Recall a correction (technology)",
        category: "correction",
        output: "TypeScript is superior to plain JavaScript for large projects.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("think") || q.includes("feel") || q.includes("opinion"),
      `expected opinion-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates opinion-style questions for category=decision", () => {
    const records = [
      makeRecord({
        instruction: "Recall a decision (architecture)",
        category: "decision",
        output: "We chose PostgreSQL for the backend.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("think") || q.includes("feel") || q.includes("opinion"),
      `expected opinion-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates expertise-style questions for category=fact", () => {
    const records = [
      makeRecord({
        instruction: "Recall a factual memory (databases)",
        category: "fact",
        output: "PostgreSQL excels at complex queries and JSONB support.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("know") || q.includes("explain"),
      `expected expertise-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates expertise-style questions for category=entity", () => {
    const records = [
      makeRecord({
        instruction: "Recall entity information (PostgreSQL)",
        category: "entity",
        output: "PostgreSQL is an open-source relational database.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("know") || q.includes("explain"),
      `expected expertise-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates expertise-style questions for category=skill", () => {
    const records = [
      makeRecord({
        instruction: "Recall a skill (TypeScript)",
        category: "skill",
        output: "Proficient in TypeScript generics and type inference.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("know") || q.includes("explain"),
      `expected expertise-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates personal-style questions for category=personal", () => {
    const records = [
      makeRecord({
        instruction: "Recall a memory (hobbies)",
        category: "personal",
        output: "I enjoy hiking on weekends.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("your"),
      `expected personal-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates personal-style questions for category=relationship", () => {
    const records = [
      makeRecord({
        instruction: "Recall a relationship (team)",
        category: "relationship",
        output: "Works closely with the infrastructure team.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("your"),
      `expected personal-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates personal-style questions for category=commitment", () => {
    const records = [
      makeRecord({
        instruction: "Recall a commitment (fitness)",
        category: "commitment",
        output: "Committed to running 5k three times a week.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("your"),
      `expected personal-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates personal-style questions for category=moment", () => {
    const records = [
      makeRecord({
        instruction: "Recall a moment (graduation)",
        category: "moment",
        output: "Graduated with honors in 2020.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("your"),
      `expected personal-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates opinion-style questions for category=principle", () => {
    const records = [
      makeRecord({
        instruction: "Recall a principle (design)",
        category: "principle",
        output: "Always prefer composition over inheritance.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("think") || q.includes("feel") || q.includes("opinion"),
      `expected opinion-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("generates opinion-style questions for category=rule", () => {
    const records = [
      makeRecord({
        instruction: "Recall a rule (code style)",
        category: "rule",
        output: "Max line length is 120 characters.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("think") || q.includes("feel") || q.includes("opinion"),
      `expected opinion-style question, got: "${pairs[0].instruction}"`,
    );
  });

  it("falls back to default templates for unknown category", () => {
    const records = [
      makeRecord({
        instruction: "Recall a memory (random)",
        category: "unknown_type",
        output: "The sky is blue on clear days.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    // Default templates use "Tell me about" / "What can you share about"
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("share"),
      `expected default question, got: "${pairs[0].instruction}"`,
    );
    assert.equal(pairs[0].output, "The sky is blue on clear days.");
  });

  it("falls back to default templates when category is undefined", () => {
    const records = [
      makeRecord({
        instruction: "Recall a memory",
        output: "Something happened.",
      }),
    ];
    // category is undefined by default in makeRecord

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("tell") || q.includes("share"),
      `expected default question, got: "${pairs[0].instruction}"`,
    );
  });

  it("extracts topic from parenthesized tags in instruction", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food, cooking)",
        category: "preference",
        output: "I love sushi.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    // The question should contain "food, cooking" from the tags
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("food, cooking"),
      `expected topic from tags, got: "${pairs[0].instruction}"`,
    );
  });

  it("uses 'this' as topic when instruction has no parenthesized tags", () => {
    const records = [
      makeRecord({
        instruction: "Recall a factual memory",
        category: "fact",
        output: "Water boils at 100C.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    const q = pairs[0].instruction.toLowerCase();
    assert.ok(
      q.includes("this"),
      `expected fallback topic 'this', got: "${pairs[0].instruction}"`,
    );
  });

  it("respects maxPairsPerRecord limit", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (music)",
        category: "preference",
        output: "I enjoy jazz, classical, and electronic music.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records, { maxPairsPerRecord: 1 });
    assert.equal(pairs.length, 1);
  });

  it("generates multiple pairs when maxPairsPerRecord allows", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (music)",
        category: "preference",
        output: "I enjoy jazz.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records, { maxPairsPerRecord: 3 });
    assert.equal(pairs.length, 3);

    // Each pair should have a different question
    const questions = pairs.map((p) => p.instruction);
    const unique = new Set(questions);
    assert.equal(unique.size, 3, "all 3 questions should be distinct");
  });

  it("defaults maxPairsPerRecord to 1", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food)",
        category: "preference",
        output: "I like pizza.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs.length, 1);
  });

  it("rejects invalid maxPairsPerRecord values", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (music)",
        category: "preference",
        output: "I enjoy jazz.",
      }),
    ];

    for (const maxPairsPerRecord of [1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => synthesizeTrainingPairs(records, { maxPairsPerRecord }),
        /maxPairsPerRecord must be a finite positive integer/,
        `expected ${String(maxPairsPerRecord)} to be rejected`,
      );
    }
  });

  it("applies style markers - lowercase output", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food)",
        category: "preference",
        output: "I Love Sushi.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records, {
      styleMarkers: {
        avgSentenceLength: 5,
        usesEmoji: false,
        formality: "casual",
        usesLowercase: true,
        commonPhrases: [],
      },
    });

    assert.ok(pairs.length >= 1);
    assert.equal(pairs[0].output, pairs[0].output.toLowerCase());
  });

  it("preserves input field as empty string", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (color)",
        category: "preference",
        output: "Blue is my favorite color.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs[0].input, "");
  });

  it("handles multiple records with different categories", () => {
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food)",
        category: "preference",
        output: "I like pizza.",
      }),
      makeRecord({
        instruction: "Recall a correction (technology)",
        category: "correction",
        output: "Rust is fast.",
      }),
      makeRecord({
        instruction: "Recall a factual memory (math)",
        category: "fact",
        output: "Pi is irrational.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);
    assert.equal(pairs.length, 3);

    // First record: preference -> "like"/"preference"/"favorite"
    const q0 = pairs[0].instruction.toLowerCase();
    assert.ok(
      q0.includes("like") || q0.includes("preference") || q0.includes("favorite"),
      `expected preference question, got: "${pairs[0].instruction}"`,
    );

    // Second record: correction -> "think"/"feel"/"opinion"
    const q1 = pairs[1].instruction.toLowerCase();
    assert.ok(
      q1.includes("think") || q1.includes("feel") || q1.includes("opinion"),
      `expected opinion question, got: "${pairs[1].instruction}"`,
    );

    // Third record: fact -> "tell"/"know"/"explain"
    const q2 = pairs[2].instruction.toLowerCase();
    assert.ok(
      q2.includes("tell") || q2.includes("know") || q2.includes("explain"),
      `expected expertise question, got: "${pairs[2].instruction}"`,
    );
  });

  it("preserves category and confidence in output records", () => {
    const records = [
      makeRecord({
        instruction: "Recall a factual memory (databases)",
        category: "fact",
        confidence: 0.95,
        output: "PostgreSQL supports JSONB.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.equal(pairs[0].category, "fact");
    assert.equal(pairs[0].confidence, 0.95);
  });

  it("handles instruction with many nested open-parens without slowdown (CodeQL ReDoS fix)", () => {
    // Regression: /\(([^)]+)\)/ causes O(n^2) backtracking on inputs
    // with many '((' because [^)] matches '('. Fixed to /\(([^()]+)\)/.
    const malicious = "(" + "(".repeat(5000);
    const records = [
      makeRecord({
        instruction: malicious,
        category: "fact",
        output: "Should not hang.",
      }),
    ];

    const start = performance.now();
    const pairs = synthesizeTrainingPairs(records);
    const elapsed = performance.now() - start;

    assert.ok(pairs.length >= 1);
    // No parenthesized content found, so topic should be "this"
    assert.ok(
      pairs[0].instruction.toLowerCase().includes("this"),
      `expected fallback topic 'this', got: "${pairs[0].instruction}"`,
    );
    // Must complete in under 50ms (was 600ms+ before the fix at n=10000)
    assert.ok(
      elapsed < 50,
      `regex should be O(n), took ${elapsed.toFixed(1)}ms`,
    );
  });

  it("does not produce generic 'this' questions when tags are available", () => {
    // Regression test: the old bug had parseCategory(record.instruction) which
    // always fell back to subTopic="this" because instructions are natural
    // language, not category paths. Now we use record.category for template
    // selection and extract tags from instruction for the topic.
    const records = [
      makeRecord({
        instruction: "Recall a user preference (food, cooking)",
        category: "preference",
        output: "I love Italian cuisine.",
      }),
    ];

    const pairs = synthesizeTrainingPairs(records);

    assert.ok(pairs.length >= 1);
    // The question should NOT be "What kind of this do you like?"
    assert.ok(
      !pairs[0].instruction.includes("{topic}"),
      "template variable should be replaced",
    );
    assert.ok(
      !pairs[0].instruction.toLowerCase().includes("what kind of this"),
      `should not produce generic 'this' question when tags exist, got: "${pairs[0].instruction}"`,
    );
    assert.ok(
      pairs[0].instruction.toLowerCase().includes("food, cooking"),
      `should use tags as topic, got: "${pairs[0].instruction}"`,
    );
  });
});
