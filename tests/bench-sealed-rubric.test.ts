import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_ASSISTANT_RUBRIC_ID,
  SEALED_PROMPT_REGISTRY,
  createDeterministicSpotCheckLogger,
  loadSealedRubric,
  parseRubricResponse,
  runSealedJudge,
  verifyRubricDigest,
  zeroScores,
  type StructuredJudge,
} from "../packages/bench/src/index.js";

test("loadSealedRubric returns the registered assistant rubric with a stable sha256", () => {
  const rubric = loadSealedRubric(DEFAULT_ASSISTANT_RUBRIC_ID);
  assert.equal(rubric.id, DEFAULT_ASSISTANT_RUBRIC_ID);
  assert.equal(rubric.version, "v1");
  assert.ok(rubric.prompt.length > 200);

  const expected = createHash("sha256")
    .update(SEALED_PROMPT_REGISTRY[DEFAULT_ASSISTANT_RUBRIC_ID]!, "utf8")
    .digest("hex");
  assert.equal(rubric.sha256, expected);
  assert.equal(rubric.sha256.length, 64);
});

test("verifyRubricDigest matches a freshly computed digest", () => {
  const rubric = loadSealedRubric();
  assert.equal(verifyRubricDigest(rubric.sha256), true);
  assert.equal(verifyRubricDigest("0".repeat(64)), false);
});

test("loadSealedRubric rejects malformed ids and unknown ids", () => {
  assert.throws(() => loadSealedRubric("BAD ID"), /sealed rubric id must match/);
  assert.throws(() => loadSealedRubric("missing-rubric"), /sealed rubric not found/);
});

test("loadSealedRubric reads the human-readable .md mirror to confirm byte-parity", () => {
  // Guardrail: the .md mirror should stay identical to the registered .ts
  // string so reviewers see the same text the runtime hashes.
  const rubric = loadSealedRubric();
  const here = path.dirname(new URL(import.meta.url).pathname);
  const mdPath = path.resolve(
    here,
    "../packages/bench/src/judges/sealed-prompts/assistant-rubric-v1.md",
  );
  const mdText = readFileSync(mdPath, "utf8");
  assert.equal(rubric.prompt, mdText);
});

test("parseRubricResponse parses a well-formed judge reply", () => {
  const raw = `\n  {\n    "identity_accuracy": 4,\n    "stance_coherence": 3,\n    "novelty": 5,\n    "calibration": 2,\n    "notes": "looks reasonable"\n  }\n`;
  const parsed = parseRubricResponse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scores.identity_accuracy, 4);
  assert.equal(parsed.scores.stance_coherence, 3);
  assert.equal(parsed.scores.novelty, 5);
  assert.equal(parsed.scores.calibration, 2);
  assert.equal(parsed.notes, "looks reasonable");
});

test("parseRubricResponse rejects malformed payloads with parse_error notes", () => {
  const missingDimension = parseRubricResponse(
    '{"identity_accuracy": 4, "stance_coherence": 3, "novelty": 5}',
  );
  assert.equal(missingDimension.ok, false);
  assert.match(missingDimension.notes, /parse_error: missing dimension calibration/);

  const invalidJson = parseRubricResponse("{ not-json }");
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.notes, /parse_error: invalid JSON/);

  const notObject = parseRubricResponse("[1,2,3]");
  assert.equal(notObject.ok, false);

  const empty = parseRubricResponse("");
  assert.equal(empty.ok, false);
  assert.match(empty.notes, /parse_error: empty/);
});

test("parseRubricResponse clamps out-of-range numeric scores to [0,5]", () => {
  const raw = '{"identity_accuracy": 9, "stance_coherence": -3, "novelty": 3.75, "calibration": 4.0, "notes": ""}';
  const parsed = parseRubricResponse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scores.identity_accuracy, 5);
  assert.equal(parsed.scores.stance_coherence, 0);
  assert.equal(parsed.scores.novelty, 3.75);
  assert.equal(parsed.scores.calibration, 4);
});

test("runSealedJudge returns a parse_error decision when no judge is wired", async () => {
  const rubric = loadSealedRubric();
  const decision = await runSealedJudge(undefined, rubric, {
    taskId: "t1",
    scenario: "scenario",
    memorySummary: "summary",
    assistantOutput: "output",
  });
  assert.equal(decision.parseOk, false);
  assert.match(decision.notes, /no judge provider wired/);
  assert.deepEqual(decision.scores, zeroScores());
  assert.equal(decision.rubricSha256, rubric.sha256);
});

