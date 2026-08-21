/**
 * Tests for the disclosure auto-escalation policy (issue #677 PR 4/4).
 * Pure helper, exhaustive coverage of the decision tree.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCLOSURE_ESCALATION_MODES,
  DEFAULT_DISCLOSURE_ESCALATION_THRESHOLD,
  decideDisclosureEscalation,
  isDisclosureEscalationMode,
} from "./recall-disclosure-escalation.js";

test("isDisclosureEscalationMode accepts the two valid modes only", () => {
  assert.equal(isDisclosureEscalationMode("manual"), true);
  assert.equal(isDisclosureEscalationMode("auto"), true);
  assert.equal(isDisclosureEscalationMode("AUTO"), false);
  assert.equal(isDisclosureEscalationMode(""), false);
  assert.equal(isDisclosureEscalationMode(undefined), false);
  assert.equal(isDisclosureEscalationMode(42), false);
});

test("DISCLOSURE_ESCALATION_MODES is the single source of truth", () => {
  assert.deepStrictEqual([...DISCLOSURE_ESCALATION_MODES], ["manual", "auto"]);
});

test("manual mode never escalates regardless of confidence", () => {
  const decision = decideDisclosureEscalation({
    mode: "manual",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.0,
  });
  assert.equal(decision.effective, "chunk");
  assert.equal(decision.escalated, false);
  assert.match(decision.reason, /manual/);
});

test("auto + caller-explicit disclosure does not escalate (respects caller)", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: true,
    topKConfidence: 0.0,
  });
  assert.equal(decision.effective, "chunk");
  assert.equal(decision.escalated, false);
  assert.match(decision.reason, /caller-explicit/);
});

test("auto + section/raw original is not auto-promoted", () => {
  for (const original of ["section", "raw"] as const) {
    const decision = decideDisclosureEscalation({
      mode: "auto",
      threshold: 0.5,
      originalDisclosure: original,
      callerProvidedDisclosure: false,
      topKConfidence: 0.0,
    });
    assert.equal(decision.effective, original);
    assert.equal(decision.escalated, false);
    assert.match(decision.reason, /not-eligible/);
  }
});

test("auto + chunk + low confidence escalates to section", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.3,
  });
  assert.equal(decision.effective, "section");
  assert.equal(decision.escalated, true);
  assert.match(decision.reason, /top-k-confidence=0.300<0.5/);
});

test("auto + chunk + high confidence stays at chunk", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.9,
  });
  assert.equal(decision.effective, "chunk");
  assert.equal(decision.escalated, false);
  assert.match(decision.reason, />=0.5/);
});

test("auto + chunk + confidence equal to threshold stays at chunk (strict less-than)", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.5,
  });
  assert.equal(decision.effective, "chunk");
  assert.equal(decision.escalated, false);
});

test("auto + missing topK confidence does not escalate", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: undefined,
  });
  assert.equal(decision.effective, "chunk");
  assert.equal(decision.escalated, false);
  assert.match(decision.reason, /no-top-k-confidence/);
});

test("auto + non-finite topK confidence does not escalate", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const decision = decideDisclosureEscalation({
      mode: "auto",
      threshold: 0.5,
      originalDisclosure: "chunk",
      callerProvidedDisclosure: false,
      topKConfidence: bad,
    });
    assert.equal(decision.effective, "chunk");
    assert.equal(decision.escalated, false);
  }
});

test("auto + invalid threshold falls back to default and still uses confidence signal", () => {
  // threshold out of range → fallback to DEFAULT_DISCLOSURE_ESCALATION_THRESHOLD (0.5).
  // Confidence 0.3 < 0.5 → escalate.
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: -1,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.3,
  });
  assert.equal(decision.effective, "section");
  assert.equal(decision.escalated, true);
  assert.match(
    decision.reason,
    new RegExp(`<${DEFAULT_DISCLOSURE_ESCALATION_THRESHOLD}`),
  );
});

test("auto + threshold above 1 falls back to default", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 999,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0.4,
  });
  assert.equal(decision.effective, "section");
  assert.equal(decision.escalated, true);
});

test("auto + zero confidence (no results) escalates", () => {
  const decision = decideDisclosureEscalation({
    mode: "auto",
    threshold: 0.5,
    originalDisclosure: "chunk",
    callerProvidedDisclosure: false,
    topKConfidence: 0,
  });
  assert.equal(decision.effective, "section");
  assert.equal(decision.escalated, true);
});

test("decision.reason is always a non-empty string", () => {
  // Guard against accidentally returning an empty reason — operator
  // telemetry depends on it.
  const branches = [
    { mode: "manual" as const, callerProvidedDisclosure: false, topKConfidence: 0.3 },
    { mode: "auto" as const, callerProvidedDisclosure: true, topKConfidence: 0.3 },
    { mode: "auto" as const, callerProvidedDisclosure: false, topKConfidence: undefined },
    { mode: "auto" as const, callerProvidedDisclosure: false, topKConfidence: 0.3 },
    { mode: "auto" as const, callerProvidedDisclosure: false, topKConfidence: 0.9 },
  ];
  for (const branch of branches) {
    const decision = decideDisclosureEscalation({
      threshold: 0.5,
      originalDisclosure: "chunk",
      ...branch,
    });
    assert.equal(typeof decision.reason, "string");
    assert.ok(decision.reason.length > 0, `empty reason for branch ${JSON.stringify(branch)}`);
  }
});
