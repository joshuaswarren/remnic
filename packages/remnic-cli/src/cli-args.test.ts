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

test("parseTaxonomyResolveArgs preserves text order around interleaved flags", () => {
  const args = ["likes", "--json", "coffee", "--category", "preference", "daily"];
  const original = [...args];
  const parsed = parseTaxonomyResolveArgs(args);

  assert.deepEqual(parsed.textParts, ["likes", "coffee", "daily"]);
  assert.deepEqual(parsed.values, { "--category": "preference" });
  assert.deepEqual([...parsed.booleans], ["--json"]);
  assert.deepEqual(args, original);
});

test("parseTaxonomyResolveArgs treats known flags and later separators as literal text after --", () => {
  const parsed = parseTaxonomyResolveArgs([
    "--category", "fact", "--", "--json", "--category", "preference", "--", "--bogus",
  ]);

  assert.deepEqual(parsed.textParts, ["--json", "--category", "preference", "--", "--bogus"]);
  assert.deepEqual(parsed.values, { "--category": "fact" });
  assert.deepEqual([...parsed.booleans], []);
});

test("parseTaxonomyResolveArgs rejects a separator where a category value is required", () => {
  assert.throws(() => parseTaxonomyResolveArgs(["--category", "--", "literal"]), /--category requires a value/);
});

test("parseTaxonomyResolveArgs keeps negative scalar text and values", () => {
  const parsed = parseTaxonomyResolveArgs(["-1", "--category", "-.5", "-2"]);

  assert.deepEqual(parsed.textParts, ["-1", "-2"]);
  assert.deepEqual(parsed.values, { "--category": "-.5" });
});

test("parseTaxonomyResolveArgs honors caller flag sets instead of built-in flags", () => {
  const booleanFlags = new Set(["--verbose"]);
  const valueFlags = new Set(["--label"]);
  const parsed = parseTaxonomyResolveArgs(["--verbose", "--label", "work", "text"], booleanFlags, valueFlags);

  assert.deepEqual(parsed.textParts, ["text"]);
  assert.deepEqual(parsed.values, { "--label": "work" });
  assert.deepEqual([...parsed.booleans], ["--verbose"]);
  assert.throws(() => parseTaxonomyResolveArgs(["--json"], booleanFlags, valueFlags), /Unknown flag: --json/);
  assert.throws(() => parseTaxonomyResolveArgs(["--label"], booleanFlags, valueFlags), /--label requires a value/);
});

test("resolveFlag distinguishes absent flags, missing values, and exact flag names", () => {
  const args = ["--format-extra", "json", "--format"];

  assert.equal(hasFlag(args, "--format"), true);
  assert.equal(resolveFlag(args, "--format"), undefined);
  assert.equal(hasFlag(args, "--missing"), false);
  assert.equal(resolveFlag(args, "--missing"), undefined);
  assert.equal(hasFlag(["--format-extra", "json"], "--format"), false);
  assert.equal(resolveFlag(["--format-extra", "json"], "--format"), undefined);
});