test("runSealedJudge captures judge exceptions without crashing the run", async () => {
  const rubric = loadSealedRubric();
  const throwingJudge: StructuredJudge = {
    async evaluate() {
      throw new Error("boom");
    },
  };
  const decision = await runSealedJudge(throwingJudge, rubric, {
    taskId: "t1",
    scenario: "s",
    memorySummary: "m",
    assistantOutput: "o",
  });
  assert.equal(decision.parseOk, false);
  assert.match(decision.notes, /parse_error: judge threw \(boom\)/);
});

test("runSealedJudge parses valid judge JSON and records rubric provenance", async () => {
  const rubric = loadSealedRubric();
  const goodJudge: StructuredJudge = {
    async evaluate({ rubricId, taskId }) {
      assert.equal(rubricId, rubric.id);
      assert.equal(taskId, "t1");
      return '{"identity_accuracy":5,"stance_coherence":4,"novelty":3,"calibration":5,"notes":"ok"}';
    },
  };
  const decision = await runSealedJudge(goodJudge, rubric, {
    taskId: "t1",
    scenario: "s",
    memorySummary: "m",
    assistantOutput: "o",
  });
  assert.equal(decision.parseOk, true);
  assert.equal(decision.rubricId, rubric.id);
  assert.equal(decision.rubricSha256, rubric.sha256);
  assert.equal(decision.scores.identity_accuracy, 5);
  assert.equal(decision.scores.calibration, 5);
});

test("createSpotCheckFileLogger degrades to a no-op when the directory cannot be created", async () => {
  const { createSpotCheckFileLogger } = await import(
    "../packages/bench/src/judges/sealed-rubric.js"
  );
  const rubric = loadSealedRubric();
  const root = mkdtempSync(path.join(tmpdir(), "remnic-spotcheck-conflict-"));
  // Write a regular file at `collision`, then ask the logger to create a
  // directory _inside_ that file path. `mkdirSync` must throw because
  // `collision` is not a directory, and the logger must swallow the error.
  const collisionPath = path.join(root, "collision");
  const fs = await import("node:fs");
  fs.writeFileSync(collisionPath, "blocker");
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    const logger = createSpotCheckFileLogger({
      runId: "test-no-dir",
      directory: path.join(collisionPath, "inner"),
      sampleRate: 1,
      sampleSize: 3,
      random: () => 0,
    });

    // Call log — must not throw.
    logger.log(
      {
        taskId: "t1",
        rubricId: rubric.id,
        rubricSha256: rubric.sha256,
        scores: zeroScores(),
        notes: "ok",
        rawResponse: "",
        parseOk: true,
      },
      {
        taskId: "t1",
        scenario: "s",
        memorySummary: "m",
        assistantOutput: "o",
      },
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    warnings.some((line) => line.includes("spot-check logger disabled")),
    "logger should warn once when mkdirSync throws",
  );
});

test("createDeterministicSpotCheckLogger writes jsonl entries up to sampleSize", async () => {
  const rubric = loadSealedRubric();
  const dir = mkdtempSync(path.join(tmpdir(), "remnic-spotcheck-"));
  const logger = createDeterministicSpotCheckLogger({
    runId: "test-run-1",
    directory: dir,
    sampleSize: 2,
  });

  const goodJudge: StructuredJudge = {
    async evaluate() {
      return '{"identity_accuracy":3,"stance_coherence":3,"novelty":3,"calibration":3,"notes":"ok"}';
    },
  };

  for (const taskId of ["t1", "t2", "t3"]) {
    await runSealedJudge(goodJudge, rubric, {
      taskId,
      scenario: `scenario-${taskId}`,
      memorySummary: "m",
      assistantOutput: `output-${taskId}`,
    }, { spotCheckLogger: logger });
  }

  const files = readdirSync(dir);
  assert.deepEqual(files, ["test-run-1.jsonl"]);
  const contents = readFileSync(path.join(dir, "test-run-1.jsonl"), "utf8");
  const lines = contents.trim().split("\n");
  assert.equal(lines.length, 2, "sampleSize cap should bound written entries");

  const first = JSON.parse(lines[0]!);
  assert.equal(first.taskId, "t1");
  assert.equal(first.rubricId, rubric.id);
  assert.equal(first.rubricSha256, rubric.sha256);
  assert.equal(first.parseOk, true);
});
