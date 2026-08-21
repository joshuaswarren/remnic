/**
 * Tests for the extracted faithfulness + correction-intent config parser
 * (issue #1576 / #1585). Pins the behavior-preserving extraction: defaults
 * are byte-identical to the pre-extraction inline block, validation rejects
 * the same inputs with the same messages, and the new model-lab pointer keys
 * default empty (byte-identical pre-feature path, rule 39).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseFaithfulnessGateConfig, parseCorrectionIntentConfig } from "./faithfulness-config.js";

test("parseFaithfulnessGateConfig: empty input → byte-identical defaults (rule 39)", () => {
  const out = parseFaithfulnessGateConfig({});
  assert.equal(out.extractionFaithfulnessGate, "off");
  assert.equal(out.extractionFaithfulnessModel, "");
  assert.equal(out.extractionFaithfulnessBaseUrl, "");
  assert.equal(out.extractionFaithfulnessContextChars, 400);
  assert.equal(out.extractionFaithfulnessTimeoutMs, 8000);
});

test("parseFaithfulnessGateConfig: null/undefined gate → off (not rejected)", () => {
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessGate: undefined }).extractionFaithfulnessGate, "off");
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessGate: null }).extractionFaithfulnessGate, "off");
});

test("parseFaithfulnessGateConfig: valid gate modes accepted (case-insensitive, trimmed)", () => {
  for (const v of ["off", "shadow", "enforce", "SHADOW", " Enforce "]) {
    const mode = parseFaithfulnessGateConfig({ extractionFaithfulnessGate: v }).extractionFaithfulnessGate;
    assert.ok(mode === "off" || mode === "shadow" || mode === "enforce", `${v} → ${mode}`);
  }
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessGate: "SHADOW" }).extractionFaithfulnessGate, "shadow");
});

test("parseFaithfulnessGateConfig: present-but-invalid gate rejects (Ob4RQ — never silently off)", () => {
  for (const bad of [true, 1, {}, "maybe", "on"]) {
    assert.throws(
      () => parseFaithfulnessGateConfig({ extractionFaithfulnessGate: bad }),
      /extractionFaithfulnessGate must be one of "off" \| "shadow" \| "enforce"/,
    );
  }
});

test("parseFaithfulnessGateConfig: context chars clamp to [1, 4000]; invalid rejects (#1634)", () => {
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessContextChars: 100000 }).extractionFaithfulnessContextChars, 4000);
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessContextChars: "400" }).extractionFaithfulnessContextChars, 400);
  for (const bad of [0, -1, 1.5, true, NaN, "abc"]) {
    assert.throws(
      () => parseFaithfulnessGateConfig({ extractionFaithfulnessContextChars: bad }),
      /extractionFaithfulnessContextChars must be an integer/,
    );
  }
});

test("parseFaithfulnessGateConfig: timeout clamps to [1, 60000]; invalid rejects", () => {
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessTimeoutMs: 999999 }).extractionFaithfulnessTimeoutMs, 60_000);
  for (const bad of [0, -5, 2.5, false, "no"]) {
    assert.throws(
      () => parseFaithfulnessGateConfig({ extractionFaithfulnessTimeoutMs: bad }),
      /extractionFaithfulnessTimeoutMs must be an integer/,
    );
  }
});

test("parseFaithfulnessGateConfig: model-lab pointer keys default empty + accept strings (#1585)", () => {
  // Defaults preserve the existing routing chain exactly.
  assert.equal(parseFaithfulnessGateConfig({}).extractionFaithfulnessBaseUrl, "");
  assert.equal(parseFaithfulnessGateConfig({}).extractionFaithfulnessModel, "");
  // Non-string values are ignored → empty (not rejected; mirrors model key).
  assert.equal(parseFaithfulnessGateConfig({ extractionFaithfulnessBaseUrl: 123 }).extractionFaithfulnessBaseUrl, "");
  // Real pointer values round-trip.
  const out = parseFaithfulnessGateConfig({
    extractionFaithfulnessModel: "remnic-faithfulness-gate-v1",
    extractionFaithfulnessBaseUrl: "http://localhost:11434/v1",
  });
  assert.equal(out.extractionFaithfulnessModel, "remnic-faithfulness-gate-v1");
  assert.equal(out.extractionFaithfulnessBaseUrl, "http://localhost:11434/v1");
});

test("parseCorrectionIntentConfig: empty input → empty pointers (rule-based detector stays default)", () => {
  const out = parseCorrectionIntentConfig({});
  assert.equal(out.correctionIntentModel, "");
  assert.equal(out.correctionIntentBaseUrl, "");
});

test("parseCorrectionIntentConfig: pointers round-trip; non-strings → empty", () => {
  const out = parseCorrectionIntentConfig({
    correctionIntentModel: "remnic-correction-intent-v1",
    correctionIntentBaseUrl: "http://localhost:8000/v1",
  });
  assert.equal(out.correctionIntentModel, "remnic-correction-intent-v1");
  assert.equal(out.correctionIntentBaseUrl, "http://localhost:8000/v1");
  assert.equal(parseCorrectionIntentConfig({ correctionIntentModel: true }).correctionIntentModel, "");
  assert.equal(parseCorrectionIntentConfig({ correctionIntentBaseUrl: 5 }).correctionIntentBaseUrl, "");
});
