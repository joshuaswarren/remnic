/**
 * Topic Extraction (Phase 4B)
 *
 * Extract key topics from all memories using TF-IDF weighting.
 * Runs as a batch process during consolidation.
 */

import type { MemoryFile, TopicScore } from "./types.js";
import { cjkBigrams } from "./utils/script-aware-text.js";

/** Stop words to exclude from topic extraction */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "to", "of",
  "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
  "during", "before", "after", "above", "below", "between", "this", "that",
  "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "she", "it", "they", "them", "their", "what", "which", "who", "how",
  "when", "where", "why", "and", "but", "or", "if", "because", "so",
  "just", "about", "like", "also", "very", "really", "here", "there",
  "now", "then", "only", "even", "still", "already", "always", "never",
  "often", "sometimes", "usually", "well", "much", "more", "most", "some",
  "any", "all", "each", "every", "both", "few", "many", "other", "same",
  "such", "own", "than", "too", "very", "just", "over", "under", "again",
  "further", "once", "here", "there", "when", "where", "why", "how",
  "user", "agent", "memory", "fact", "preference", "using", "used", "use",
]);

/**
 * Extract terms from content.
 * Returns normalized lowercase terms >= 3 chars, plus CJK bigrams so
 * non-Latin memories contribute topics instead of none (issue #2192).
 */
function extractTerms(content: string): string[] {
  const latin = content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...latin, ...cjkBigrams(content)];
}

/**
 * Calculate TF-IDF scores for terms across all memories.
 *
 * TF (term frequency) = count of term in document / total terms in document
 * IDF (inverse document frequency) = log(total documents / documents containing term)
 * TF-IDF = TF * IDF
 *
 * Terms with high TF-IDF are frequent in specific memories but rare overall.
 */
export function extractTopics(
  memories: MemoryFile[],
  topN: number = 50,
): TopicScore[] {
  if (memories.length === 0) return [];

  // Count term frequency per document and document frequency
  const docFreq = new Map<string, number>(); // term -> number of documents containing it
  const termFreqPerDoc: Map<string, number>[] = []; // per-doc term frequencies

  for (const memory of memories) {
    const terms = extractTerms(memory.content);
    const termFreq = new Map<string, number>();

    for (const term of terms) {
      termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }

    // Track which terms appear in this document
    for (const term of termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }

    termFreqPerDoc.push(termFreq);
  }

  const totalDocs = memories.length;

  // Calculate TF-IDF for each term
  const tfidfScores = new Map<string, { score: number; count: number }>();

  for (let i = 0; i < memories.length; i++) {
    const termFreq = termFreqPerDoc[i];
    const totalTerms = [...termFreq.values()].reduce((a, b) => a + b, 0);

    for (const [term, count] of termFreq) {
      const tf = count / totalTerms;
      const df = docFreq.get(term) ?? 1;
      const idf = Math.log(totalDocs / df);
      const tfidf = tf * idf;

      const existing = tfidfScores.get(term);
      if (existing) {
        existing.score += tfidf;
        existing.count += count;
      } else {
        tfidfScores.set(term, { score: tfidf, count });
      }
    }
  }

  // Convert to array and sort by score
  const topics: TopicScore[] = [...tfidfScores.entries()]
    .map(([term, { score, count }]) => ({ term, score, count }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return topics;
}

/**
 * Compare two topic lists to find trending changes.
 * Returns topics that are new or significantly increased.
 */
export function findTrendingTopics(
  currentTopics: TopicScore[],
  previousTopics: TopicScore[],
  threshold: number = 0.5,
): { rising: TopicScore[]; falling: TopicScore[] } {
  const prevMap = new Map(previousTopics.map((t) => [t.term, t.score]));
  const currMap = new Map(currentTopics.map((t) => [t.term, t.score]));

  const rising: TopicScore[] = [];
  const falling: TopicScore[] = [];

  for (const topic of currentTopics) {
    const prevScore = prevMap.get(topic.term) ?? 0;
    const change = topic.score - prevScore;

    if (change > threshold) {
      rising.push({ ...topic, score: change });
    }
  }

  for (const topic of previousTopics) {
    const currScore = currMap.get(topic.term) ?? 0;
    const change = topic.score - currScore;

    if (change > threshold && currScore < topic.score * 0.5) {
      falling.push({ ...topic, score: change });
    }
  }

  return {
    rising: rising.sort((a, b) => b.score - a.score).slice(0, 10),
    falling: falling.sort((a, b) => b.score - a.score).slice(0, 10),
  };
}
