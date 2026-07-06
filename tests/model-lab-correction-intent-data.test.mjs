/**
 * Correction-intent data generator determinism + morphology selfcheck
 * (issue #1585 PR3).
 *
 * Mirrors tests/model-lab-faithfulness-data.test.mjs: shells out to the
 * Python generator (stdlib-only), capability-guarded on `python3`. CI sets
 * REMNIC_REQUIRE_CAPABILITY_TESTS=1 to forbid the skip. No data is committed —
 * datasets are generated in a temp dir and hashed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";

import { skipUnlessCommand } from "./helpers/capability-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generateData = path.join(repoRoot, "model-lab", "correction-intent", "generate-data.py");

const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (model-lab correction-intent data generation is stdlib-only)",
);

const ALLOWED_LABELS = new Set(["correction", "none"]);

function runGenerator(args) {
  return spawnSync(pythonBin, [generateData, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
}

function extractSha256(stdout) {
  const m = stdout.match(/DATASET_SHA256=([0-9a-f]{64})/);
  assert.ok(m, `expected DATASET_SHA256=<hex> on stdout, got: ${stdout.slice(0, 200)}`);
  return m[1];
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remnic-ci-"));
}

test(
  "correction-intent generator: morphology selfcheck — every signal/anti-example yields its expected label",
  { skip: skipReason },
  () => {
    const res = runGenerator(["--selfcheck"]);
    assert.equal(res.status, 0, `selfcheck exited ${res.status}:\n${res.stderr}`);
    const payload = JSON.parse(res.stdout);
    assert.equal(payload.allPassed, true);
    // The grammar must exercise all three polarities AND all four anti-fixtures.
    const morphologies = new Set(payload.cases.map((c) => c.morphology));
    for (const required of [
      "update_switched_to",
      "retract_dont_use",
      "stop_storing_stop_suggesting",
      "anti_hypothetical",
      "anti_third_party",
      "anti_tool_output",
      "anti_self_resolving",
    ]) {
      assert.ok(morphologies.has(required), `selfcheck missing morphology ${required}`);
    }
  },
);

test(
  "correction-intent generator: same seed ⇒ identical dataset sha256 (byte-stable)",
  { skip: skipReason },
  () => {
    const a = tempDir();
    const b = tempDir();
    const ra = runGenerator(["--seed", "1337", "--out", a, "--yes"]);
    const rb = runGenerator(["--seed", "1337", "--out", b, "--yes"]);
    assert.equal(ra.status, 0, `gen A exited ${ra.status}:\n${ra.stderr}`);
    assert.equal(rb.status, 0, `gen B exited ${rb.status}:\n${rb.stderr}`);
    assert.equal(extractSha256(ra.stdout), extractSha256(rb.stdout));
  },
);

test(
  "correction-intent generator: different seed ⇒ different dataset sha256",
  { skip: skipReason },
  () => {
    const a = tempDir();
    const c = tempDir();
    const ra = runGenerator(["--seed", "1337", "--out", a, "--yes"]);
    const rc = runGenerator(["--seed", "9999", "--out", c, "--yes"]);
    assert.equal(ra.status, 0);
    assert.equal(rc.status, 0);
    assert.notEqual(extractSha256(ra.stdout), extractSha256(rc.stdout));
  },
);

test(
  "correction-intent generator: emits a valid 2-label dataset matching the #1581 contract",
  { skip: skipReason },
  () => {
    const out = tempDir();
    const res = runGenerator(["--seed", "1337", "--out", out, "--yes"]);
    assert.equal(res.status, 0, `gen exited ${res.status}:\n${res.stderr}`);
    const trainPath = path.join(out, "train.jsonl");
    assert.ok(fs.existsSync(trainPath), "train.jsonl not written");
    const lines = fs.readFileSync(trainPath, "utf-8").trim().split("\n");
    assert.ok(lines.length > 0, "dataset is empty");
    const records = lines.map((l) => JSON.parse(l));
    for (const r of records) {
      assert.ok(ALLOWED_LABELS.has(r.label), `bad label ${r.label}`);
      assert.ok(Array.isArray(r.turns) && r.turns.length > 0, "turns must be non-empty");
      // The #1581 contract: correction labels carry a corrections[] block; none don't.
      if (r.label === "correction") {
        assert.ok(r.corrections.length > 0, "correction label must carry corrections[]");
        const c = r.corrections[0];
        assert.ok(["update", "retract", "stop_storing"].includes(c.polarity), `bad polarity ${c.polarity}`);
      } else {
        assert.equal(r.corrections.length, 0, "none label must have empty corrections[]");
      }
    }
    // Both labels must be present (a one-class dataset is a generator bug).
    const labels = new Set(records.map((r) => r.label));
    assert.ok(labels.has("correction") && labels.has("none"), `dataset missing a label class: ${[...labels]}`);
  },
);
