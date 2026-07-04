import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { skipUnlessCommand } from "./helpers/capability-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generateData = path.join(repoRoot, "model-lab", "faithfulness-gate", "generate-data.py");

// Capability guard (issue #1541): shell out to python3; skip-with-reason when
// absent. CI sets REMNIC_REQUIRE_CAPABILITY_TESTS=1 to forbid the skip.
const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (model-lab data generation is stdlib-only)",
);

const ALLOWED_LABELS = new Set(["entailed", "contradicted", "unsupported"]);

/** Run generate-data.py with the given args; return the spawnSync result. */
function runGenerator(args) {
  return spawnSync(pythonBin, [generateData, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 60_000,
  });
}

/** Extract and assert the DATASET_SHA256=<hex> line from generator stdout. */
function extractSha256(stdout) {
  assert.match(
    stdout,
    /^DATASET_SHA256=[0-9a-f]{64}$/m,
    "generator must print a parseable DATASET_SHA256 line",
  );
  const match = stdout.match(/^DATASET_SHA256=([0-9a-f]{64})$/m);
  return match[1];
}

test(
  "faithfulness generator: perturbation selfcheck — every transform preserves/changes the right label",
  { skip: skipReason },
  () => {
    const proc = runGenerator(["--selfcheck"]);
    assert.equal(
      proc.status,
      0,
      `selfcheck exited non-zero: ${proc.stderr || "<no stderr>"}`,
    );

    const payload = JSON.parse(proc.stdout.trim());

    assert.equal(payload.failed, 0, "no selftest case may fail");
    assert.equal(payload.allPassed, true, "selfcheck reports allPassed=true");
    // The case table covers every perturbation + both label-preserve and
    // label-change directions, so a silent no-op transform is caught.
    const perturbations = new Set(payload.cases.map((c) => c.perturbation));
    for (const expected of [
      "identity",
      "paraphrase",
      "entity_swap",
      "negation_flip",
      "date_shift",
      "quantity_change",
      "unrelated_quote",
    ]) {
      assert.ok(
        perturbations.has(expected),
        `selfcheck must cover the ${expected} perturbation`,
      );
    }

    // Spot-check the label semantics (issue #1585):
    //   identity/paraphrase ⇒ entailed
    //   entity_swap/negation_flip/date_shift/quantity_change ⇒ contradicted
    //   unrelated_quote ⇒ unsupported
    //   identity on a mismatched fact ⇒ declined (_skipped), NOT entailed
    const byName = Object.fromEntries(payload.cases.map((c) => [c.name, c]));
    assert.equal(byName["identity-preserve"].actual, "entailed");
    assert.equal(byName["paraphrase-preserve"].actual, "entailed");
    assert.equal(byName["entity-swap-contradict"].actual, "contradicted");
    assert.equal(byName["negation-flip-contradict"].actual, "contradicted");
    assert.equal(byName["negation-flip-insert-contradict"].actual, "contradicted");
    assert.equal(byName["date-shift-contradict"].actual, "contradicted");
    assert.equal(byName["quantity-change-contradict"].actual, "contradicted");
    assert.equal(byName["unrelated-quote-unsupported"].actual, "unsupported");
    assert.equal(
      byName["identity-no-mismatch"].actual,
      "_skipped",
      "identity must NOT fire when fact ≠ quote (preserve-negative)",
    );
  },
);

test(
  "faithfulness generator: same seed ⇒ identical dataset sha256 (byte-stable)",
  { skip: skipReason },
  () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "faith-seed-a-"));
    const dirB = mkdtempSync(path.join(tmpdir(), "faith-seed-b-"));

    const runA = runGenerator(["--seed", "1337", "--out", dirA, "--yes", "--quiet"]);
    const runB = runGenerator(["--seed", "1337", "--out", dirB, "--yes", "--quiet"]);
    assert.equal(runA.status, 0, `runA failed: ${runA.stderr}`);
    assert.equal(runB.status, 0, `runB failed: ${runB.stderr}`);

    const hashA = extractSha256(runA.stdout);
    const hashB = extractSha256(runB.stdout);
    assert.equal(
      hashA,
      hashB,
      "same seed must produce an identical dataset sha256 — reproducibility contract",
    );

    // Belt-and-suspenders: the sha256 could only match if the bytes match,
    // but assert the file content directly too.
    const fileA = readFileSync(path.join(dirA, "faithfulness-train.jsonl"), "utf8");
    const fileB = readFileSync(path.join(dirB, "faithfulness-train.jsonl"), "utf8");
    assert.equal(fileA, fileB, "JSONL bytes must be byte-identical for the same seed");
  },
);

test(
  "faithfulness generator: different seed ⇒ different dataset sha256",
  { skip: skipReason },
  () => {
    const dirA = mkdtempSync(path.join(tmpdir(), "faith-diff-a-"));
    const dirC = mkdtempSync(path.join(tmpdir(), "faith-diff-c-"));

    const runA = runGenerator(["--seed", "1337", "--out", dirA, "--yes", "--quiet"]);
    const runC = runGenerator(["--seed", "9999", "--out", dirC, "--yes", "--quiet"]);
    assert.equal(runA.status, 0, `runA failed: ${runA.stderr}`);
    assert.equal(runC.status, 0, `runC failed: ${runC.stderr}`);

    const hashA = extractSha256(runA.stdout);
    const hashC = extractSha256(runC.stdout);
    assert.notEqual(
      hashA,
      hashC,
      "different seeds must produce different datasets — the seed must affect output",
    );
  },
);

test(
  "faithfulness generator: emits a valid 3-label dataset matching the #1576 contract",
  { skip: skipReason },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "faith-contract-"));
    const proc = runGenerator(["--seed", "1337", "--out", dir, "--yes", "--quiet"]);
    assert.equal(proc.status, 0, `generate failed: ${proc.stderr}`);

    const lines = readFileSync(path.join(dir, "faithfulness-train.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.ok(lines.length > 0, "dataset must be non-empty");

    const seenLabels = new Set();
    for (const line of lines) {
      const row = JSON.parse(line);
      // The #1576 FaithfulnessCheckInput contract fields:
      assert.equal(typeof row.factText, "string");
      assert.ok(row.factText.length > 0, "factText non-empty");
      assert.equal(typeof row.quote, "string");
      assert.ok(row.quote.length > 0, "quote non-empty");
      assert.equal(typeof row.context, "string", "context present (empty allowed)");
      assert.ok(ALLOWED_LABELS.has(row.label), `label is a valid verdict: ${row.label}`);
      assert.equal(typeof row.perturbation, "string", "perturbation provenance tag present");
      assert.equal(typeof row.sourceId, "string", "sourceId present");
      seenLabels.add(row.label);
    }
    // Every verdict class is exercised by the seed fixtures.
    for (const label of ALLOWED_LABELS) {
      assert.ok(seenLabels.has(label), `dataset must include at least one ${label} example`);
    }
  },
);
