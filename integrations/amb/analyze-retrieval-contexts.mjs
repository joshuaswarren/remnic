#!/usr/bin/env node
import { readFileSync } from "node:fs";

const STOPWORDS = new Set([
  "about", "above", "after", "again", "against", "also", "answer", "based",
  "because", "before", "being", "between", "chat", "contain", "contains",
  "could", "does", "done", "during", "each", "from", "have", "having",
  "here", "into", "llm", "mention", "mentioned", "mentions", "more",
  "must", "only", "other", "provided", "question", "related", "response",
  "should", "state",
  "some", "such", "that", "their", "there", "these", "they", "this",
  "those", "through", "user", "using", "what", "when", "where", "which",
  "while", "with", "would",
]);

function usage() {
  console.log(`Usage:
  integrations/amb/analyze-retrieval-contexts.mjs /path/to/retrieval.json [options]

Options:
  --min-coverage N   Coverage threshold for flagged rows. Default: 0.35.
  --top N            Number of lowest-coverage rows to print. Default: 10.
`);
}

function parseArgs(argv) {
  const args = { file: "", minCoverage: 0.35, top: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--min-coverage":
        args.minCoverage = Number(argv[++index] ?? "");
        break;
      case "--top":
        args.top = Number(argv[++index] ?? "");
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
  if (!Number.isFinite(args.minCoverage) || args.minCoverage < 0 || args.minCoverage > 1) {
    throw new Error("--min-coverage must be a number in [0, 1]");
  }
  if (!Number.isInteger(args.top) || args.top < 0) {
    throw new Error("--top must be a non-negative integer");
  }
  return args;
}

function tokens(text) {
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{2,}|\d+(?:\.\d+)?%?/g) ?? [],
    ),
  ].filter((token) => !STOPWORDS.has(token));
}

function targetText(result) {
  const rubric = Array.isArray(result.meta?.rubric)
    ? result.meta.rubric.join("\n")
    : "";
  const gold = Array.isArray(result.gold_answers)
    ? result.gold_answers.join("\n")
    : "";
  return `${rubric}\n${gold}`;
}

function analyzeResult(result) {
  const targetTokens = tokens(targetText(result));
  const context = String(result.context ?? "").toLowerCase();
  const matched = targetTokens.filter((token) => context.includes(token));
  const missing = targetTokens.filter((token) => !context.includes(token));
  const coverage = targetTokens.length === 0
    ? (context.trim() ? 1 : 0)
    : matched.length / targetTokens.length;
  return {
    queryId: result.query_id,
    category: result.meta?.question_category ?? null,
    coverage,
    targetTokens: targetTokens.length,
    matched: matched.slice(0, 20),
    missing: missing.slice(0, 20),
    contextChars: result.context_chars ?? String(result.context ?? "").length,
    contextTokens: result.context_tokens ?? null,
    retrieveTimeMs: result.retrieve_time_ms ?? null,
    query: result.query,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(args.file, "utf8"));
  const rows = (data.results ?? []).map(analyzeResult);
  const lowCoverage = rows.filter((row) => row.coverage < args.minCoverage);
  const zeroContext = rows.filter((row) => row.contextChars === 0);
  const sorted = [...rows].sort((left, right) =>
    left.coverage - right.coverage ||
    left.contextChars - right.contextChars ||
    String(left.queryId).localeCompare(String(right.queryId)),
  );
  const avgCoverage = rows.length === 0
    ? 0
    : rows.reduce((sum, row) => sum + row.coverage, 0) / rows.length;

  console.log(JSON.stringify({
    file: args.file,
    dataset: data.dataset,
    split: data.split,
    diagnostic: data.diagnostic,
    totalQueries: rows.length,
    loadedDocuments: data.loaded_documents ?? null,
    ingestedDocs: data.ingested_docs ?? null,
    averageCoverage: Number(avgCoverage.toFixed(4)),
    minCoverage: rows.length ? Number(Math.min(...rows.map((row) => row.coverage)).toFixed(4)) : null,
    lowCoverageThreshold: args.minCoverage,
    lowCoverageCount: lowCoverage.length,
    zeroContextCount: zeroContext.length,
    lowestCoverage: sorted.slice(0, args.top).map((row) => ({
      ...row,
      coverage: Number(row.coverage.toFixed(4)),
    })),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
