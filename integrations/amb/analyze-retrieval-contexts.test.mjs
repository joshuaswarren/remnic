import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "analyze-retrieval-contexts.mjs");

function runAnalyzer(data) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "remnic-amb-analyzer-"));
  try {
    const file = path.join(tempDir, "retrieval.json");
    writeFileSync(file, JSON.stringify(data), "utf8");
    const output = execFileSync(process.execPath, [script, file], {
      encoding: "utf8",
    });
    return JSON.parse(output);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("retrieval analyzer tracks numeric gold answers without rubric boilerplate noise", () => {
  const summary = runAnalyzer({
    dataset: "beam",
    split: "100k",
    diagnostic: "retrieval-only",
    results: [
      {
        query_id: "numeric-answer",
        query: "How many total ways?",
        gold_answers: ["15"],
        meta: {
          question_category: "multi_session_reasoning",
          rubric: ["LLM response should state: 15"],
        },
        context: "The user mentioned 6 arrangements and 9 choices, for 15 total ways.",
      },
    ],
  });

  assert.equal(summary.lowCoverageCount, 0);
  assert.equal(summary.lowestCoverage[0].coverage, 1);
  assert.deepEqual(summary.lowestCoverage[0].missing, []);
});
