/**
 * Integrity-guard tests for the model-lab eval recipe + stack capture (#1585).
 *
 * These cover the thread-resolution fixes:
 *  - eval._span_overlaps raises a CLEAR length-mismatch error (kilo
 *    PRRT_kwDORJXyws6OtyS8) instead of a cryptic zip(strict=True) ValueError.
 *  - eval._held_out_is_predictions refuses the held-out file (or a symlink to
 *    it) as --predictions so gold can't be scored against itself (codex P1
 *    PRRT_kwDORJXyws6Otp-I).
 *  - training_stack.assert_stack_matches_requirements normalizes underscore /
 *    hyphen distribution names so a pip-freeze capture isn't falsely reported
 *    missing (cursor PRRT_kwDORJXyws6Otn36).
 *
 * Pure stdlib Python via spawnSync (no GPU, no torch) — mirrors the manifest
 * schema probe's style.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { skipUnlessCommand } from "./helpers/capability-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (model-lab integrity guards run stdlib-only Python)",
);

function runPython(script) {
  const res = spawnSync(pythonBin, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`python exited ${res.status}:\n${res.stderr}\n${res.stdout}`);
  }
  return res.stdout;
}

test(
  "eval: _span_overlaps raises a clear length-mismatch error, not a cryptic zip ValueError (kilo PRRT_kwDORJXyws6OtyS8)",
  { skip: skipReason },
  () => {
    const out = runPython(`
import json, sys
sys.path.insert(0, "model-lab")
sys.path.insert(0, "model-lab/correction-intent")
import eval as evmod
try:
    evmod._span_overlaps([{"label": "correction", "corrections": []}], [])
    print(json.dumps({"raised": False}))
except ValueError as e:
    print(json.dumps({"raised": True, "msg": str(e)}))
`);
    const { raised, msg } = JSON.parse(out);
    assert.equal(raised, true, "_span_overlaps must raise on mismatched lengths");
    assert.match(msg, /length mismatch/, "error must be descriptive");
    assert.ok(msg.includes("gold=1") && msg.includes("pred=0"), `must name both lengths: ${msg}`);
  },
);

test(
  "eval: _held_out_is_predictions refuses the held-out file as predictions, including symlinks (codex P1 PRRT_kwDORJXyws6Otp-I)",
  { skip: skipReason },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-eval-guard-"));
    const gold = path.join(dir, "gold.jsonl");
    const preds = path.join(dir, "preds.jsonl");
    fs.writeFileSync(gold, '{"label":"none"}\n');
    fs.writeFileSync(preds, '{"label":"none"}\n');
    const link = path.join(dir, "link.jsonl");
    try {
      fs.symlinkSync(gold, link);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      return; // FS without symlink support — skip rather than fail.
    }
    try {
      const out = runPython(`
import json, sys
sys.path.insert(0, "model-lab")
sys.path.insert(0, "model-lab/correction-intent")
from pathlib import Path
import eval as evmod
gold = Path(${JSON.stringify(gold)})
preds = Path(${JSON.stringify(preds)})
link = Path(${JSON.stringify(link)})
print(json.dumps({
    "same": evmod._held_out_is_predictions(gold, gold),
    "distinct": evmod._held_out_is_predictions(gold, preds),
    "symlink": evmod._held_out_is_predictions(gold, link),
}))
`);
      const { same, distinct, symlink } = JSON.parse(out);
      assert.equal(same, true, "same file must be detected");
      assert.equal(distinct, false, "distinct files must NOT be flagged");
      assert.equal(symlink, true, "a symlink to the held-out file must be detected");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "training_stack: assert_stack_matches_requirements normalizes underscore/hyphen names (cursor PRRT_kwDORJXyws6Otn36)",
  { skip: skipReason },
  () => {
    const reqDir = fs.mkdtempSync(path.join(os.tmpdir(), "remnic-stack-"));
    const reqFile = path.join(reqDir, "requirements.txt");
    // requirements.txt uses the canonical hyphen form.
    fs.writeFileSync(reqFile, "huggingface-hub==0.25.0\ntorch==2.12.1\n");
    try {
      const out = runPython(`
import json, sys
sys.path.insert(0, "model-lab")
from common.training_stack import assert_stack_matches_requirements
from pathlib import Path
# A pip-freeze capture that recorded the underscore form for one lib.
stack = {"libs": {"huggingface_hub": "0.25.0", "torch": "2.12.1"}}
errs = assert_stack_matches_requirements(stack, Path(${JSON.stringify(reqFile)}))
print(json.dumps({"errors": errs}))
`);
      const { errors } = JSON.parse(out);
      assert.deepEqual(
        errors,
        [],
        `underscore-form capture must match hyphen-form pin, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.rmSync(reqDir, { recursive: true, force: true });
    }
  },
);
