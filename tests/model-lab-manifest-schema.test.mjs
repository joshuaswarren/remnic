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
import fs from "node:fs";
import os from "node:os";

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

test(
  "manifest schema: validator REJECTS a 'trained' manifest missing real-run fields (baseModel/hyperparams/trainedAt/hardware) in strict mode (codex P2)",
  { skip: skipReason },
  () => {
    // A half-recorded run: concrete version-pin + eval + artifact, but the
    // reproducibility fields left null. Strict mode must reject it so a
    // half-recorded run cannot ship as complete.
    const scaffold = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "model-lab/faithfulness-gate/manifest.json"),
        "utf8",
      ),
    );
    const half = {
      ...scaffold,
      status: "trained",
      trainingStack: {
        python: "3.12.3",
        libs: { torch: "2.12.1", transformers: "5.3.0" },
        pipFreezeSha256: "abc123",
        capturedAt: "2026-07-06",
      },
      eval: { heldOut: { macroF1: 0.92 }, downstream: null },
      artifact: { hfRepo: "op/model", revision: "abc", quantizations: ["fp16"] },
      // baseModel / hyperparams / trainedAt / hardware intentionally left null.
    };
    const tmp = path.join(os.tmpdir(), `remnic-ci-manifest-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(half));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("baseModel")),
        `strict mode must reject a null baseModel, got: ${JSON.stringify(errors)}`,
      );
      assert.ok(
        errors.some((e) => e.includes("hardware")),
        `strict mode must reject null hardware, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);


/** A fully-valid "trained" correction-intent manifest; mutate one field to seed a violation. */
function makeValidTrainedManifest() {
  return JSON.parse(JSON.stringify({
    task: "correction-intent",
    schemaVersion: 1,
    status: "trained",
    contract: { inputFields: ["turns"], outputShape: "corrections[]", source: "PassiveCorrection" },
    baseModel: { name: "Qwen/Qwen2.5-3B-Instruct" },
    dataRecipe: {
      generatorPath: "model-lab/correction-intent/generate-data.py",
      generatorGitSha: "deadbeef",
      seed: 1337,
      sources: ["synthetic-morphology"],
      counts: { correction: 50, none: 50, total: 100 },
      datasetSha256: "abc123hash",
    },
    trainingStack: {
      python: "3.12.3",
      libs: {
        torch: "2.12.1", transformers: "5.3.0", trl: "0.11.1", peft: "0.10.0",
        datasets: "2.18.0", "huggingface-hub": "0.25.0", accelerate: "1.14.0",
        bitsandbytes: "0.43.1",
      },
      pipFreezeSha256: "freezehash",
      capturedAt: "2026-07-06",
    },
    hyperparams: { lr: 1e-4, epochs: 3 },
    trainedAt: "2026-07-06T00:00:00Z",
    hardware: { gpu: "RTX 3090" },
    eval: { heldOut: { macroF1: 0.91 }, downstream: null },
    artifact: { hfRepo: "op/correction-intent-v1", revision: "abc", quantizations: ["fp16"] },
    policyCompliance: { targetMaxParamsB: 4, actualParamsB: 3, escapeHatchUsed: false },
  }));
}

