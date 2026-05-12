import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(dirname, "check-remnic-results.mjs");

function makeAmbFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "remnic-amb-check-"));
  writeJson(path.join(root, "results-manifest.json"), [
    {
      dataset: "beam",
      split: "100k",
      run_name: "hindsight",
      accuracy: 0.7,
      total_queries: 2,
      path: "outputs/beam/hindsight/single-query/100k.json",
    },
    {
      dataset: "beam",
      split: "500k",
      run_name: "hindsight",
      accuracy: 0.8,
      total_queries: 2,
      path: "outputs/beam/hindsight/single-query/500k.json",
    },
  ]);
  return root;
}

function writeResult(root, {
  runName = "remnic",
  mode = "rag",
  split = "100k",
  accuracy,
}) {
  writeJson(
    path.join(root, "outputs", "beam", runName, mode, `${split}.json`),
    {
      dataset: "beam",
      split,
      run_name: runName,
      mode,
      accuracy,
      total_queries: 2,
      correct: 2,
      answer_llm: "gemini:gemini-3.1-pro-preview",
      judge_llm: "gemini:gemini-2.5-flash-lite",
    },
  );
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function runChecker(args) {
  try {
    const stdout = execFileSync(process.execPath, [checker, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output: JSON.parse(stdout) };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    return {
      code: error.status ?? 1,
      output: stdout.trim() ? JSON.parse(stdout) : null,
    };
  }
}

test("passes only when every requested Remnic split beats the public best", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { split: "100k", accuracy: 0.71 });
    writeResult(root, { split: "500k", accuracy: 0.81 });

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k,500k",
    ]);

    assert.equal(result.code, 0);
    assert.equal(result.output.ok, true);
    assert.deepEqual(
      result.output.rows.map((row) => row.status),
      ["sota", "sota"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a requested result is missing or below public best", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { split: "100k", accuracy: 0.69 });

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k,500k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.deepEqual(
      result.output.rows.map((row) => row.status),
      ["below", "missing"],
    );
    assert.equal(result.output.rows[0].publicBest, 0.7);
    assert.equal(result.output.rows[1].publicBest, 0.8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails high-accuracy smoke results that do not cover the public full split", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { split: "100k", accuracy: 1.0 });
    const resultFile = path.join(root, "outputs", "beam", "remnic", "rag", "100k.json");
    const data = JSON.parse(readFileSync(resultFile, "utf8"));
    data.total_queries = 1;
    writeJson(resultFile, data);

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.rows[0].status, "partial");
    assert.equal(result.output.rows[0].totalQueries, 1);
    assert.equal(result.output.rows[0].requiredTotalQueries, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails retrieval-only artifacts with an explicit status", () => {
  const root = makeAmbFixture();
  try {
    writeJson(
      path.join(root, "outputs", "beam", "remnic", "retrieval", "100k.json"),
      {
        dataset: "beam",
        split: "100k",
        run_name: "remnic",
        mode: "retrieval",
        results: [
          {
            query_id: "diagnostic-query",
            contexts: ["retrieved context"],
          },
        ],
      },
    );

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--mode", "retrieval",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.rows[0].status, "retrieval-only");
    assert.equal(result.output.rows[0].remnic, null);
    assert.equal(result.output.rows[0].publicBest, 0.7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails high-accuracy results with non-comparable answer or judge models", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { split: "100k", accuracy: 1.0 });
    const resultFile = path.join(root, "outputs", "beam", "remnic", "rag", "100k.json");
    const data = JSON.parse(readFileSync(resultFile, "utf8"));
    data.answer_llm = "gemini:other-answer-model";
    writeJson(resultFile, data);

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.rows[0].status, "wrong-models");
    assert.equal(result.output.rows[0].answerLlm, "gemini:other-answer-model");
    assert.equal(
      result.output.rows[0].requiredAnswerLlm,
      "gemini:gemini-3.1-pro-preview",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails high-accuracy artifacts with mismatched dataset or split metadata", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { split: "100k", accuracy: 1.0 });
    const resultFile = path.join(root, "outputs", "beam", "remnic", "rag", "100k.json");
    const data = JSON.parse(readFileSync(resultFile, "utf8"));
    data.dataset = "personamem";
    data.split = "500k";
    writeJson(resultFile, data);

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.rows[0].status, "wrong-artifact");
    assert.equal(result.output.rows[0].dataset, "personamem");
    assert.equal(result.output.rows[0].artifactSplit, "500k");
    assert.equal(result.output.rows[0].requiredDataset, "beam");
    assert.equal(result.output.rows[0].requiredSplit, "100k");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode discovery succeeds with one matching result and fails when ambiguous", () => {
  const root = makeAmbFixture();
  try {
    writeResult(root, { mode: "rag", split: "100k", accuracy: 0.71 });

    const single = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--mode", "any",
      "--splits", "100k",
    ]);
    assert.equal(single.code, 0);
    assert.equal(single.output.rows[0].mode, "rag");

    writeResult(root, { mode: "agentic-rag", split: "100k", accuracy: 0.72 });

    const ambiguous = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--mode", "any",
      "--splits", "100k",
    ]);
    assert.equal(ambiguous.code, 1);
    assert.equal(ambiguous.output.rows[0].status, "ambiguous");
    assert.equal(ambiguous.output.rows[0].candidates.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mode discovery treats a non-directory run path as missing", () => {
  const root = makeAmbFixture();
  try {
    writeJson(path.join(root, "outputs", "beam", "remnic"), {
      unexpected: "file",
    });

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--mode", "any",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 1);
    assert.equal(result.output.ok, false);
    assert.equal(result.output.rows[0].status, "missing");
    assert.equal(result.output.rows[0].file, path.join(
      root,
      "outputs",
      "beam",
      "remnic",
      "*",
      "100k.json",
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-array public results manifest", () => {
  const root = makeAmbFixture();
  try {
    writeJson(path.join(root, "results-manifest.json"), {
      dataset: "beam",
      split: "100k",
      accuracy: 0.7,
    });

    const result = runChecker([
      "--amb-dir", root,
      "--run-name", "remnic",
      "--splits", "100k",
    ]);

    assert.equal(result.code, 2);
    assert.equal(result.output, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
