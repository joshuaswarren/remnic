/**
 * Tests for Finding 1 (PR #424): boolean --json flag must not eat the next
 * text argument in the `taxonomy resolve` flag-stripping loop.
 *
 * Also tests the generic coerceBool helper (Finding 3).
 *
 * Exercises the REAL stripResolveFlags implementation from cli-args.ts
 * (not a local copy) so regressions in the CLI are caught by these tests.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceBool, coerceInstallExtension } from "../packages/remnic-core/src/connectors/coerce.js";
import {
  parseTaxonomyResolveArgs,
  stripResolveFlags,
  TAXONOMY_RESOLVE_BOOLEAN_FLAGS,
} from "../packages/remnic-cli/src/cli-args.js";

describe("taxonomy resolve flag stripping", () => {
  it("--json does not eat the following text argument", () => {
    const args = ["--json", "hello", "world"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["hello", "world"]);
  });

  it("--category (key-value) correctly skips the value", () => {
    const args = ["--category", "preference", "my", "text"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["my", "text"]);
  });

  it("--json before --category works correctly", () => {
    const args = ["--json", "--category", "fact", "some", "input"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["some", "input"]);
  });

  it("--category before --json works correctly", () => {
    const args = ["--category", "fact", "--json", "some", "input"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["some", "input"]);
  });

  it("--json at the end does not cause out-of-bounds", () => {
    const args = ["hello", "--json"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["hello"]);
  });

  it("no flags returns all tokens", () => {
    const args = ["hello", "world"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, ["hello", "world"]);
  });

  it("only --json returns empty", () => {
    const args = ["--json"];
    const result = stripResolveFlags(args, TAXONOMY_RESOLVE_BOOLEAN_FLAGS);
    assert.deepStrictEqual(result, []);
  });

  it("rejects unknown option-looking tokens instead of dropping following text", () => {
    assert.throws(
      () => stripResolveFlags(["remember", "--jsoon", "the", "thing"]),
      /Unknown flag: --jsoon/,
    );
  });

  it("rejects --category with no value", () => {
    assert.throws(
      () => stripResolveFlags(["remember", "--category"]),
      /--category requires a value/,
    );
  });

  it("rejects --category followed by another flag", () => {
    assert.throws(
      () => stripResolveFlags(["remember", "--category", "--json"]),
      /--category requires a value/,
    );
  });

  it("allows literal option-looking text after -- delimiter", () => {
    const result = stripResolveFlags(["--json", "--", "--literal", "text"]);
    assert.deepStrictEqual(result, ["--literal", "text"]);
  });

  it("does not treat --category after -- delimiter as a flag value", () => {
    const result = parseTaxonomyResolveArgs(["--category", "fact", "--", "--category", "literal"]);
    assert.deepStrictEqual(result.textParts, ["--category", "literal"]);
    assert.equal(result.values["--category"], "fact");
  });
});

// ── coerceBool generic helper (Finding 3) ──────────────────────────────────

describe("coerceBool", () => {
  it("passes through boolean true", () => {
    assert.equal(coerceBool(true), true);
  });

  it("passes through boolean false", () => {
    assert.equal(coerceBool(false), false);
  });

  it("coerces string 'true' to true", () => {
    assert.equal(coerceBool("true"), true);
  });

  it("coerces string 'false' to false", () => {
    assert.equal(coerceBool("false"), false);
  });

  it("coerces '1' to true", () => {
    assert.equal(coerceBool("1"), true);
  });

  it("coerces '0' to false", () => {
    assert.equal(coerceBool("0"), false);
  });

  it("coerces 'yes'/'no' correctly", () => {
    assert.equal(coerceBool("yes"), true);
    assert.equal(coerceBool("no"), false);
  });

  it("coerces 'on'/'off' correctly", () => {
    assert.equal(coerceBool("on"), true);
    assert.equal(coerceBool("off"), false);
  });

  it("handles whitespace and case", () => {
    assert.equal(coerceBool("  TRUE  "), true);
    assert.equal(coerceBool("  FALSE  "), false);
    assert.equal(coerceBool("True"), true);
    assert.equal(coerceBool("False"), false);
  });

  it("returns undefined for unrecognized values", () => {
    assert.equal(coerceBool(undefined), undefined);
    assert.equal(coerceBool(null), undefined);
    assert.equal(coerceBool("maybe"), undefined);
    assert.equal(coerceBool(42), undefined);
    assert.equal(coerceBool({}), undefined);
  });
});

// ── coerceInstallExtension backward compat ─────────────────────────────────

describe("coerceInstallExtension delegates to coerceBool", () => {
  it("behaves identically to coerceBool", () => {
    const cases: unknown[] = [true, false, "true", "false", "1", "0", "yes", "no", undefined, null, "maybe", 42];
    for (const input of cases) {
      assert.equal(
        coerceInstallExtension(input),
        coerceBool(input),
        `mismatch for input ${JSON.stringify(input)}`,
      );
    }
  });
});
