/**
 * Manifest schema validation (issue #1585).
 *
 * Both committed manifests (faithfulness-gate + correction-intent) are the
 * SCHEMA EXAMPLE only — every eval/weight/training-stack field is pending
 * (rule 55: no fabricated numbers). This test asserts they validate against
 * the schema in `allow_pending` mode, AND that the validator REJECTS a
 * manifest missing the required trainingStack version-pin block (proving the
 * ratchet actually bites — rule 6: prove-fail-before).
 *
 * Shells out to the Python validator (stdlib-only), capability-guarded on
 * `python3` — same pattern as the data-generator determinism probes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { skipUnlessCommand } from "./helpers/capability-probe.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (manifest schema validation runs stdlib-only Python)",
);

/** Run the Python validator on a JSON manifest; return {errors, ok}. */
function validateManifest(manifestPath, allowPending) {
  const script = `
import json, sys
sys.path.insert(0, "model-lab")
from common.manifest_schema import validate_manifest
m = json.load(open(${JSON.stringify(manifestPath)}))
errs = validate_manifest(m, allow_pending=${allowPending ? "True" : "False"})
print(json.dumps({"errors": errs}))
`;
  const res = spawnSync(pythonBin, ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
  });
  if (res.status !== 0) {
    throw new Error(`validator exited ${res.status}:\n${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

test(
  "manifest schema: both committed manifests validate in allow_pending (scaffold) mode",
  { skip: skipReason },
  () => {
    for (const rel of [
      "model-lab/faithfulness-gate/manifest.json",
      "model-lab/correction-intent/manifest.json",
    ]) {
      const full = path.join(repoRoot, rel);
      const { errors, ok } = validateManifest(full, true);
      assert.equal(ok, undefined); // validator returns errors list; ok is incidental
      assert.deepEqual(errors, [], `${rel} should be valid in scaffold mode, got: ${JSON.stringify(errors)}`);
    }
  },
);

test(
  "manifest schema: validator REJECTS a manifest missing the trainingStack version-pin (prove-fail-before)",
  { skip: skipReason },
  () => {
    // A manifest with no trainingStack must fail validation — the version-pin
    // is a required field, so a half-recorded run can't be published silently.
    const script = `
import json, sys
sys.path.insert(0, "model-lab")
from common.manifest_schema import validate_manifest
m = {
    "task": "faithfulness-gate", "schemaVersion": 1, "status": "pending-training",
    "contract": {}, "baseModel": None, "dataRecipe": {}, "hyperparams": None,
    "trainedAt": None, "hardware": None, "eval": None, "artifact": None,
    "policyCompliance": {"targetMaxParamsB": 4},
    # NOTE: no trainingStack
}
errs = validate_manifest(m, allow_pending=True)
print(json.dumps({"errors": errs}))
`;
    const res = spawnSync(pythonBin, ["-c", script], { cwd: repoRoot, encoding: "utf-8" });
    assert.equal(res.status, 0, res.stderr);
    const { errors } = JSON.parse(res.stdout);
    assert.ok(
      errors.some((e) => e.includes("trainingStack")),
      `expected a trainingStack error, got: ${JSON.stringify(errors)}`,
    );
  },
);

test(
  "manifest schema: validator REJECTS pending fields when allow_pending=False (a real run must pin everything)",
  { skip: skipReason },
  () => {
    const full = path.join(repoRoot, "model-lab/faithfulness-gate/manifest.json");
    const { errors } = validateManifest(full, false);
    // The committed scaffold must FAIL strict mode — it's pending by design.
    assert.ok(
      errors.some((e) => e.includes("pending") || e.includes("trainingStack")),
      `strict mode should reject the pending scaffold, got: ${JSON.stringify(errors)}`,
    );
  },
);
