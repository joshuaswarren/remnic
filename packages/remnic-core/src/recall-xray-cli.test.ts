import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseXrayBudgetFlag,
  parseXrayCliOptions,
} from "./recall-xray-cli.js";

// ─── parseXrayBudgetFlag ─────────────────────────────────────────────────

test("parseXrayBudgetFlag returns undefined for missing values", () => {
  assert.equal(parseXrayBudgetFlag(undefined), undefined);
  assert.equal(parseXrayBudgetFlag(null), undefined);
});

test("parseXrayBudgetFlag coerces numeric strings to integers", () => {
  assert.equal(parseXrayBudgetFlag("4096"), 4096);
  assert.equal(parseXrayBudgetFlag(1024), 1024);
});

test("parseXrayBudgetFlag rejects non-numeric values", () => {
  assert.throws(
    () => parseXrayBudgetFlag("abc"),
    /--budget expects a positive integer; got "abc"/,
  );
});

test("parseXrayBudgetFlag rejects zero, negative, and fractional values", () => {
  assert.throws(() => parseXrayBudgetFlag(0), /--budget expects a positive integer/);
  assert.throws(() => parseXrayBudgetFlag(-1), /--budget expects a positive integer/);
  assert.throws(
    () => parseXrayBudgetFlag(10.5),
    /--budget expects a positive integer/,
  );
});

test("parseXrayBudgetFlag rejects non-finite values", () => {
  assert.throws(
    () => parseXrayBudgetFlag("Infinity"),
    /--budget expects a positive integer/,
  );
  assert.throws(
    () => parseXrayBudgetFlag(Number.NaN),
    /--budget expects a positive integer/,
  );
});

// ─── parseXrayCliOptions ─────────────────────────────────────────────────

test("parseXrayCliOptions defaults format to text when absent", () => {
  const parsed = parseXrayCliOptions("hi", {});
  assert.equal(parsed.query, "hi");
  assert.equal(parsed.format, "text");
  assert.equal(parsed.budget, undefined);
  assert.equal(parsed.namespace, undefined);
  assert.equal(parsed.outPath, undefined);
});

test("parseXrayCliOptions threads every valid option through", () => {
  const parsed = parseXrayCliOptions("what editor", {
    format: "markdown",
    budget: "2048",
    namespace: "  workspace-a  ",
    out: "  /tmp/out.md  ",
  });
  assert.equal(parsed.query, "what editor");
  assert.equal(parsed.format, "markdown");
  assert.equal(parsed.budget, 2048);
  assert.equal(parsed.namespace, "workspace-a");
  assert.equal(parsed.outPath, "/tmp/out.md");
});

test("parseXrayCliOptions rejects empty/whitespace/non-string query", () => {
  assert.throws(
    () => parseXrayCliOptions("", {}),
    /xray: <query> is required and must be non-empty/,
  );
  assert.throws(
    () => parseXrayCliOptions("   ", {}),
    /xray: <query> is required and must be non-empty/,
  );
  assert.throws(
    () => parseXrayCliOptions(42 as unknown, {}),
    /xray: <query> is required and must be non-empty/,
  );
});

test("parseXrayCliOptions rejects unknown --format with a listed-options error", () => {
  assert.throws(
    () => parseXrayCliOptions("q", { format: "xml" }),
    /--format expects one of json, text, markdown; got "xml"/,
  );
});

test("parseXrayCliOptions rejects malformed --budget", () => {
  assert.throws(
    () => parseXrayCliOptions("q", { budget: "0" }),
    /--budget expects a positive integer/,
  );
  assert.throws(
    () => parseXrayCliOptions("q", { budget: "not-a-number" }),
    /--budget expects a positive integer/,
  );
});

test("parseXrayCliOptions treats blank --namespace and --out as absent", () => {
  const parsed = parseXrayCliOptions("q", {
    namespace: "   ",
    out: "\t\n",
  });
  assert.equal(parsed.namespace, undefined);
  assert.equal(parsed.outPath, undefined);
});

test("parseXrayCliOptions normalizes format casing via parseXrayFormat", () => {
  const parsed = parseXrayCliOptions("q", { format: "  JSON  " });
  assert.equal(parsed.format, "json");
});