test(
  "manifest schema: strict mode REJECTS a declared trainingStack lib left null (kilo PRRT_kwDORJXyws6OtyS-)",
  { skip: skipReason },
  () => {
    const m = makeValidTrainedManifest();
    m.trainingStack.libs.trl = null; // declared but unpinned — must not pass strict
    const tmp = path.join(os.tmpdir(), `remnic-ci-libs-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("trainingStack.libs.trl")),
        `strict mode must reject a null trl pin, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);

test(
  "manifest schema: strict mode REJECTS a 'trained' manifest whose dataRecipe lacks provenance (codex P2 PRRT_kwDORJXyws6Otp-E)",
  { skip: skipReason },
  () => {
    const m = makeValidTrainedManifest();
    m.dataRecipe.datasetSha256 = null; // unhashed dataset must not pass strict
    m.dataRecipe.generatorGitSha = null;
    const tmp = path.join(os.tmpdir(), `remnic-ci-datarecipe-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("dataRecipe.datasetSha256")),
        `strict mode must reject a null dataRecipe.datasetSha256, got: ${JSON.stringify(errors)}`,
      );
      assert.ok(
        errors.some((e) => e.includes("dataRecipe.generatorGitSha")),
        `strict mode must reject a null dataRecipe.generatorGitSha, got: ${JSON.stringify(errors)}`,
      );
      // A fully-valid trained manifest must still pass (no false positives).
      const tmp2 = path.join(os.tmpdir(), `remnic-ci-datarecipe-ok-${process.pid}.json`);
      fs.writeFileSync(tmp2, JSON.stringify(makeValidTrainedManifest()));
      const { errors: okErrors } = validateManifest(tmp2, false);
      assert.deepEqual(okErrors, [], `a fully-recorded trained manifest must be valid, got: ${JSON.stringify(okErrors)}`);
      fs.unlinkSync(tmp2);
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);

/** A fully-valid "trained" faithfulness-gate manifest (encoder baseline stack). */
function makeValidTrainedFaithfulnessManifest() {
  return JSON.parse(JSON.stringify({
    task: "faithfulness-gate",
    schemaVersion: 1,
    status: "trained",
    contract: { inputFields: ["factText", "quote", "context"], outputLabels: ["entailed", "contradicted", "unsupported"], source: "FaithfulnessCheckInput" },
    baseModel: { name: "microsoft/deberta-v3-large" },
    dataRecipe: {
      generatorPath: "model-lab/faithfulness-gate/generate-data.py",
      generatorGitSha: "deadbeef",
      seed: 1337,
      sources: ["synthetic-perturbation"],
      counts: { entailed: 40, contradicted: 40, unsupported: 20, total: 100 },
      datasetSha256: "abc123hash",
    },
    trainingStack: {
      python: "3.12.3",
      libs: {
        torch: "2.12.1", transformers: "5.3.0", datasets: "3.6.0",
        "huggingface-hub": "1.3.0", accelerate: "1.14.0", sentencepiece: "0.2.1",
      },
      pipFreezeSha256: "freezehash",
      capturedAt: "2026-07-06",
    },
    hyperparams: { lr: 2e-5, epochs: 3 },
    trainedAt: "2026-07-06T00:00:00Z",
    hardware: { gpu: "RTX 3090" },
    eval: { heldOut: { macroF1: 0.9 }, downstream: null },
    artifact: { hfRepo: "op/faithfulness-gate-v1", revision: "abc", quantizations: ["fp16"] },
    policyCompliance: { targetMaxParamsB: 4, actualParamsB: 0.4, escapeHatchUsed: false },
  }));
}

test(
  "manifest schema: strict mode REJECTS a 'trained' manifest with artifact.revision null (#1700 nit #3)",
  { skip: skipReason },
  () => {
    const m = makeValidTrainedManifest();
    m.artifact.revision = null; // hfRepo stays set; revision missing
    const tmp = path.join(os.tmpdir(), `remnic-ci-revision-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("artifact.revision")),
        `strict mode must reject a null artifact.revision, got: ${JSON.stringify(errors)}`,
      );
      // A fully-valid trained manifest (revision set) must still pass.
      const tmp2 = path.join(os.tmpdir(), `remnic-ci-revision-ok-${process.pid}.json`);
      fs.writeFileSync(tmp2, JSON.stringify(makeValidTrainedManifest()));
      const { errors: okErrors } = validateManifest(tmp2, false);
      assert.deepEqual(okErrors, [], `fully-recorded manifest must be valid, got: ${JSON.stringify(okErrors)}`);
      fs.unlinkSync(tmp2);
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);

test(
  "manifest schema: strict mode REJECTS a 'trained' manifest with a BLANK artifact.revision (codex P2 PRRT_kwDORJXyws6O7cKg)",
  { skip: skipReason },
  () => {
    // A whitespace-only revision is a useless reproducibility pin; the gate
    // used to reject only null/"pending-*" and let "  " through.
    const m = makeValidTrainedManifest();
    m.artifact.revision = "   ";
    const tmp = path.join(os.tmpdir(), `remnic-ci-revision-blank-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("artifact.revision")),
        `strict mode must reject a blank artifact.revision, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);

test(
  "manifest schema: strict mode REJECTS a correction-intent manifest that OMITS a task-required lib (#1700 nit #2)",
  { skip: skipReason },
  () => {
    // Omitting trl entirely (not just null) must fail strict — the per-task
    // minimum matrix requires it for the causal-LM stack.
    const m = makeValidTrainedManifest();
    delete m.trainingStack.libs.trl;
    const tmp = path.join(os.tmpdir(), `remnic-ci-tasklibs-ci-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      assert.ok(
        errors.some((e) => e.includes("trainingStack.libs.trl")),
        `strict mode must reject an omitted trl, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.unlinkSync(tmp);
    }

    // Same for datasets (named explicitly in #1700), peft, and accelerate
    // (Trainer/TRL runtime dep — required for both tasks, codex P2 PRRT_kwDORJXyws6O7kTC).
    for (const lib of ["datasets", "peft", "accelerate"]) {
      const m2 = makeValidTrainedManifest();
      delete m2.trainingStack.libs[lib];
      const t = path.join(os.tmpdir(), `remnic-ci-tasklibs-${lib}-${process.pid}.json`);
      fs.writeFileSync(t, JSON.stringify(m2));
      try {
        const { errors } = validateManifest(t, false);
        assert.ok(
          errors.some((e) => e.includes(`trainingStack.libs.${lib}`)),
          `strict mode must reject an omitted ${lib}, got: ${JSON.stringify(errors)}`,
        );
      } finally {
        fs.unlinkSync(t);
      }
    }
  },
);

test(
  "manifest schema: strict mode REJECTS a faithfulness-gate manifest missing its task-specific libs (#1700 nit #2)",
  { skip: skipReason },
  () => {
    // The encoder baseline needs accelerate + sentencepiece (Trainer/tokenizer
    // runtime deps). Omitting them must fail strict via the per-task matrix.
    for (const lib of ["accelerate", "sentencepiece"]) {
      const m = makeValidTrainedFaithfulnessManifest();
      delete m.trainingStack.libs[lib];
      const t = path.join(os.tmpdir(), `remnic-ci-fg-tasklibs-${lib}-${process.pid}.json`);
      fs.writeFileSync(t, JSON.stringify(m));
      try {
        const { errors } = validateManifest(t, false);
        assert.ok(
          errors.some((e) => e.includes(`trainingStack.libs.${lib}`)),
          `strict mode must reject a faithfulness-gate manifest omitting ${lib}, got: ${JSON.stringify(errors)}`,
        );
      } finally {
        fs.unlinkSync(t);
      }
    }
    // A fully-valid faithfulness-gate trained manifest must still pass.
    const ok = path.join(os.tmpdir(), `remnic-ci-fg-ok-${process.pid}.json`);
    fs.writeFileSync(ok, JSON.stringify(makeValidTrainedFaithfulnessManifest()));
    try {
      const { errors } = validateManifest(ok, false);
      assert.deepEqual(errors, [], `fully-recorded faithfulness-gate manifest must be valid, got: ${JSON.stringify(errors)}`);
    } finally {
      fs.unlinkSync(ok);
    }
  },
);

test(
  "manifest schema: strict mode does not crash on an unhashable task value (#1700 review PRRT_kwDORJXyws6O6gBM)",
  { skip: skipReason },
  () => {
    // A manifest whose 'task' is an array/object must not TypeError out of
    // strict validation (the validator returns human-readable errors). Reuse a
    // valid trained shape but set task to an unhashable array.
    const m = makeValidTrainedManifest();
    m.task = ["not", "a", "string"];
    const tmp = path.join(os.tmpdir(), `remnic-ci-unhashable-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(m));
    try {
      const { errors } = validateManifest(tmp, false);
      // Must return errors (bad task) WITHOUT throwing.
      assert.ok(
        Array.isArray(errors) && errors.length > 0,
        `strict mode must return errors (not crash) for an unhashable task, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      fs.unlinkSync(tmp);
    }
  },
);
