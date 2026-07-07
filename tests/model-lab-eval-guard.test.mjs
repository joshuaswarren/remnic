/**
 * Correction-intent eval.py guards (issue #1700 nits #1 + #4).
 *
 * Nit #1: require_eval_deps() is scoped to the inference path — offline
 * scoring via --predictions runs CPU-only; the no-predictions path gates the
 * GPU stack.
 *
 * Nit #4: _held_out_is_predictions detects a HARD LINK to the held-out file
 * (os.path.samefile), not just same-path / symlink.
 *
 * Shells out to the Python eval module (stdlib-only — no torch needed for the
 * offline path or the pure guard), capability-guarded on python3 — same pattern
 * as tests/model-lab-manifest-schema.test.mjs.
 */

import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { skipUnlessCommand } from "./helpers/capability-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (model-lab eval guards run stdlib-only Python)",
);

/**
 * Run a Python snippet that imports the correction-intent eval module and
 * reports a JSON result. The snippet is responsible for catching SystemExit
 * (require_eval_deps raises it) and converting it to a code field.
 */
function runEvalProbe(body) {
  const script = `
import json, os, sys, tempfile, contextlib
sys.path.insert(0, "model-lab")
from pathlib import Path
import importlib.util
spec = importlib.util.spec_from_file_location("cieval", "model-lab/correction-intent/eval.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

d = Path(tempfile.mkdtemp())
gold = d / "gold.jsonl"
preds = d / "preds.jsonl"
gold.write_text(json.dumps({"label": "correction", "corrections": [{"correctedAssertion": "we use postgres"}]}) + "\\n")
preds.write_text(json.dumps({"label": "none"}) + "\\n")

result = {}
${body}
print(json.dumps(result))
`;
  const res = spawnSync(pythonBin, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`probe exited ${res.status}:\n${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(res.stdout);
}
test(
  "eval.py: offline scoring via --predictions SUCCEEDS with no GPU stack (#1700 nit #1)",
  { skip: skipReason },
  () => {
    const r = runEvalProbe(`
with contextlib.redirect_stdout(open(os.devnull, "w")):
    try:
        rc = m.main(["--held-out", str(gold), "--predictions", str(preds)])
        result["offline_rc"] = rc
    except SystemExit as e:
        result["offline_systemexit"] = e.code
`);
    assert.equal(
      r.offline_systemexit,
      undefined,
      "offline scoring must NOT call require_eval_deps (no SystemExit); " +
        "got SystemExit — the GPU gate leaked onto the offline path",
    );
    assert.equal(r.offline_rc, 0, "offline scoring must return 0 (success) on a CPU-only host");
  },
);

test(
  "eval.py: no --predictions -> inference path gates the GPU stack (SystemExit 2) (#1700 nit #1)",
  { skip: skipReason },
  () => {
    const r = runEvalProbe(`
# Stub the GPU gate so the test outcome does NOT depend on whether
# torch/transformers happen to be installed on this host (codex P2
# PRRT_kwDORJXyws6O6zwe). The stub records the call and raises
# SystemExit(2) to mirror the real gate on a missing GPU stack.
gate_calls = []
_orig_gate = m.require_eval_deps
def _stub_gate():
    gate_calls.append(1)
    raise SystemExit(2)
m.require_eval_deps = _stub_gate
try:
    rc = m.main(["--held-out", str(gold)])
    result["inference_rc"] = rc
except SystemExit as e:
    result["inference_systemexit"] = e.code
finally:
    m.require_eval_deps = _orig_gate
result["gate_called"] = len(gate_calls)
`);
    assert.equal(
      r.gate_called,
      1,
      "the inference path (no --predictions) must call the GPU gate (require_eval_deps)",
    );
    assert.equal(
      r.inference_systemexit,
      2,
      "the GPU gate must fire on the inference path (SystemExit 2), independent of installed deps",
    );
  },
);

test(
  "eval.py: _held_out_is_predictions detects a HARD LINK to the held-out file (#1700 nit #4)",
  { skip: skipReason },
  () => {
    const r = runEvalProbe(`
hard = d / "hardlink.jsonl"
os.link(gold, hard)  # different path, same inode
result["hardlink_detected"] = m._held_out_is_predictions(gold, hard)
result["distinct_not_detected"] = m._held_out_is_predictions(gold, preds)
`);
    assert.equal(
      r.hardlink_detected,
      true,
      "a hard link to the held-out file must be detected (same inode via os.path.samefile)",
    );
    assert.equal(
      r.distinct_not_detected,
      false,
      "two genuinely-distinct files must NOT be flagged as the same file",
    );
  },
);

test(
  "eval.py: a supplied-but-missing --predictions path reports a bad-path error, NOT a GPU-gate error (#1700 review PRRT_kwDORJXyws6O6gBM)",
  { skip: skipReason },
  () => {
    const r = runEvalProbe(`
missing = d / "does-not-exist.jsonl"
try:
    rc = m.main(["--held-out", str(gold), "--predictions", str(missing)])
    result["badpath_rc"] = rc
except SystemExit as e:
    result["badpath_systemexit"] = e.code
`);
    // A typoed predictions path must NOT trigger the GPU gate (no SystemExit);
    // it must return 2 with a clear bad-path message on a CPU-only host.
    assert.equal(
      r.badpath_systemexit,
      undefined,
      "a missing predictions path must not gate the GPU stack (no SystemExit)",
    );
    assert.equal(r.badpath_rc, 2, "a missing predictions path must return 2");
  },
);
