#!/usr/bin/env node
import { readFileSync } from "node:fs";

const STOPWORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "and",
  "are",
  "based",
  "because",
  "before",
  "being",
  "between",
  "body",
  "can",
  "chat",
  "contain",
  "contains",
  "could",
  "did",
  "does",
  "during",
  "each",
  "from",
  "good",
  "have",
  "having",
  "here",
  "into",
  "make",
  "mention",
  "mentioned",
  "mentions",
  "more",
  "must",
  "only",
  "other",
  "provided",
  "question",
  "recommendations",
  "recommends",
  "related",
  "response",
  "separate",
  "should",
  "state",
  "some",
  "such",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "user",
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "your",
]);

function usage() {
  console.log(`Usage:
  integrations/amb/analyze-retrieval-nuggets.mjs /path/to/retrieval.json [options]

Options:
  --threshold N      Token recall threshold for a matched nugget. Default: 0.5.
  --top N            Number of lowest-scoring rows to print. Default: 20.
`);
}

function parseArgs(argv) {
  const args = { file: "", threshold: 0.5, top: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--threshold":
        args.threshold = Number(readRequiredOptionValue(argv, index, "--threshold"));
        index += 1;
        break;
      case "--top":
        args.top = Number(readRequiredOptionValue(argv, index, "--top"));
        index += 1;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        if (!args.file) {
          args.file = arg;
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }
  if (!args.file) throw new Error("retrieval JSON file is required");
  if (!Number.isFinite(args.threshold) || args.threshold < 0 || args.threshold > 1) {
    throw new Error("--threshold must be a number in [0, 1]");
  }
  if (!Number.isInteger(args.top) || args.top < 0) {
    throw new Error("--top must be a non-negative integer");
  }
  return args;
}

function readRequiredOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

function tokens(text) {
  return [
    ...new Set(
      normalizeText(text).match(/[a-z][a-z0-9-]{1,}|\d+(?:\.\d+)?%?/g) ?? [],
    ),
  ].filter((token) => !STOPWORDS.has(token));
}

function extractNugget(rawRubric) {
  const rubric = String(rawRubric ?? "").trim();
  if (!rubric) return "";

  const colonMatch = rubric.match(
    /(?:llm response should|response should|answer should)\s+(?:state|contain|include|mention|say|provide):\s*(.*)$/i,
  );
  if (colonMatch) return colonMatch[1]?.trim() ?? "";

  const abstentionMatch = rubric.match(
    /there is no information related to\s+(.+?)(?:\.|$)/i,
  );
  if (abstentionMatch?.[1]) {
    return `no information related to ${abstentionMatch[1].trim()}`;
  }

  return rubric
    .replace(/^LLM response should\s+/i, "")
    .replace(/^response should\s+/i, "")
    .trim();
}

function nuggetRows(result, threshold) {
  const context = normalizeText(result.context ?? "");
  const contextTokens = new Set(tokens(context));
  const rubrics = Array.isArray(result.meta?.rubric) ? result.meta.rubric : [];
  const goldAnswers = Array.isArray(result.gold_answers) ? result.gold_answers : [];
  const rubricNuggets = rubrics.map(extractNugget).filter(Boolean);
  const goldAnswerNuggets = goldAnswers
    .map((answer) => String(answer ?? "").trim())
    .filter(Boolean);
  const nuggets = rubricNuggets.length > 0 ? rubricNuggets : goldAnswerNuggets;

  return nuggets.map((nugget) => {
    const nuggetTokens = tokens(nugget);
    const matched = nuggetTokens.filter((token) => contextTokens.has(token));
    const missing = nuggetTokens.filter((token) => !contextTokens.has(token));
    const recall = nuggetTokens.length === 0 ? 0 : matched.length / nuggetTokens.length;
    return {
      nugget,
      recall,
      matched,
      missing,
      ok: recall >= threshold,
    };
  });
}

function rowScore(nuggets) {
  if (nuggets.length === 0) return 1;
  const matchedCount = nuggets.filter((nugget) => nugget.ok).length;
  if (matchedCount === nuggets.length) return 1;
  if (matchedCount > 0) return 0.5;
  return 0;
}

function summarizeRows(rows) {
  const score = rows.length === 0
    ? 0
    : rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
  const full = rows.filter((row) => row.score === 1).length;
  const partial = rows.filter((row) => row.score === 0.5).length;
  const miss = rows.filter((row) => row.score === 0).length;
  return {
    count: rows.length,
    score: Number(score.toFixed(4)),
    full,
    partial,
    miss,
  };
}

function categoryBreakdown(rows) {
  const byCategory = new Map();
  for (const row of rows) {
    const category = row.category ?? "unknown";
    const existing = byCategory.get(category) ?? [];
    existing.push(row);
    byCategory.set(category, existing);
  }
  return Object.fromEntries(
    [...byCategory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, categoryRows]) => [category, summarizeRows(categoryRows)]),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(args.file, "utf8"));
  const rows = (data.results ?? []).map((result) => {
    const nuggets = nuggetRows(result, args.threshold);
    return {
      queryId: result.query_id,
      category: result.meta?.question_category ?? null,
      query: result.query,
      score: rowScore(nuggets),
      nuggets: nuggets.map((nugget) => ({
        ...nugget,
        recall: Number(nugget.recall.toFixed(4)),
      })),
      contextChars: result.context_chars ?? String(result.context ?? "").length,
      contextTokens: result.context_tokens ?? null,
      retrieveTimeMs: result.retrieve_time_ms ?? null,
    };
  });

  const nonAbstentionRows = rows.filter((row) => row.category !== "abstention");
  const sorted = [...rows].sort((left, right) =>
    left.score - right.score ||
    left.contextChars - right.contextChars ||
    String(left.queryId).localeCompare(String(right.queryId)),
  );

  console.log(JSON.stringify({
    file: args.file,
    dataset: data.dataset,
    split: data.split,
    diagnostic: data.diagnostic,
    threshold: args.threshold,
    totalQueries: rows.length,
    loadedDocuments: data.loaded_documents ?? null,
    ingestedDocs: data.ingested_docs ?? null,
    ...summarizeRows(rows),
    nonAbstention: summarizeRows(nonAbstentionRows),
    categoryBreakdown: categoryBreakdown(rows),
    lowest: sorted.slice(0, args.top),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
