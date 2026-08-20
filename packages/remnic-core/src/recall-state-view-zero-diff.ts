/**
 * Zero-diff guard for recall state views (issue #1952).
 *
 * The issue promises: current items are unchanged — zero diff for existing
 * users when no historical item qualifies. This module makes that promise
 * checkable. It compares the lines the pipeline would inject WITHOUT state
 * views (baseline) against the lines it would inject WITH them (annotated).
 *
 * Ok reasons are named for what a reader will assume they mean:
 * - `verified`: no historical or transition item is present, so the promise
 *   applies, and the byte-exact comparison ran and held.
 * - `not_applicable`: at least one historical or transition item is present,
 *   so the "when no historical item qualifies" precondition is false and
 *   nothing was compared.
 *
 * Text comparison is byte-exact; a trailing space added by a renderer is a
 * diff. Current-line text mismatches are reported before order mismatches,
 * so `order_changed` means every line matched by memoryId had identical
 * text and only the memoryId sequence moved.
 *
 * Pure: no I/O, inputs are never mutated. Tests drive it through the live
 * recall route (`applyRecallStateViews` then
 * `RecallResultFormatter.formatQmdResultEntries`); wiring the guard into a
 * runtime caller is a later slice.
 */
import type { StateLabel } from "./recall-state-view.js";

export interface StateViewLine {
  memoryId: string;
  /** The line as it would be injected. */
  text: string;
  stateLabel: string;
}

export type ZeroDiffCheck =
  | { ok: true; reason: "verified" | "not_applicable" }
  | { ok: false; error: "current_line_changed"; memoryId: string }
  | { ok: false; error: "order_changed" };

const STATE_LABELS = Object.freeze(
  ["current", "historical", "transition"] as const satisfies readonly StateLabel[],
);

function isStateLabel(value: string): value is StateLabel {
  return (STATE_LABELS as readonly string[]).includes(value);
}

function validateLines(lines: readonly StateViewLine[], name: string): void {
  for (const line of lines) {
    if (line === null || typeof line !== "object") {
      throw new TypeError(`${name} line must be an object`);
    }
    if (typeof line.memoryId !== "string") {
      throw new TypeError(`${name} line memoryId must be a string`);
    }
    if (typeof line.text !== "string") {
      throw new TypeError(`${name} line text must be a string`);
    }
    if (typeof line.stateLabel !== "string" || !isStateLabel(line.stateLabel)) {
      throw new TypeError(
        `unknown state label: ${JSON.stringify(line.stateLabel)} (allowed: ${STATE_LABELS.join(", ")})`,
      );
    }
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.memoryId)) {
      throw new RangeError(`duplicate memoryId in ${name}: ${line.memoryId}`);
    }
    seen.add(line.memoryId);
  }
}

export function checkStateViewZeroDiff(input: {
  baseline: readonly StateViewLine[];
  annotated: readonly StateViewLine[];
}): ZeroDiffCheck {
  if (input === null || typeof input !== "object") {
    throw new TypeError("input must be an object");
  }
  if (!Array.isArray(input.baseline)) {
    throw new TypeError("baseline must be an array");
  }
  if (!Array.isArray(input.annotated)) {
    throw new TypeError("annotated must be an array");
  }
  const baseline = input.baseline;
  const annotated = input.annotated;
  validateLines(baseline, "baseline");
  validateLines(annotated, "annotated");
  for (const line of baseline) {
    if (line.stateLabel !== "current") {
      throw new RangeError(
        `baseline may only contain current lines, got ${JSON.stringify(line.stateLabel)}`,
      );
    }
  }

  const hasHistorical = annotated.some(
    (line) => line.stateLabel === "historical" || line.stateLabel === "transition",
  );
  if (hasHistorical) {
    return { ok: true, reason: "not_applicable" };
  }

  const baselineText = new Map<string, string>();
  for (const line of baseline) {
    baselineText.set(line.memoryId, line.text);
  }
  for (const line of annotated) {
    if (baselineText.has(line.memoryId) && baselineText.get(line.memoryId) !== line.text) {
      return { ok: false, error: "current_line_changed", memoryId: line.memoryId };
    }
  }

  if (baseline.length !== annotated.length) {
    return { ok: false, error: "order_changed" };
  }
  for (let i = 0; i < baseline.length; i++) {
    if (baseline[i].memoryId !== annotated[i].memoryId) {
      return { ok: false, error: "order_changed" };
    }
  }
  return { ok: true, reason: "verified" };
}
