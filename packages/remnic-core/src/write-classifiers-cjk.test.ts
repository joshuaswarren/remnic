/**
 * Issue #2192: write-path classifiers must not dump non-English content
 * into the lowest importance/taxonomy bucket merely for lacking English
 * tokens. Script-agnostic signals (weighted length, CJK bigrams) carry the
 * decision instead of English keywords.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { scoreImportance } from "./importance.js";
import { extractTopics } from "./topics.js";
import { DEFAULT_TAXONOMY } from "./taxonomy/default-taxonomy.js";
import { resolveCategory } from "./taxonomy/resolver.js";
import type { Taxonomy } from "./taxonomy/types.js";
import type { MemoryFile, MemoryFrontmatter } from "./types.js";

function makeMemory(id: string, content: string): MemoryFile {
  const frontmatter: MemoryFrontmatter = {
    id,
    category: "fact",
    created: "2026-08-17T00:00:00.000Z",
    updated: "2026-08-17T00:00:00.000Z",
    source: "extraction",
    confidence: 0.8,
    confidenceTier: "explicit",
    tags: [],
  };
  return { path: `/memories/facts/2026-08-17/${id}.md`, frontmatter, content };
}

test("importance: dense Japanese/Chinese facts stay out of the trivial/low buckets", () => {
  // 12 CJK chars ≈ a full English clause ("I will move to Tokyo next month").
  // Before #2192 this matched the raw `^.{1,10}$` short-content rule and was
  // scored trivial — dropping it at the write gate.
  const japanese = scoreImportance("来月、東京に引っ越します。", "commitment");
  assert.ok(
    japanese.score >= 0.4,
    `Japanese commitment scored ${japanese.score} (${japanese.level})`,
  );
  assert.notEqual(japanese.level, "trivial");
  assert.notEqual(japanese.level, "low");

  const chinese = scoreImportance("会议定在周五下午两点，请准时参加。", "fact");
  assert.ok(
    chinese.score >= 0.4,
    `Chinese meeting fact scored ${chinese.score} (${chinese.level})`,
  );
  assert.notEqual(chinese.level, "trivial");
  assert.notEqual(chinese.level, "low");

  // Keywords must not be empty for non-Latin content (CJK bigram fallback).
  assert.ok(
    japanese.keywords.length > 0,
    `expected CJK bigram keywords, got ${JSON.stringify(japanese.keywords)}`,
  );
});

test("importance: genuinely trivial CJK interjections stay trivial", () => {
  // "はい" ≈ "yes" — 2 glyphs, weighted length 6, still under the cutoff.
  assert.equal(scoreImportance("はい", "fact").level, "trivial");
  assert.equal(scoreImportance("嗯", "fact").level, "trivial");
});

test("taxonomy: CJK filing rules match CJK content instead of the fallback pick", () => {
  const taxonomy: Taxonomy = {
    version: 1,
    categories: [
      {
        id: "paris-notes",
        name: "Paris Notes",
        description: "Statements about Paris",
        filingRules: ["paris seine arrondissement"],
        // Lower priority wins the pre-fix keyword-less tie-break, so this
        // fixture fails unless CJK content actually matches CJK filing rules.
        priority: 10,
        memoryCategories: ["fact"],
      },
      {
        id: "tokyo-notes",
        name: "Tokyo Notes",
        description: "東京に関する事実",
        filingRules: ["東京 についての記録"],
        priority: 40,
        memoryCategories: ["fact"],
      },
    ],
  };

  const decision = resolveCategory("東京に住んでいます。", "fact", taxonomy);
  assert.equal(decision.categoryId, "tokyo-notes");
  assert.ok(decision.confidence >= 0.9, `confidence ${decision.confidence}`);
});

test("taxonomy: default taxonomy resolution is unchanged for non-Latin facts", () => {
  const decision = resolveCategory("会議は金曜日の午後です。", "fact", DEFAULT_TAXONOMY);
  assert.equal(decision.categoryId, "facts");
  assert.equal(decision.confidence, 1.0);
});

test("topics: CJK memories contribute topics via bigrams", () => {
  const topics = extractTopics(
    [
      makeMemory(
        "fact-cjk",
        "東京に住んでいます。東京の会社で働いています。",
      ),
      makeMemory("fact-en", "Deployed the api server to production."),
    ],
    20,
  );

  const tokyo = topics.find((t) => t.term === "東京");
  assert.ok(tokyo, `expected 東京 in topics: ${JSON.stringify(topics)}`);
  assert.ok(tokyo.count >= 2, `expected 東京 twice, got ${tokyo.count}`);
});
