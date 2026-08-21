import assert from "node:assert/strict";
import test from "node:test";

import { hasFlag, parseTaxonomyResolveArgs, resolveFlag, stripResolveFlags } from "./cli-args.js";

test("parseTaxonomyResolveArgs captures boolean and value flags", () => {
  const parsed = parseTaxonomyResolveArgs([
    "--json",
    "--category",
    "preference",
    "likes",
    "coffee",
  ]);

  assert.deepEqual(parsed.textParts, ["likes", "coffee"]);
  assert.equal(parsed.values["--category"], "preference");
  assert.equal(parsed.booleans.has("--json"), true);
});

test("parseTaxonomyResolveArgs rejects unknown flags and missing values", () => {
  assert.throws(() => parseTaxonomyResolveArgs(["--bogus"]), /Unknown flag: --bogus/);
  assert.throws(() => parseTaxonomyResolveArgs(["--category"]), /--category requires a value/);
  assert.throws(() => parseTaxonomyResolveArgs(["--category", "--json"]), /--category requires a value/);
});

test("stripResolveFlags preserves literal text after --", () => {
  assert.deepEqual(
    stripResolveFlags(["--category", "fact", "--", "--literal", "text"]),
    ["--literal", "text"],
  );
});

test("resolveFlag treats a following option token as a missing value", () => {
  const args = ["--memory-dir", "--format", "json"];
  const shortOptionArgs = ["--memory-dir", "-h"];

  assert.equal(hasFlag(args, "--memory-dir"), true);
  assert.equal(resolveFlag(args, "--memory-dir"), undefined);
  assert.equal(resolveFlag(args, "--format"), "json");
  assert.equal(resolveFlag(shortOptionArgs, "--memory-dir"), undefined);
});

test("resolveFlag accepts negative numeric scalar values", () => {
  const args = ["--priority", "-1", "--threshold", "-.5"];

  assert.equal(resolveFlag(args, "--priority"), "-1");
  assert.equal(resolveFlag(args, "--threshold"), "-.5");
});
