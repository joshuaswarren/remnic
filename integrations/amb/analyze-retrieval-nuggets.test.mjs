import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "analyze-retrieval-nuggets.mjs");

function runAnalyzer(data) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "remnic-amb-nugget-analyzer-"));
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

test("nugget analyzer scores exact numeric state rubrics", () => {
  const summary = runAnalyzer({
    dataset: "beam",
    split: "100k",
    diagnostic: "retrieval-only",
    results: [
      {
        query_id: "numeric-answer",
        query: "What is the test coverage?",
        gold_answers: ["78%"],
        meta: {
          question_category: "knowledge_update",
          rubric: ["LLM response should state: 78%"],
        },
        context: "The API integration test coverage recently improved to 78%.",
      },
    ],
  });

  assert.equal(summary.score, 1);
  assert.equal(summary.full, 1);
  assert.equal(summary.lowest[0].nuggets[0].ok, true);
});

test("nugget analyzer reports public-style partial rows", () => {
  const summary = runAnalyzer({
    dataset: "beam",
    split: "100k",
    diagnostic: "retrieval-only",
    results: [
      {
        query_id: "partial",
        query: "Summarize the project",
        gold_answers: [],
        meta: {
          question_category: "summarization",
          rubric: [
            "LLM response should contain: initial planning and resource gathering",
            "LLM response should contain: testing and review",
          ],
        },
        context: "The notes mention initial planning and resource gathering.",
      },
    ],
  });

  assert.equal(summary.score, 0.5);
  assert.equal(summary.partial, 1);
  assert.equal(summary.lowest[0].nuggets[0].ok, true);
  assert.equal(summary.lowest[0].nuggets[1].ok, false);
});

test("nugget analyzer ignores empty public-style rubric entries", () => {
  const summary = runAnalyzer({
    dataset: "beam",
    split: "100k",
    diagnostic: "retrieval-only",
    results: [
      {
        query_id: "empty-rubric",
        query: "Summarize the cooking journey",
        gold_answers: [],
        meta: {
          question_category: "summarization",
          rubric: [
            "LLM response should contain: Turkish and Greek cuisines",
            "LLM response should contain: ",
          ],
        },
        context: "The notes mention Turkish and Greek cuisines.",
      },
    ],
  });

  assert.equal(summary.score, 1);
  assert.equal(summary.full, 1);
  assert.equal(summary.lowest[0].nuggets.length, 1);
  assert.equal(summary.lowest[0].nuggets[0].nugget, "Turkish and Greek cuisines");
});
