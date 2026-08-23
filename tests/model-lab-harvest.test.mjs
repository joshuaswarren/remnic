/**
 * Consent-gated shadow-telemetry label harvester tests (issue #2852).
 *
 * Mirrors tests/model-lab-correction-intent-data.test.mjs: shells out to the
 * stdlib-only Python CLI, capability-guarded on `python3`. CI sets
 * REMNIC_REQUIRE_CAPABILITY_TESTS=1 to forbid the skip. All fixtures are
 * SYNTHETIC — no real telemetry, no real sessions, no real memory content.
 *
 * Coverage required by #2852:
 *  - consent refusal (exit 2, nothing written, no output dir)
 *  - both task mappings (faithfulness verdicts → teacher labels; plans →
 *    correction records)
 *  - private-field stripping + malformed-input tolerance (skipped, counted)
 *  - deterministic ordering/dedup + idempotent bytes (same input → same
 *    dataset sha256 AND same manifest)
 *  - bounded record/text limits (truncate + oversize skip)
 *  - harvest blobs stay gitignored; nothing invokes the tool automatically
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
const harvestCli = path.join(repoRoot, "model-lab", "harvest.py");

const pythonBin = process.env.PYTHON_BIN || "python3";
const skipReason = skipUnlessCommand(
  pythonBin,
  "install Python 3.12+ (model-lab harvest is stdlib-only Python)",
);
const gitSkipReason = skipUnlessCommand("git", "install git");

const FAITHFULNESS_KEYS = new Set([
  "factText",
  "quote",
  "context",
  "label",
  "perturbation",
  "sourceId",
]);
const CORRECTION_KEYS = new Set([
  "turns",
  "label",
  "corrections",
  "morphology",
  "sourceId",
]);

function runHarvest(args) {
  return spawnSync(pythonBin, [harvestCli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `remnic-harvest-${name}-`));
}

function writeMemory(dir, rel, frontmatter, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

function memoryWithVerdict(dir, id, verdict, quote, body) {
  const fm = [
    `id: ${id}`,
    "category: fact",
    ...(verdict
      ? [
          `faithfulness: ${JSON.stringify({
            verdict,
            model: "synthetic-teacher-model",
            at: "2026-01-01T00:00:00Z",
          })}`,
        ]
      : []),
    ...(quote
      ? [
          `sources: ${JSON.stringify([
            {
              sessionKey: "sess-PRIVATE-marker",
              observedAt: "2026-01-01T00:00:00Z",
              quote,
              charStart: 0,
              charEnd: quote.length,
            },
          ])}`,
        ]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
  writeMemory(dir, `facts/2026-01-01/${id}.md`, fm, body);
}

function buildFaithfulnessInput() {
  const dir = tmpDir("faith-in");
  memoryWithVerdict(dir, "fact-synthetic-001", "entailed", "synthetic quote alpha", "Synthetic fact alpha.");
  memoryWithVerdict(dir, "fact-synthetic-002", "contradicted", "synthetic quote beta", "Synthetic fact beta.");
  memoryWithVerdict(dir, "fact-synthetic-003", "unsupported", "synthetic quote gamma", "Synthetic fact gamma.");
  memoryWithVerdict(dir, "fact-synthetic-004", "skipped_no_span", "unused quote", "No span fact.");
  memoryWithVerdict(dir, "fact-synthetic-005", "unchecked", "unused quote", "Unchecked fact.");
  memoryWithVerdict(dir, "fact-synthetic-006", "entailed", null, "Entailed but no sources.");
  memoryWithVerdict(dir, "fact-synthetic-007", "entailed", "synthetic quote alpha", "Synthetic fact alpha.");
  writeMemory(
    dir,
    "facts/2026-01-01/fact-synthetic-008.md",
    "id: fact-synthetic-008\nfaithfulness: {not json",
    "Corrupt telemetry block.",
  );
  fs.writeFileSync(path.join(dir, "facts/2026-01-01/fact-synthetic-009.md"), "no frontmatter at all\n", "utf8");
  memoryWithVerdict(dir, "fact-synthetic-010", "entailed", "synthetic quote delta", "x ".repeat(15000));
  return dir;
}

function writePlan(dir, name, plan) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(plan), "utf8");
}

function planBase(overrides = {}) {
  return {
    planId: "corr-synthetic-base",
    request: {
      text: "actually we switched to synthetic-db",
      sessionKey: "sess-PRIVATE-marker",
      principal: "user-PRIVATE-marker",
      namespace: "ns-PRIVATE-marker",
      targetIds: ["mem-PRIVATE-marker"],
    },
    namespace: "ns-PRIVATE-marker",
    classification: "outdated",
    actions: [{ kind: "supersede", memoryId: "mem-PRIVATE-marker" }],
    confidence: 0.9,
    createdAt: "2026-01-01T00:00:00Z",
    status: "applied",
    ...overrides,
  };
}

function buildCorrectionInput() {
  const dir = tmpDir("plans");
  writePlan(dir, "corr-synthetic-001.json", planBase());
  writePlan(
    dir,
    "corr-synthetic-002.json",
    planBase({
      classification: "wrong",
      confidence: 0.85,
      status: "pending",
      request: { text: "that's wrong, the port is not 8080", sessionKey: "sess-PRIVATE-marker" },
    }),
  );
  writePlan(dir, "corr-synthetic-003.json", planBase({ status: "discarded" }));
  writePlan(dir, "corr-synthetic-004.json", planBase({ classification: "never_store" }));
  writePlan(
    dir,
    "corr-synthetic-005.json",
    planBase({ actions: [{ kind: "redaction_rule", pattern: "synthetic" }] }),
  );
  writePlan(
    dir,
    "corr-synthetic-006.json",
    planBase({
      request: {
        text: "[redacted — never-store/redaction correction text withheld from the pending-plan file]",
      },
    }),
  );
  fs.writeFileSync(path.join(dir, "corr-synthetic-007.json"), "not json {", "utf8");
  writePlan(dir, "corr-synthetic-008.json", { nope: true });
  return dir;
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function readManifest(outDir, task) {
  return JSON.parse(fs.readFileSync(path.join(outDir, `harvest-${task}.manifest.json`), "utf8"));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertNoPrivateLeak(outDir) {
  for (const file of fs.readdirSync(outDir)) {
    const text = fs.readFileSync(path.join(outDir, file), "utf8");
    for (const marker of [
      "sess-PRIVATE-marker",
      "user-PRIVATE-marker",
      "ns-PRIVATE-marker",
      "mem-PRIVATE-marker",
      "synthetic-teacher-model",
    ]) {
      assert.ok(!text.includes(marker), `${file} leaked private marker ${marker}`);
    }
  }
}

test(
  "harvest: refuses to run without --consent (exit 2, nothing written)",
  { skip: skipReason },
  () => {
    const input = buildFaithfulnessInput();
    const out = path.join(os.tmpdir(), `remnic-harvest-refusal-${Date.now()}`);
    const res = runHarvest(["--task", "faithfulness-gate", "--input", input, "--out", out]);
    assert.equal(res.status, 2, `expected refusal exit 2, got ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, /--consent/);
    assert.match(res.stderr, /Nothing was read/);
    assert.ok(!fs.existsSync(out), "refusal must not create the output directory");
  },
);

test(
  "harvest: faithfulness-gate maps persisted verdicts to teacher-labeled records",
  { skip: skipReason },
  () => {
    const input = buildFaithfulnessInput();
    const out = tmpDir("out-faith");
    const res = runHarvest([
      "--task", "faithfulness-gate", "--input", input, "--out", out, "--consent",
    ]);
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(path.join(out, "harvest-faithfulness-gate.jsonl"));
    const labels = rows.map((r) => r.label).sort();
    assert.deepEqual(labels, ["contradicted", "entailed", "unsupported"]);
    for (const row of rows) {
      assert.deepEqual(new Set(Object.keys(row)), FAITHFULNESS_KEYS);
      assert.equal(row.perturbation, "harvest-shadow-telemetry");
      assert.equal(row.context, "", "context is transient and never persisted");
      assert.ok(row.factText.length > 0 && row.quote.length > 0);
    }
    const manifest = readManifest(out, "faithfulness-gate");
    assert.equal(manifest.emitted, 3);
    assert.equal(manifest.deduped, 1);
    assert.equal(manifest.skipped.non_teacher_verdict, 2);
    assert.equal(manifest.skipped.no_quote, 1);
    assert.ok(manifest.skipped.malformed >= 2);
    assert.equal(manifest.skipped.oversize, 1);
    assert.equal(manifest.source, "persisted-shadow-telemetry");
    assertNoPrivateLeak(out);
  },
);

test(
  "harvest: correction-intent maps persisted plans to positive correction records",
  { skip: skipReason },
  () => {
    const input = buildCorrectionInput();
    const out = tmpDir("out-corr");
    const res = runHarvest([
      "--task", "correction-intent", "--input", input, "--out", out, "--consent",
    ]);
    assert.equal(res.status, 0, res.stderr);
    const rows = readJsonl(path.join(out, "harvest-correction-intent.jsonl"));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(new Set(Object.keys(row)), CORRECTION_KEYS);
      assert.equal(row.label, "correction");
      assert.deepEqual(
        row.turns.map((t) => t.role),
        ["user"],
      );
      assert.ok(row.turns[0].content.length > 0);
      assert.ok(row.corrections.length >= 1);
      assert.equal(row.morphology, "harvest-shadow-telemetry");
    }
    const manifest = readManifest(out, "correction-intent");
    assert.equal(manifest.labelCounts.correction, 2);
    assert.equal(manifest.labelCounts.none, 0, "harvest emits positives only; negatives stay synthetic");
    assert.equal(manifest.skipped.discarded, 1);
    assert.equal(manifest.skipped.sensitive, 2);
    assert.equal(manifest.skipped.redacted, 1);
    assert.ok(manifest.skipped.malformed >= 2);
    assertNoPrivateLeak(out);
  },
);

test(
  "harvest: deterministic ordering + idempotent bytes (dataset AND manifest)",
  { skip: skipReason },
  () => {
    const input = buildFaithfulnessInput();
    const out1 = tmpDir("det1");
    const out2 = tmpDir("det2");
    const first = runHarvest([
      "--task", "faithfulness-gate", "--input", input, "--out", out1, "--consent", "--quiet",
    ]);
    const second = runHarvest([
      "--task", "faithfulness-gate", "--input", input, "--out", out2, "--consent", "--quiet",
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const dataset1 = fs.readFileSync(path.join(out1, "harvest-faithfulness-gate.jsonl"), "utf8");
    const dataset2 = fs.readFileSync(path.join(out2, "harvest-faithfulness-gate.jsonl"), "utf8");
    assert.equal(dataset1, dataset2, "same input tree must produce byte-identical datasets");
    const manifest1 = fs.readFileSync(path.join(out1, "harvest-faithfulness-gate.manifest.json"), "utf8");
    const manifest2 = fs.readFileSync(path.join(out2, "harvest-faithfulness-gate.manifest.json"), "utf8");
    assert.equal(manifest1, manifest2, "manifest must be clock-free and path-free (idempotent)");
    const sha = (res) => res.stdout.match(/HARVEST_SHA256=([0-9a-f]{64})/)?.[1];
    assert.ok(sha(first));
    assert.equal(sha(first), sha(second));
    const keys = readJsonl(path.join(out1, "harvest-faithfulness-gate.jsonl")).map(canonical);
    assert.deepEqual(keys, [...keys].sort(), "rows must be canonically sorted");
  },
);

test(
  "harvest: bounded — --max-records truncates, oversize text fields are skipped",
  { skip: skipReason },
  () => {
    const input = buildFaithfulnessInput();
    const out = tmpDir("bound");
    const res = runHarvest([
      "--task", "faithfulness-gate", "--input", input, "--out", out,
      "--consent", "--max-records", "2",
    ]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /HARVEST_RECORDS=2/);
    const manifest = readManifest(out, "faithfulness-gate");
    assert.equal(manifest.emitted, 2);
    assert.equal(manifest.truncated, true);
    assert.equal(manifest.limits.maxRecords, 2);
    const full = tmpDir("bound-full");
    const fullRes = runHarvest([
      "--task", "faithfulness-gate", "--input", input, "--out", full, "--consent", "--quiet",
    ]);
    assert.equal(fullRes.status, 0, fullRes.stderr);
    assert.equal(readManifest(full, "faithfulness-gate").skipped.oversize, 1);
    const rows = readJsonl(path.join(full, "harvest-faithfulness-gate.jsonl"));
    for (const row of rows) {
      assert.ok(
        Buffer.byteLength(row.factText, "utf8") <= 20000,
        "no emitted record may exceed the text bound",
      );
    }
  },
);

test(
  "harvest: output blobs stay gitignored under model-lab data dirs",
  { skip: gitSkipReason },
  () => {
    const res = spawnSync(
      "git",
      [
        "check-ignore",
        "model-lab/faithfulness-gate/data/harvest/harvest-faithfulness-gate.jsonl",
        "model-lab/correction-intent/data/harvest/harvest-correction-intent.jsonl",
        "model-lab/faithfulness-gate/data/harvest/dataset.sha256",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(res.status, 0, `harvest outputs must be gitignored:\n${res.stdout}${res.stderr}`);
  },
);

test(
  "harvest: nothing in npm scripts or CI invokes it automatically (#2852)",
  () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
      assert.ok(
        !String(script).includes("harvest"),
        `npm script "${name}" must not invoke the consent-gated harvester`,
      );
    }
    const workflowsDir = path.join(repoRoot, ".github", "workflows");
    for (const file of fs.readdirSync(workflowsDir)) {
      const text = fs.readFileSync(path.join(workflowsDir, file), "utf8");
      assert.ok(!text.includes("harvest.py"), `workflow ${file} must not run harvest.py`);
    }
  },
);
